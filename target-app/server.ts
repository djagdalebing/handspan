/**
 * MERIDIAN Core — Member Services (simulated legacy back-office app)
 *
 * A stand-in for the class of application this system exists to automate:
 * server-rendered, frameset shell, table layout, no API, no test IDs.
 *
 * It also exposes a fault-injection endpoint (/__fault) so that the runtime
 * conditions we care about — session expiry, surprise interstitials, slow
 * loads, app errors — can be produced on demand and replayed against
 * deterministically. That is the whole reason this app is local rather than a
 * public demo site: the interesting half of the problem is the unhappy path,
 * and you cannot ask a public sandbox to time your session out on cue.
 */
import express from 'express';
import { MEMBERS, SPECIAL } from './data.js';
import { page, panel, field, esc, money } from './html.js';

export type Fault = 'none' | 'interstitial' | 'session_expiry' | 'slow' | 'app_error';

/**
 * Tenant variants.
 *
 * Two institutions running the same vendor product, configured differently —
 * which is the normal case, not the exception. The differences here are the
 * ones that actually bite: a relabelled field, a renamed button, a renamed
 * column. Same software, same flow, different words on the screen.
 */
const VARIANTS = {
  'meridian-default': {
    brand: 'MERIDIAN CORE',
    inquiryHeading: 'MEMBER INQUIRY',
    memberLabel: 'Member Number:',
    searchButton: 'Search',
    balanceColumn: 'CURRENT BALANCE',
  },
  northgate: {
    brand: 'NORTHGATE CU',
    inquiryHeading: 'MEMBER LOOKUP',
    memberLabel: 'Member No.:',
    searchButton: 'Find',
    balanceColumn: 'BALANCE',
  },
} as const;

const TENANT = (process.env.TENANT ?? 'meridian-default') as keyof typeof VARIANTS;
const V = VARIANTS[TENANT] ?? VARIANTS['meridian-default'];

const app = express();
app.use(express.urlencoded({ extended: false }));

// ---------------------------------------------------------------- state ----
const sessions = new Map<string, { user: string; acked: Set<string> }>();
let fault: Fault = 'none';
let faultArmed = false; // one-shot faults fire once then disarm

function cookie(req: express.Request): string | undefined {
  const raw = req.headers.cookie ?? '';
  return raw.split(';').map((s) => s.trim()).find((s) => s.startsWith('MCSESS='))?.slice(7);
}

/** Guards every protected route; returns null when the caller must re-auth. */
function auth(req: express.Request, res: express.Response): { user: string; acked: Set<string> } | null {
  const sid = cookie(req);
  const sess = sid ? sessions.get(sid) : undefined;
  if (fault === 'session_expiry' && faultArmed) {
    faultArmed = false;
    if (sid) sessions.delete(sid);
    res.send(signon('Your session has timed out due to inactivity. Please sign on again.'));
    return null;
  }
  if (!sess) {
    res.send(signon('Your session has timed out due to inactivity. Please sign on again.'));
    return null;
  }
  return sess;
}

