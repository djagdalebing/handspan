/**
 * In-page perception for web surfaces.
 *
 * `collectInFrame` is serialised and evaluated inside each frame of the target
 * page. It has no imports and no closures by design — Playwright ships the
 * function source into the browser.
 *
 * Its job is to turn an arbitrarily bad DOM into the same normalized control
 * list a desktop accessibility API would give us. The hard part on legacy
 * apps is the accessible name: these pages have no `<label for>`, no `aria-*`,
 * and no ids, so the name a human reads is the text in the table cell to the
 * left of the field. Deriving that is what makes semantic targeting possible
 * on markup that offers no stable selectors.
 */

export interface RawNode {
  /** Index into `window.__hs_nodes`, the live element array for this frame. */
  idx: number;
  role: string;
  name: string;
  value?: string;
  disabled?: boolean;
  rect: { x: number; y: number; w: number; h: number };
  path: string;
  group?: string;
  domHint?: string;
  grid?: string[][];
  options?: string[];
  /** Text of the nearest enclosing table row. Enables row-scoped targeting. */
  rowText?: string;
}

export interface FramePerception {
  nodes: RawNode[];
  text: string;
}

export function collectInFrame(): FramePerception {
  const out: RawNode[] = [];
  /**
   * Live element handles, parallel to `out`. Parked on `window` so the driver
   * can obtain a real ElementHandle and dispatch trusted input events, without
   * stamping synthetic attributes into the application's DOM and without
   * anything selector-shaped ever reaching an artifact.
   */
  const els: (Element | null)[] = [];
  const MAX_NODES = 400;

  const emit = (node: Omit<RawNode, 'idx'>, el: Element | null): void => {
    out.push({ ...node, idx: out.length });
    els.push(el);
  };

  const clean = (s: string | null | undefined): string =>
    (s ?? '').replace(/\s+/g, ' ').trim();

  const stripLabel = (s: string): string =>
    clean(s).replace(/[\s:*]+$/, '').trim();

  const visible = (el: Element): boolean => {
    const st = window.getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const rectOf = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };

  const textOf = (el: Element): string =>
    clean((el as HTMLElement).innerText ?? el.textContent ?? '');

  const pathOf = (el: Element): string => {
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur.nodeName !== 'HTML' && parts.length < 12) {
      const parent: Element | null = cur.parentElement;
      if (!parent) break;
      const sibs = Array.from(parent.children).filter((c) => c.nodeName === cur!.nodeName);
      parts.unshift(`${cur.nodeName}[${sibs.indexOf(cur)}]`);
      cur = parent;
    }
    return parts.join('/');
  };

  // --- accessible name -----------------------------------------------------

  /**
   * Text of the cell that visually labels `el`: first the cell to its left in
   * the same row, then the cell directly above it in the previous row. This
   * is the convention every table-laid-out enterprise app follows, and it is
   * the only label information those pages carry.
   */
  const labelFromTable = (el: Element): string => {
    const td = el.closest('td, th');
    if (!td) return '';
    const row = td.parentElement;
    if (!row) return '';
    const cells = Array.from(row.children);
    const idx = cells.indexOf(td);

    for (let i = idx - 1; i >= 0; i--) {
      const t = stripLabel(textOf(cells[i]!));
      if (t && t.length <= 60) return t;
    }
    const prevRow = row.previousElementSibling;
    if (prevRow && prevRow.children.length > idx) {
      const t = stripLabel(textOf(prevRow.children[idx]!));
      if (t && t.length <= 60) return t;
    }
    return '';
  };

  /** Trailing "Some Label:" text immediately before the control. */
  const labelFromPrecedingText = (el: Element): string => {
    let node: Node | null = el.previousSibling;
    let acc = '';
    let hops = 0;
    while (node && hops++ < 6) {
      const t = clean(node.textContent);
      if (t) acc = t + ' ' + acc;
      if (acc.trim().length > 0 && /[:：]\s*$/.test(acc.trim())) break;
      node = node.previousSibling;
    }
    const m = acc.trim().match(/([^.;>]{1,60}?)[:：]\s*$/);
    return m ? stripLabel(m[1]!) : '';
  };

  const humanize = (s: string): string =>
    stripLabel(s.replace(/^p_/, '').replace(/[_-]+/g, ' '));

  const accessibleName = (el: Element): string => {
    const aria = clean(el.getAttribute('aria-label'));
    if (aria) return stripLabel(aria);

    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => clean(document.getElementById(id)?.textContent)).join(' ');
      if (clean(t)) return stripLabel(t);
    }

    const id = el.getAttribute('id');
    if (id) {
      const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (lab && clean(lab.textContent)) return stripLabel(lab.textContent!);
    }
    const wrapping = el.closest('label');
    if (wrapping && clean(wrapping.textContent)) return stripLabel(wrapping.textContent!);

    const tag = el.nodeName;
    const type = (el.getAttribute('type') ?? '').toLowerCase();

    // Buttons and links carry their own name.
    if (tag === 'BUTTON' || tag === 'A') {
      const t = textOf(el);
      if (t) return stripLabel(t);
    }
    if (tag === 'INPUT' && ['submit', 'button', 'reset'].includes(type)) {
      const v = clean(el.getAttribute('value'));
      if (v) return stripLabel(v);
      if (type === 'submit') return 'Submit';
      if (type === 'reset') return 'Reset';
    }
    if (tag === 'INPUT' && type === 'image') {
      const a = clean(el.getAttribute('alt'));
      if (a) return stripLabel(a);
    }

    const title = clean(el.getAttribute('title'));
    if (title) return stripLabel(title);
    const ph = clean(el.getAttribute('placeholder'));
    if (ph) return stripLabel(ph);

    const fromTable = labelFromTable(el);
    if (fromTable) return fromTable;
    const fromText = labelFromPrecedingText(el);
    if (fromText) return fromText;

    const nm = clean(el.getAttribute('name'));
    if (nm) return humanize(nm);
    return '';
  };

  // --- grouping ------------------------------------------------------------

  const looksLikeHeading = (s: string): boolean =>
    s.length > 1 && s.length <= 70 && /^[A-Z0-9]/.test(s) &&
    s === s.toUpperCase() && /[A-Z]{2,}/.test(s);

  /**
   * True when `cell` holds a *value* in a "Label: value" row rather than a
   * heading. Without this test the heuristic below happily mistakes an
   * all-caps data value (a member name, a status code) for a section title —
   * which would bake record-specific data into a supposedly reusable
   * descriptor.
   */
  const isValueCell = (cand: Element): boolean => {
    if (cand.nodeName !== 'TD' && cand.nodeName !== 'TH') return false;
    const row = cand.parentElement;
    if (!row) return false;
    const cells = Array.from(row.children);
    if (cells.indexOf(cand) < 1) return false;
    return /[:：]\s*$/.test(clean(textOf(cells[0]!)));
  };

  /**
   * Nearest enclosing section heading. Prefers a real h1-h6; falls back to a
   * short all-caps line, which is how legacy apps render panel titles.
   * Candidates must sit visually above the element and must not be data cells.
   */
  const groupOf = (el: Element): string | undefined => {
    const top = el.getBoundingClientRect().top;
    let cur: Element | null = el.parentElement;
    let hops = 0;
    while (cur && hops++ < 10) {
      const h = cur.querySelector('h1,h2,h3,h4,h5,h6');
      if (h && clean(h.textContent) && h.getBoundingClientRect().top <= top) {
        return stripLabel(h.textContent!);
      }
      for (const cand of Array.from(cur.querySelectorAll('b,strong,th,td')).slice(0, 12)) {
        if (cand.contains(el) || el.contains(cand) || isValueCell(cand)) continue;
        if (cand.getBoundingClientRect().top > top) continue;
        const t = stripLabel(textOf(cand));
        if (looksLikeHeading(t)) return t;
      }
      cur = cur.parentElement;
    }
    return undefined;
  };

  /**
   * Text of the enclosing row. On table-laid-out apps this is the only way to
   * say "the Select link *for member 12345*" — the links are otherwise
   * indistinguishable from one another.
   */
  const rowTextOf = (el: Element): string | undefined => {
    const row = el.closest('tr');
    if (!row) return undefined;
    const t = clean(textOf(row));
    return t ? t.slice(0, 300) : undefined;
  };

  const hintOf = (el: Element): string => {
    const tag = el.nodeName.toLowerCase();
    const nm = el.getAttribute('name');
    const ty = el.getAttribute('type');
    const href = el.getAttribute('href');
    const bits = [tag];
    if (nm) bits.push(`name=${nm}`);
    if (ty) bits.push(`type=${ty}`);
    if (href) bits.push(`href=${href.split('?')[0]}`);
    return bits.join(' ');
  };

  const roleOf = (el: Element): string | null => {
    const explicit = (el.getAttribute('role') ?? '').toLowerCase();
    if (explicit === 'alert') return 'alert';
    const tag = el.nodeName;
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    if (tag === 'BUTTON') return 'button';
    if (tag === 'A' && el.getAttribute('href')) return 'link';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'INPUT') {
      if (['submit', 'button', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'hidden') return null;
      return 'textbox';
    }
    if (/^H[1-6]$/.test(tag)) return 'heading';
    return null;
  };

  // --- interactive controls ------------------------------------------------

  const controls = Array.from(
    document.querySelectorAll('a[href],button,input,select,textarea,h1,h2,h3,h4,h5,h6,[role=alert]')
  );
  for (const el of controls) {
    if (out.length >= MAX_NODES) break;
    const role = roleOf(el);
    if (!role) continue;
    if (!visible(el)) continue;

    const node: Omit<RawNode, 'idx'> = {
      role,
      name: role === 'heading' || role === 'alert' ? stripLabel(textOf(el)) : accessibleName(el),
      rect: rectOf(el),
      path: pathOf(el),
      domHint: hintOf(el),
    };
    const g = groupOf(el);
    if (g && g !== node.name) node.group = g;
    const rt = rowTextOf(el);
    if (rt && rt !== node.name) node.rowText = rt;

    if (role === 'textbox') {
      // A password field's value is never perceived, so it cannot reach a
      // prompt, a log or an artifact by any route. Whether it is filled is the
      // only thing anything above this layer needs to know.
      const isSecret = (el.getAttribute('type') ?? '').toLowerCase() === 'password';
      const raw = (el as HTMLInputElement).value ?? '';
      node.value = isSecret ? (raw ? '«set»' : '') : raw;
    }
    if (role === 'checkbox' || role === 'radio') node.value = (el as HTMLInputElement).checked ? 'true' : 'false';
    if (role === 'combobox') {
      const sel = el as HTMLSelectElement;
      node.options = Array.from(sel.options).map((o) => clean(o.textContent) || o.value);
      node.value = clean(sel.selectedOptions[0]?.textContent) || sel.value;
    }
    if ((el as HTMLInputElement).disabled) node.disabled = true;
    emit(node, el);
  }

  // --- alert / error banners ----------------------------------------------
  // Legacy apps signal errors with a styled div, not role="alert". Class-name
  // sniffing is a heuristic, but a cheap and high-yield one; the artifact's
  // declared outcome matchers do not depend on it being complete.
  for (const el of Array.from(document.querySelectorAll('[class]'))) {
    if (out.length >= MAX_NODES) break;
    const cls = el.getAttribute('class') ?? '';
    if (!/\b(err|error|warn|wrn|alert|msg|message|notice)\b/i.test(cls)) continue;
    if (!visible(el)) continue;
    if (el.querySelector('[class*=err],[class*=wrn],[class*=alert]')) continue;
    const t = textOf(el);
    if (!t) continue;
    emit({ role: 'alert', name: t.slice(0, 300), rect: rectOf(el), path: pathOf(el), domHint: hintOf(el) }, el);
  }

  // --- readouts and data tables -------------------------------------------

  const cellText = (c: Element) => clean(textOf(c));

  for (const table of Array.from(document.querySelectorAll('table'))) {
    if (out.length >= MAX_NODES) break;
    if (!visible(table)) continue;
    if (table.querySelector('table')) continue; // layout wrapper, not data

    const rows = Array.from(table.rows);
    if (rows.length === 0) continue;

    const grid = rows.map((r) => Array.from(r.cells).map(cellText));
    const labelRows = grid.filter((r) => r.length >= 2 && /[:：]\s*$/.test(r[0] ?? ''));

    // Mostly "Label:" / value rows → emit each as a readout rather than a grid.
    if (labelRows.length >= 1 && labelRows.length >= grid.length / 2) {
      for (const r of grid) {
        if (out.length >= MAX_NODES) break;
        const label = stripLabel(r[0] ?? '');
        const value = clean(r.slice(1).filter(Boolean).join(' '));
        if (!label || !value) continue;
        const rowEl = rows[grid.indexOf(r)];
        if (rowEl?.querySelector('input,select,textarea,button')) continue;
        emit({
          role: 'readout',
          name: label,
          value,
          rect: rowEl ? rectOf(rowEl) : { x: 0, y: 0, w: 0, h: 0 },
          path: rowEl ? pathOf(rowEl) : '',
          group: rowEl ? groupOf(rowEl) : undefined,
        }, rowEl ?? null);
      }
      continue;
    }

    // Otherwise a real grid, if it has shape and no form controls.
    if (grid.length >= 2 && (grid[0]?.length ?? 0) >= 2 && !table.querySelector('input,select,textarea')) {
      emit({
        role: 'table',
        name: groupOf(table) ?? 'table',
        rect: rectOf(table),
        path: pathOf(table),
        grid: grid.slice(0, 60).map((r) => r.slice(0, 12)),
      }, table);
    }
  }

  (window as unknown as { __hs_nodes: (Element | null)[] }).__hs_nodes = els;
  const text = clean((document.body as HTMLElement | null)?.innerText ?? '').slice(0, 6000);
  return { nodes: out, text };
}
