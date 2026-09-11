/**
 * Web surface driver.
 *
 * The only file in the system that knows Playwright exists. It implements
 * `Surface` (perceive / act) and `LiveControl` (raw human input for handoff).
 *
 * Two deliberate properties:
 *
 *  1. It walks *every* frame. Framesets are the norm in the apps we target,
 *     and a driver that only sees the top document sees nothing at all.
 *  2. Node bounds are translated into main-frame viewport coordinates. That
 *     keeps a screenshot+coordinate fallback (and the operator console) honest
 *     even though we normally act through element handles.
 */
import { chromium, type Browser, type BrowserContext, type Page, type Frame, type ElementHandle } from 'playwright';
import type { Action, ActionResult, Observation, Surface, UiNode } from '../types.js';
import { collectInFrame, type FramePerception } from './perceive.js';
import { SENSITIVE_LABEL } from '../../safety/redact.js';

/** Raw input against the live session, used only during human handoff. */
export interface LiveControl {
  rawClick(x: number, y: number): Promise<void>;
  rawType(text: string): Promise<void>;
  rawKey(key: string): Promise<void>;
  rawNavigate(url: string): Promise<void>;
}

export interface WebSurfaceOptions {
  headless?: boolean;
  viewport?: { width: number; height: number };
  /** Readout labels whose values are masked before any screenshot is stored. */
  sensitiveLabelPattern?: RegExp;
  actionTimeoutMs?: number;
}

interface RefEntry {
  frame: Frame;
  idx: number;
  node: UiNode;
}

const DEFAULT_SENSITIVE = SENSITIVE_LABEL;

export class WebSurface implements Surface, LiveControl {
  readonly id: string;
  private browser!: Browser;
  private ctx!: BrowserContext;
  private page!: Page;
  private refs = new Map<string, RefEntry>();
  private opts: Required<WebSurfaceOptions>;

  private constructor(id: string, opts: WebSurfaceOptions) {
    this.id = id;
    this.opts = {
      headless: opts.headless ?? true,
      viewport: opts.viewport ?? { width: 1180, height: 820 },
      sensitiveLabelPattern: opts.sensitiveLabelPattern ?? DEFAULT_SENSITIVE,
      actionTimeoutMs: opts.actionTimeoutMs ?? 10_000,
    };
  }

  static async launch(id: string, opts: WebSurfaceOptions = {}): Promise<WebSurface> {
    const s = new WebSurface(id, opts);
    s.browser = await chromium.launch({ headless: s.opts.headless });
    s.ctx = await s.browser.newContext({ viewport: s.opts.viewport });
    s.ctx.setDefaultTimeout(s.opts.actionTimeoutMs);
    // The TS runtime compiles module-scope functions with esbuild's keepNames
    // instrumentation, which emits `__name(...)` calls. Those survive into the
    // source Playwright ships to the page, where the helper does not exist.
    // Defining an identity shim in every frame is cheaper and less fragile
    // than hand-maintaining the perception script as a string literal.
    await s.ctx.addInitScript({ content: 'globalThis.__name ||= (f) => f;' });
    s.page = await s.ctx.newPage();
    return s;
  }

  // ------------------------------------------------------------- perceive --

  async observe(): Promise<Observation> {
    await this.settle();
    this.refs.clear();
    const nodes: UiNode[] = [];
    const texts: string[] = [];

    const frames = this.page.frames();
    for (let fi = 0; fi < frames.length; fi++) {
      const frame = frames[fi]!;
      let perception: FramePerception;
      try {
        perception = await frame.evaluate(collectInFrame);
      } catch {
        continue; // detached or navigating mid-observation; skip this frame
      }
      const offset = await this.frameOffset(frame);
      const framePath = this.framePathOf(frame);

      for (const raw of perception.nodes) {
        const ref = `n${fi}_${raw.idx}`;
        const node: UiNode = {
          ref,
          role: (raw.role as UiNode['role']) ?? 'other',
          name: raw.name,
          value: raw.value,
          disabled: raw.disabled,
          framePath,
          bounds: {
            x: raw.rect.x + offset.x,
            y: raw.rect.y + offset.y,
            w: raw.rect.w,
            h: raw.rect.h,
          },
          path: raw.path,
          group: raw.group,
          domHint: raw.domHint,
          grid: raw.grid,
          options: raw.options,
          rowText: raw.rowText,
        };
        nodes.push(node);
        this.refs.set(ref, { frame, idx: raw.idx, node });
      }
      if (perception.text) texts.push(perception.text);
    }

    return {
      url: this.page.url(),
      title: await this.page.title().catch(() => ''),
      nodes,
      text: texts.join('\n---\n').slice(0, 12_000),
      at: new Date().toISOString(),
    };
  }

