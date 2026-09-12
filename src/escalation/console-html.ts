/**
 * The operator console.
 *
 * Deliberately minimal — a screenshot that refreshes, click/type forwarding,
 * and three ways to hand control back. A production console would stream
 * frames over WebRTC or CDP rather than polling PNGs, add an audit trail UI
 * and multi-operator assignment. None of that changes the control model,
 * which is the part worth getting right: claim the lease, drive the *same*
 * session, release with an explicit disposition.
 *
 * The three dispositions are distinct on purpose. "Resume" means the human
 * cleared an obstacle and the recorded flow should carry on from where it
 * stopped. "Complete" means the human finished the work themselves, so the
 * engine should verify the checkpoint and extract outputs rather than replay
 * the remaining steps over a screen that has already moved on. "Abort" means
 * stop and tell the caller.
 */
import type { Intervention } from './broker.js';
import type { ControlState } from './control.js';

export function renderConsole(i: Intervention, control: ControlState, token: string): string {
  const esc = (s: unknown) =>
    String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

  const row = (k: string, v: unknown) =>
    v === undefined || v === '' ? '' : `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`;

  return `<html><head><meta charset="utf-8"><title>Intervention ${esc(i.id)}</title>
<style>
 body{font:13px/1.45 system-ui,sans-serif;margin:0;background:#12141a;color:#e6e8ee}
 .wrap{display:grid;grid-template-columns:360px 1fr;gap:18px;padding:18px;align-items:start}
 h1{font-size:16px;margin:0 0 12px}
 table{border-collapse:collapse;width:100%;margin-bottom:14px}
 th{text-align:left;color:#98a0b3;font-weight:500;padding:4px 10px 4px 0;vertical-align:top;width:34%}
 td{padding:4px 0;word-break:break-word}
 .card{background:#1b1f28;border:1px solid #2b313d;border-radius:8px;padding:14px;margin-bottom:14px}
 .reason{display:inline-block;background:#5a3a00;color:#ffcf7a;border-radius:4px;padding:2px 8px;font-weight:600}
 button{font:13px system-ui;padding:7px 12px;border-radius:6px;border:1px solid #39414f;
        background:#262c37;color:#e6e8ee;cursor:pointer;margin:0 6px 6px 0}
 button:hover{background:#303745}
 button.primary{background:#1d4ed8;border-color:#1d4ed8}
 button.danger{background:#7f1d1d;border-color:#7f1d1d}
 input[type=text]{font:13px system-ui;padding:7px;width:100%;box-sizing:border-box;
        background:#0f1116;border:1px solid #39414f;color:#e6e8ee;border-radius:6px;margin-bottom:8px}
 #shot{border:1px solid #2b313d;border-radius:6px;max-width:100%;cursor:crosshair;display:block}
 #state{font-weight:600}
 .hint{color:#98a0b3;font-size:12px}
</style></head><body>
<div class="wrap">
  <div>
    <h1>Intervention <span class="reason">${esc(i.reason)}</span></h1>
    <div class="card">
      <table>
        ${row('Summary', i.summary)}
        ${row('Capability', i.capabilityId)}
        ${row('Goal', i.goal)}
        ${row('Mode', i.mode)}
        ${row('Step', i.stepId)}
        ${row('Expected', i.context.expected)}
        ${row('Observed', i.context.observed)}
        ${row('URL', i.context.url)}
        ${row('Raised', i.raisedAt)}
        ${row('Evidence', [i.context.screenshot, i.context.observationDump].filter(Boolean).join(', '))}
      </table>
      <div>Control: <span id="state">${esc(control)}</span> &middot;
           human actions: <span id="acts">${i.humanActions.length}</span></div>
    </div>

    <div class="card">
      <button class="primary" onclick="claim()">Take control</button>
      <div class="hint">Claim the lease before driving. The automation is already stopped.</div>
    </div>

    <div class="card">
      <input type="text" id="txt" placeholder="text to type into the focused field">
      <button onclick="send({kind:'text',text:document.getElementById('txt').value})">Type</button>
      <button onclick="send({kind:'key',key:'Enter'})">Enter</button>
      <button onclick="send({kind:'key',key:'Tab'})">Tab</button>
      <button onclick="send({kind:'key',key:'Escape'})">Esc</button>
      <div class="hint">Click anywhere on the screenshot to click the live session.</div>
    </div>

    <div class="card">
      <input type="text" id="note" placeholder="what did you do? (recorded)">
      <button class="primary" onclick="resolve('resume')">Resume automation</button>
      <button onclick="resolve('complete')">I finished it</button>
      <button class="danger" onclick="resolve('abort')">Abort run</button>
      <div class="hint">Resume &rarr; continue the recorded flow. I finished it &rarr; verify the
        checkpoint and return outputs. Abort &rarr; stop and report.</div>
    </div>
  </div>

  <div><img id="shot" src="/i/${esc(i.id)}/screenshot?token=${esc(token)}" alt="live session"></div>
</div>
<script>
const ID = ${JSON.stringify(i.id)};
// Every mutating call names the operator; the broker checks that this is who
// holds the lease before it will act.
const OPERATOR = ${JSON.stringify(i.operator ?? 'operator-1')};
const TOKEN = ${JSON.stringify(token)};
const shot = document.getElementById('shot');

function refresh(){ shot.src = '/i/' + ID + '/screenshot?token=' + TOKEN + '&t=' + Date.now(); }
setInterval(refresh, 1200);

async function post(path, body){
  const r = await fetch('/i/' + ID + path, {
    method:'POST', headers:{'content-type':'application/json','x-operator-token':TOKEN},
    body: JSON.stringify({ operator: OPERATOR, ...(body||{}) })
  });
  const j = await r.json().catch(()=>({}));
  if(!r.ok) alert(j.error || ('HTTP ' + r.status));
  return j;
}
async function claim(){ await post('/claim', {}); poll(); }
async function send(body){ await post('/input', body); setTimeout(refresh, 350); poll(); }
async function resolve(disposition){
  await post('/resolve', {disposition, note: document.getElementById('note').value});
  poll();
}
async function poll(){
  const r = await fetch('/i/' + ID + '/state?token=' + TOKEN);
  const j = await r.json();
  document.getElementById('state').textContent = j.control;
  document.getElementById('acts').textContent = j.actions;
}
setInterval(poll, 1500);

// Map a click on the rendered image back to live viewport coordinates.
shot.addEventListener('click', (e) => {
  const rect = shot.getBoundingClientRect();
  const sx = shot.naturalWidth / rect.width;
  const sy = shot.naturalHeight / rect.height;
  send({kind:'click', x:(e.clientX-rect.left)*sx, y:(e.clientY-rect.top)*sy});
});
</script></body></html>`;
}