function maybeFail(res: express.Response): boolean {
  if (fault === 'app_error' && faultArmed) {
    faultArmed = false;
    res.status(500).send(page('Error', panel('SYSTEM ERROR',
      `<div class="err"><font face="Verdana" size="1"><b>MCS-0500</b><br>` +
      `An unexpected error occurred while processing your request. ` +
      `Contact the help desk and reference this code.</font></div>`)));
    return true;
  }
  return false;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------- sign-on ----
function signon(message?: string): string {
  return page(`${V.brand} :: Sign On`, `
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" valign="top">
<br><br>
<table width="420" cellpadding="0" cellspacing="0"><tr><td>
${panel(`${V.brand} &mdash; OPERATOR SIGN ON`, `
  ${message ? `<div class="wrn"><font face="Verdana" size="1">${esc(message)}</font></div><br>` : ''}
  <form method="POST" action="/signon">
  <table cellpadding="2" cellspacing="0" border="0">
    ${field('Operator ID:', '<input type="text" name="p_uid" size="18">')}
    ${field('Password:', '<input type="password" name="p_pwd" size="18">')}
    <tr><td></td><td class="c3"><br><input type="submit" value="Sign On" class="c4"></td></tr>
  </table>
  </form>
  <br><font face="Verdana" size="1" color="#404040">Simulated system. Training data only.
  Use operator <b>demo</b> / password <b>demo</b>.</font>
`)}
</td></tr></table>
</td></tr></table>`);
}

app.get('/', (_req, res) => res.send(signon()));

app.post('/signon', (req, res) => {
  const uid = String(req.body.p_uid ?? '');
  const pwd = String(req.body.p_pwd ?? '');
  if (uid !== 'demo' || pwd !== 'demo') {
    return res.send(signon('Invalid operator ID or password.'));
  }
  const sid = Math.random().toString(36).slice(2);
  sessions.set(sid, { user: uid, acked: new Set() });
  res.setHeader('Set-Cookie', `MCSESS=${sid}; Path=/`);
  res.redirect('/desk');
});

// --------------------------------------------------------------- shell ----
// A real frameset. Everything interesting happens inside the "main" frame,
// which means any automation has to reason about frame boundaries.
app.get('/desk', (req, res) => {
  if (!auth(req, res)) return;
  res.send(`<html><head><title>MERIDIAN Core :: Desk</title></head>
<frameset rows="46,*" border="1" frameborder="1">
  <frame src="/chrome/banner" name="banner" scrolling="no" noresize>
  <frameset cols="150,*" border="1">
    <frame src="/chrome/nav" name="nav">
    <frame src="/app/home" name="main">
  </frameset>
</frameset></html>`);
});

app.get('/chrome/banner', (_req, res) => {
  res.send(page('banner', `<table width="100%" height="100%" cellpadding="0" cellspacing="0">
  <tr><td class="c1"><font face="Verdana" size="2"><b>${V.brand}</b></font>
  &nbsp;<font face="Verdana" size="1" color="#c0c0d0">Member Services 7.2.1</font></td>
  <td class="c1" align="right"><font face="Verdana" size="1">OPER: DEMO&nbsp;&nbsp;</font></td></tr></table>`));
});

app.get('/chrome/nav', (_req, res) => {
  res.send(page('nav', `<table width="100%" cellpadding="3" cellspacing="1">
  <tr><td class="c1"><font face="Verdana" size="1"><b>MENU</b></font></td></tr>
  <tr><td class="c2"><font face="Verdana" size="1"><a href="/app/home" target="main">Member Inquiry</a></font></td></tr>
  <tr><td class="c2"><font face="Verdana" size="1"><a href="/app/home" target="main">Account Services</a></font></td></tr>
  <tr><td class="c2"><font face="Verdana" size="1" color="#808080">Teller Ops</font></td></tr>
  <tr><td class="c2"><font face="Verdana" size="1" color="#808080">Reports</font></td></tr>
</table>`));
});

// ------------------------------------------------------------ inquiry ----
app.get('/app/home', (req, res) => {
  if (!auth(req, res)) return;
  res.send(page('Member Inquiry', panel(V.inquiryHeading, `
  <form method="GET" action="/app/search">
  <table cellpadding="2" cellspacing="0" border="0">
    ${field(V.memberLabel, '<input type="text" name="p_mbr_no" size="14" maxlength="9">')}
    <tr><td></td><td class="c3"><br>
      <input type="submit" value="${V.searchButton}" class="c4">&nbsp;
      <input type="reset" value="Clear" class="c4"></td></tr>
  </table>
  </form>
  <br><font face="Verdana" size="1" color="#404040">Enter a member number to retrieve the account record.</font>
`)));
});

app.get('/app/search', async (req, res) => {
  const sess = auth(req, res);
  if (!sess) return;
  if (maybeFail(res)) return;
  const id = String(req.query.p_mbr_no ?? '').trim();

  if (!/^\d+$/.test(id)) {
    return res.send(page('Member Inquiry', panel(V.inquiryHeading, `
      <div class="err"><font face="Verdana" size="1"><b>MCS-0012</b> &mdash;
      Member number must be numeric.</font></div>`)));
  }
  if (id === SPECIAL.RESTRICTED) {
    return res.send(page('Member Inquiry', panel(V.inquiryHeading, `
      <div class="err"><font face="Verdana" size="1"><b>MCS-0403</b> &mdash;
      You are not authorized to view this member record. Contact your supervisor.</font></div>`)));
  }
  if (!MEMBERS[id] || id === SPECIAL.NOT_FOUND) {
    return res.send(page('Member Inquiry', panel(V.inquiryHeading, `
      <div class="err"><font face="Verdana" size="1"><b>MCS-0404</b> &mdash;
      No member record found for the number entered.</font></div>
      <br><font face="Verdana" size="1"><a href="/app/home">Return to inquiry</a></font>`)));
  }

  // Surprise interstitial: a compliance alert the operator must acknowledge.
  const needsAck = (fault === 'interstitial' && faultArmed) || id === SPECIAL.INTERSTITIAL;
  if (needsAck && !sess.acked.has(id)) {
    faultArmed = false;
    return res.send(page('Account Alert', panel('ACCOUNT ALERT &mdash; ACKNOWLEDGEMENT REQUIRED', `
      <div class="wrn"><font face="Verdana" size="1">
      This member record carries a compliance review flag. You must acknowledge
      this notice before the record can be displayed.</font></div><br>
      <form method="POST" action="/app/ack">
        <input type="hidden" name="p_mbr_no" value="${esc(id)}">
        <input type="submit" value="Acknowledge" class="c4">
      </form>`)));
  }
  if (fault === 'slow' && faultArmed) { faultArmed = false; await sleep(6500); }
  res.redirect(`/app/member?p_mbr_no=${encodeURIComponent(id)}`);
});

app.post('/app/ack', (req, res) => {
  const sess = auth(req, res);
  if (!sess) return;
  const id = String(req.body.p_mbr_no ?? '');
  sess.acked.add(id);
  res.redirect(`/app/member?p_mbr_no=${encodeURIComponent(id)}`);
});

app.get('/app/member', (req, res) => {
  if (!auth(req, res)) return;
  if (maybeFail(res)) return;
  const id = String(req.query.p_mbr_no ?? '');
  const m = MEMBERS[id];
  if (!m) return res.redirect('/app/home');
  const rows = m.accounts.map((a) => `<tr>
    <td class="c3"><font face="Verdana" size="1">${esc(a.kind)}</font></td>
    <td class="c3"><font face="Verdana" size="1">${esc(a.number)}</font></td>
    <td class="c3" align="right"><font face="Verdana" size="1">${money(a.balance)}</font></td>
  </tr>`).join('');
  res.send(page('Member Detail', panel(`MEMBER DETAIL &mdash; ${esc(m.id)}`, `
  <table cellpadding="2" cellspacing="0" border="0" width="100%">
    ${field('Member Number:', `<font face="Verdana" size="1"><b>${esc(m.id)}</b></font>`)}
    ${field('Member Name:', `<font face="Verdana" size="1">${esc(m.name)}</font>`)}
    ${field('Status:', `<font face="Verdana" size="1">${esc(m.status)}</font>`)}
    ${field('Home Branch:', `<font face="Verdana" size="1">${esc(m.branch)}</font>`)}
    ${field('SSN (last 4):', `<font face="Verdana" size="1">***-**-${esc(m.ssnLast4)}</font>`)}
  </table>
  <br>
  <table cellpadding="2" cellspacing="1" border="0" width="100%">
    <tr><td class="c1"><font face="Verdana" size="1"><b>ACCOUNT TYPE</b></font></td>
        <td class="c1"><font face="Verdana" size="1"><b>ACCOUNT NO</b></font></td>
        <td class="c1" align="right"><font face="Verdana" size="1"><b>${V.balanceColumn}</b></font></td></tr>
    ${rows}
  </table>
  <br>
  <font face="Verdana" size="1">
    <a href="/app/subacct/new?p_mbr_no=${esc(m.id)}">Open Sub-Account</a> &nbsp;|&nbsp;
    <a href="/app/home">New Inquiry</a>
  </font>
`)));
});

// -------------------------------------------------------- sub-account ----
app.get('/app/subacct/new', (req, res) => {
  if (!auth(req, res)) return;
  const id = String(req.query.p_mbr_no ?? '');
  const m = MEMBERS[id];
  if (!m) return res.redirect('/app/home');
  res.send(subacctForm(m.id, m.name));
});

function subacctForm(id: string, name: string, error?: string, prev: Record<string, string> = {}): string {
  return page('Open Sub-Account', panel(`OPEN SUB-ACCOUNT &mdash; ${esc(id)}`, `
  ${error ? `<div class="err"><font face="Verdana" size="1">${error}</font></div><br>` : ''}
  <form method="POST" action="/app/subacct/create">
  <input type="hidden" name="p_mbr_no" value="${esc(id)}">
  <table cellpadding="2" cellspacing="0" border="0">
    ${field('Member:', `<font face="Verdana" size="1">${esc(id)} &mdash; ${esc(name)}</font>`)}
    ${field('Account Type:', `<select name="p_acct_type">
        <option value="">-- select --</option>
        <option value="SHARE SAVINGS">SHARE SAVINGS</option>
        <option value="VACATION CLUB">VACATION CLUB</option>
        <option value="HOLIDAY CLUB">HOLIDAY CLUB</option>
      </select>`)}
    ${field('Opening Deposit:', `<input type="text" name="p_amount" size="12" value="${esc(prev.p_amount ?? '')}">`)}
    <tr><td></td><td class="c3"><br><input type="submit" value="Continue" class="c4"></td></tr>
  </table>
  </form>`));
}

app.post('/app/subacct/create', (req, res) => {
  if (!auth(req, res)) return;
  const id = String(req.body.p_mbr_no ?? '');
  const type = String(req.body.p_acct_type ?? '');
  const amountRaw = String(req.body.p_amount ?? '').replace(/[$,]/g, '').trim();
  const m = MEMBERS[id];
  if (!m) return res.redirect('/app/home');

  const amount = Number(amountRaw);
  if (!type) {
    return res.send(subacctForm(id, m.name,
      '<b>MCS-0021</b> &mdash; Account type is required.', req.body));
  }
  if (!amountRaw || Number.isNaN(amount)) {
    return res.send(subacctForm(id, m.name,
      '<b>MCS-0022</b> &mdash; Opening deposit must be a valid amount.', req.body));
  }
  if (amount < 25) {
    return res.send(subacctForm(id, m.name,
      '<b>MCS-0023</b> &mdash; Minimum opening deposit is $25.00.', req.body));
  }

  res.send(page('Confirm Sub-Account', panel(`CONFIRM SUB-ACCOUNT &mdash; ${esc(id)}`, `
  <font face="Verdana" size="1">Review the details below. Posting this request
  opens the account immediately and cannot be undone from this screen.</font><br><br>
  <table cellpadding="2" cellspacing="0" border="0">
    ${field('Member:', `<font face="Verdana" size="1">${esc(id)} &mdash; ${esc(m.name)}</font>`)}
    ${field('Account Type:', `<font face="Verdana" size="1"><b>${esc(type)}</b></font>`)}
    ${field('Opening Deposit:', `<font face="Verdana" size="1"><b>${money(amount)}</b></font>`)}
  </table>
  <br>
  <form method="POST" action="/app/subacct/commit">
    <input type="hidden" name="p_mbr_no" value="${esc(id)}">
    <input type="hidden" name="p_acct_type" value="${esc(type)}">
    <input type="hidden" name="p_amount" value="${esc(String(amount))}">
    <input type="submit" value="Post Account" class="c4">
  </form>`)));
});

app.post('/app/subacct/commit', (req, res) => {
  if (!auth(req, res)) return;
  const id = String(req.body.p_mbr_no ?? '');
  const type = String(req.body.p_acct_type ?? '');
  const amount = Number(req.body.p_amount ?? 0);
  const m = MEMBERS[id];
  if (!m) return res.redirect('/app/home');
  const num = `S-${String(1000 + m.accounts.length * 7).slice(0, 4)}`;
  m.accounts.push({ kind: type, number: num, balance: amount });
  const conf = `CNF${Date.now().toString().slice(-8)}`;
  res.send(page('Sub-Account Opened', panel('SUB-ACCOUNT OPENED', `
  <table cellpadding="2" cellspacing="0" border="0">
    ${field('Confirmation Number:', `<font face="Verdana" size="1"><b>${esc(conf)}</b></font>`)}
    ${field('New Account Number:', `<font face="Verdana" size="1"><b>${esc(num)}</b></font>`)}
    ${field('Account Type:', `<font face="Verdana" size="1">${esc(type)}</font>`)}
    ${field('Opening Deposit:', `<font face="Verdana" size="1">${money(amount)}</font>`)}
  </table>
  <br><font face="Verdana" size="1"><a href="/app/home">New Inquiry</a></font>`)));
});

// ----------------------------------------------------- fault injection ----
// Not part of the simulated app's own surface; this is test scaffolding that
// lets us reproduce runtime conditions on demand.
app.post('/__fault', express.json(), (req, res) => {
  fault = (req.body?.fault ?? 'none') as Fault;
  faultArmed = fault !== 'none';
  res.json({ fault, armed: faultArmed });
});
app.get('/__fault', (_req, res) => res.json({ fault, armed: faultArmed }));

const PORT = Number(process.env.PORT ?? 4311);
if (process.argv[1]?.endsWith('server.ts')) {
  app.listen(PORT, () => console.log(`MERIDIAN Core listening on http://127.0.0.1:${PORT}`));
}
export { app };