  /** Position of a frame's viewport within the main frame's viewport. */
  private async frameOffset(frame: Frame): Promise<{ x: number; y: number }> {
    if (!frame.parentFrame()) return { x: 0, y: 0 };
    try {
      const el = await frame.frameElement();
      const box = await el.boundingBox();
      return box ? { x: box.x, y: box.y } : { x: 0, y: 0 };
    } catch {
      return { x: 0, y: 0 };
    }
  }

  private framePathOf(frame: Frame): string[] {
    const parts: string[] = [];
    let cur: Frame | null = frame;
    while (cur && cur.parentFrame()) {
      parts.unshift(cur.name() || new URL(cur.url()).pathname);
      cur = cur.parentFrame();
    }
    return parts;
  }

  // ----------------------------------------------------------------- act --

  async act(action: Action, resolved: UiNode | null): Promise<ActionResult> {
    try {
      switch (action.kind) {
        case 'navigate':
          await this.page.goto(action.url, { waitUntil: 'domcontentloaded' });
          return { ok: true };
        case 'press':
          await this.page.keyboard.press(action.key);
          await this.settle();
          return { ok: true };
        case 'wait':
          await new Promise((r) => setTimeout(r, action.ms));
          return { ok: true };
      }

      if (!resolved) return { ok: false, error: 'no resolved target supplied' };
      const handle = await this.handleFor(resolved.ref);
      if (!handle) return { ok: false, error: `element for ${resolved.ref} is no longer attached` };

      switch (action.kind) {
        case 'click':
          await handle.scrollIntoViewIfNeeded().catch(() => {});
          await handle.click({ timeout: this.opts.actionTimeoutMs });
          break;
        case 'type':
          await handle.scrollIntoViewIfNeeded().catch(() => {});
          if (action.clearFirst !== false) await handle.fill('');
          await handle.fill(action.text);
          break;
        case 'select': {
          const ok = await handle
            .selectOption({ label: action.option })
            .then(() => true)
            .catch(() => false);
          if (!ok) await handle.selectOption(action.option);
          break;
        }
      }
      await handle.dispose().catch(() => {});
      await this.settle();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Recovers a real ElementHandle from the live array perception parked. */
  private async handleFor(ref: string): Promise<ElementHandle<Element> | null> {
    const entry = this.refs.get(ref);
    if (!entry) return null;
    try {
      const js = await entry.frame.evaluateHandle(
        (i: number) => (window as unknown as { __hs_nodes: (Element | null)[] }).__hs_nodes?.[i] ?? null,
        entry.idx
      );
      const el = js.asElement();
      if (!el) {
        await js.dispose().catch(() => {});
        return null;
      }
      return el as ElementHandle<Element>;
    } catch {
      return null;
    }
  }

  /**
   * Bounded wait for the page to stop moving. Never fails the action.
   *
   * Page-level load waits are not sufficient on a frameset. When a link or
   * form inside the `main` frame navigates, the *top* document never reloads,
   * so `page.waitForLoadState` returns immediately and we observe a frame
   * that is still blank. Every frame has to be checked individually — which
   * is exactly the kind of thing that makes legacy surfaces different from
   * modern single-document apps.
   */
  private async settle(): Promise<void> {
    await this.page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {});

    const deadline = Date.now() + 5_000;
    for (;;) {
      const states = await Promise.all(
        this.page.frames().map((f) =>
          f.evaluate(() => document.readyState).catch(() => 'complete')
        )
      );
      if (states.every((s) => s === 'complete')) break;
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 60));
    }

