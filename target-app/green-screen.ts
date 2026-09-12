/**
 * MERIDIAN Core — 3270-style green screen.
 *
 * The same member data as the web app, served as an 80x24 character grid over
 * a socket. This exists to prove the surface seam: if the artifact schema, the
 * locator, the condition language and the replay engine are really independent
 * of the web, a capability should be recordable and replayable here with no
 * change to any of them.
 *
 * It is a fair test because nothing structured crosses the wire. There is no
 * DOM, no element ids, no accessibility tree — only characters at positions,
 * which is exactly what a terminal emulator gets. Fields follow the convention
 * every green screen uses: a label, then underscores where input goes. The
 * driver has to recover "the field labelled Member Number" from that alone.
 *
 * Protocol (newline-delimited, both directions):
 *   → FIELD <row> <col>   put the cursor in the field at that position
 *   → TYPE <text>         type into the field under the cursor
 *   → KEY <ENTER|PF3|PF7|TAB>
 *   → RESET               return to the sign-on screen
 *   ← 24 lines of screen, then a line containing only --END--
 */
import { createServer, type Socket } from 'node:net';
import { MEMBERS, SPECIAL } from './data.js';

const COLS = 80;
const ROWS = 24;
const END = '--END--';

type ScreenName = 'SIGNON' | 'INQUIRY' | 'DETAIL' | 'ERROR';

interface Session {
  screen: ScreenName;
  fields: Map<string, string>;
  cursor: { row: number; col: number } | null;
  message: string;
  memberId: string;
  authed: boolean;
}

const pad = (s: string, n: number) => (s + ' '.repeat(n)).slice(0, n);
const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/** A field is rendered as underscores, the way a real green screen marks input. */
function field(value: string, width: number): string {
  return pad(value, width).replace(/ /g, '_').slice(0, width);
}

function render(s: Session): string[] {
  const lines: string[] = [];
  const push = (l = '') => lines.push(pad(l, COLS));

  const title =
    s.screen === 'SIGNON' ? 'SIGN ON'
    : s.screen === 'INQUIRY' ? 'MEMBER INQUIRY'
    : s.screen === 'DETAIL' ? `MEMBER DETAIL - ${s.memberId}`
    : 'MEMBER INQUIRY';

  push(' MERIDIAN CORE 7.2.1' + ' '.repeat(38) + pad(title, 26));
  push(' ' + '-'.repeat(COLS - 2));
  push();

  if (s.screen === 'SIGNON') {
    push('   Operator ID:   ' + field(s.fields.get('operator id') ?? '', 12));
    push('   Password:      ' + field((s.fields.get('password') ?? '').replace(/./g, '*'), 12));
  } else if (s.screen === 'INQUIRY' || s.screen === 'ERROR') {
    push('   Member Number: ' + field(s.fields.get('member number') ?? '', 9));
  } else {
    const m = MEMBERS[s.memberId]!;
    push('   Member Number: ' + m.id);
    push('   Member Name:   ' + m.name);
    push('   Status:        ' + m.status);
    push('   Home Branch:   ' + m.branch);
    push('   SSN (last 4):  ***-**-' + m.ssnLast4);
    push();
    push('   ' + pad('ACCOUNT TYPE', 20) + pad('ACCOUNT NO', 14) + pad('CURRENT BALANCE', 18));
    for (const a of m.accounts) {
      push('   ' + pad(a.kind, 20) + pad(a.number, 14) + pad(money(a.balance), 18));
    }
  }

  push();
  if (s.message) push('   ' + s.message);
  while (lines.length < ROWS - 1) push();
  push(
    s.screen === 'DETAIL'
      ? ' PF3=Return  PF7=Open Sub-Account'
      : s.screen === 'SIGNON'
        ? ' PF3=Exit  ENTER=Sign On'
        : ' PF3=Exit  ENTER=Search'
  );
  return lines.slice(0, ROWS);
}

/** Which field the cursor is in, by matching the rendered row. */
function fieldAt(s: Session, row: number): string | null {
  const line = render(s)[row];
  if (!line) return null;
  const m = line.match(/^\s{2,}([A-Za-z][A-Za-z0-9 ()]*?):\s+_/);
  return m ? m[1]!.trim().toLowerCase() : null;
}

function submit(s: Session): void {
  s.message = '';
  if (s.screen === 'SIGNON') {
    const id = s.fields.get('operator id') ?? '';
    const pw = s.fields.get('password') ?? '';
    if (id === 'demo' && pw === 'demo') {
      s.authed = true;
      s.screen = 'INQUIRY';
      s.fields.clear();
    } else {
      s.message = 'MCS-0001 - Invalid operator ID or password.';
    }
    return;
  }
  if (s.screen === 'INQUIRY' || s.screen === 'ERROR') {
    const id = (s.fields.get('member number') ?? '').trim();
    if (!/^\d+$/.test(id)) {
      s.screen = 'ERROR';
      s.message = 'MCS-0012 - Member number must be numeric.';
    } else if (id === SPECIAL.RESTRICTED) {
      s.screen = 'ERROR';
      s.message = 'MCS-0403 - You are not authorized to view this member record.';
    } else if (!MEMBERS[id] || id === SPECIAL.NOT_FOUND) {
      s.screen = 'ERROR';
      s.message = 'MCS-0404 - No member record found for the number entered.';
    } else {
      s.memberId = id;
      s.screen = 'DETAIL';
    }
  }
}

function handle(s: Session, line: string): void {
  const [verb, ...rest] = line.trim().split(/\s+/);
  const arg = rest.join(' ');
  switch ((verb ?? '').toUpperCase()) {
    case 'RESET':
      s.screen = 'SIGNON'; s.fields.clear(); s.cursor = null;
      s.message = ''; s.authed = false; s.memberId = '';
      break;
    case 'FIELD': {
      const row = Number(rest[0]); const col = Number(rest[1]);
      if (Number.isFinite(row) && Number.isFinite(col)) s.cursor = { row, col };
      break;
    }
    case 'TYPE': {
      if (!s.cursor) break;
      const name = fieldAt(s, s.cursor.row);
      if (name) s.fields.set(name, arg);
      break;
    }
    case 'KEY': {
      const key = (rest[0] ?? '').toUpperCase();
      if (key === 'ENTER') submit(s);
      else if (key === 'PF3') { s.screen = s.authed ? 'INQUIRY' : 'SIGNON'; s.message = ''; s.fields.clear(); }
      else if (key === 'PF7') s.message = 'MCS-0099 - Sub-account opening is not available on this terminal.';
      break;
    }
  }
}

const PORT = Number(process.env.GREEN_PORT ?? 4331);

const server = createServer((socket: Socket) => {
  const session: Session = {
    screen: 'SIGNON', fields: new Map(), cursor: null,
    message: '', memberId: '', authed: false,
  };
  const send = () => socket.write(render(session).join('\n') + '\n' + END + '\n');

  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let i: number;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (line.trim()) handle(session, line);
      send();
    }
  });
  socket.on('error', () => {});
  send();
});

if (process.argv[1]?.endsWith('green-screen.ts')) {
  server.listen(PORT, '127.0.0.1', () =>
    console.log(`MERIDIAN Core green screen on tn3270://127.0.0.1:${PORT}`)
  );
}
export { server };