    await this.page.waitForLoadState('networkidle', { timeout: 1_500 }).catch(() => {});
  }

  // ----------------------------------------------------------- evidence --

  async screenshot(opts: { maskSensitive?: boolean; maskValues?: string[] } = {}): Promise<Buffer> {
    const restore = opts.maskSensitive === false ? null : await this.maskSensitive(opts.maskValues ?? []);
    try {
      return await this.page.screenshot({ fullPage: false });
    } finally {
      if (restore) await restore();
    }
  }

  /**
   * Blacks out values whose label matches the sensitive pattern, for the
   * duration of the screenshot only. Doing this in the page rather than
   * post-processing the PNG means the sensitive pixels are never written to
   * disk at all, which is the property that actually matters.
   */
  private async maskSensitive(values: string[] = []): Promise<(() => Promise<void>) | null> {
    const pattern = this.opts.sensitiveLabelPattern.source;
    const flags = this.opts.sensitiveLabelPattern.flags;
    // Only values already declared PII by the capability are sent into the
    // page, and they came off this page to begin with. Secrets are never sent
    // — password fields are masked structurally instead.
    const literals = values.filter((v) => v.length >= 3);
    const frames = this.page.frames();
    const touched: Frame[] = [];
    for (const frame of frames) {
      try {
        const n = await frame.evaluate(
          ({ src, fl, lits }: { src: string; fl: string; lits: string[] }) => {
            const re = new RegExp(src, fl);
            const marks: HTMLElement[] = [];
            for (const row of Array.from(document.querySelectorAll('tr'))) {
              const cells = Array.from(row.children) as HTMLElement[];
              const label = (cells[0]?.innerText ?? '').trim();
              if (!label || !re.test(label)) continue;
              for (const c of cells.slice(1)) marks.push(c);
            }
            for (const inp of Array.from(document.querySelectorAll('input[type=password]'))) {
              marks.push(inp as HTMLElement);
            }
            // Leaf elements whose own text carries a declared PII value.
            if (lits.length > 0) {
              for (const el of Array.from(document.body.querySelectorAll('*')) as HTMLElement[]) {
                if (el.children.length > 0) continue;
                const t = el.innerText ?? el.textContent ?? '';
                if (!t) continue;
                if (lits.some((v) => t.includes(v))) marks.push(el);
              }
            }
            (window as unknown as { __hs_masked: HTMLElement[] }).__hs_masked = marks;
            for (const m of marks) {
              m.dataset.hsPrev = m.getAttribute('style') ?? '';
              m.style.background = '#000';
              m.style.color = '#000';
            }
            return marks.length;
          },
          { src: pattern, fl: flags, lits: literals }
        );
        if (n > 0) touched.push(frame);
      } catch {
        /* frame gone; nothing to mask */
      }
    }
    if (touched.length === 0) return null;
    return async () => {
      for (const frame of touched) {
        await frame
          .evaluate(() => {
            const marks = (window as unknown as { __hs_masked?: HTMLElement[] }).__hs_masked ?? [];
            for (const m of marks) {
              const prev = m.dataset.hsPrev ?? '';
              if (prev) m.setAttribute('style', prev);
              else m.removeAttribute('style');
              delete m.dataset.hsPrev;
            }
          })
          .catch(() => {});
      }
    };
  }

  async location(): Promise<string> {
    return this.page.url();
  }

  async close(): Promise<void> {
    await this.ctx?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
  }

  // -------------------------------------------------------- LiveControl --

  async rawClick(x: number, y: number): Promise<void> {
    await this.page.mouse.click(x, y);
    await this.settle();
  }
  async rawType(text: string): Promise<void> {
    await this.page.keyboard.type(text, { delay: 12 });
  }
  async rawKey(key: string): Promise<void> {
    await this.page.keyboard.press(key);
    await this.settle();
  }
  async rawNavigate(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
  }
}
