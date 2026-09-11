/**
 * Deliberately hostile markup helpers.
 *
 * This mimics a late-90s server-rendered back-office app: frameset shell,
 * table-based layout, <font> tags, opaque class names, form controls with a
 * `name` but no `id`, no `<label for>`, and no test IDs of any kind.
 *
 * The only reliable way to identify a control here is the way a human does it:
 * by its visible role and the label text sitting next to it. That is exactly
 * the constraint the perception layer has to survive.
 */

export function page(title: string, body: string): string {
  return `<html><head><title>${title}</title>
<style>
body{background:#c0c0c0;margin:0;font-family:Verdana,Geneva,sans-serif;font-size:11px}
table{border-collapse:collapse}
.c1{background:#000080;color:#fff;padding:3px 6px}
.c2{background:#d4d0c8;padding:3px 6px;white-space:nowrap}
.c3{background:#fff;padding:3px 6px}
.c4{background:#e8e8e8;padding:2px 6px;border:1px solid #808080}
.err{background:#ffe0e0;border:2px solid #a00;padding:6px}
.wrn{background:#fffbe0;border:2px solid #b8860b;padding:6px}
input,select{font-family:Verdana;font-size:11px;border:1px solid #808080}
a{color:#000080}
</style></head>
<body>${body}</body></html>`;
}

/** A titled panel built from nested layout tables, as the era demanded. */
export function panel(heading: string, inner: string): string {
  return `<table width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td>
  <table width="100%" cellspacing="1" cellpadding="0" border="0"><tr>
    <td class="c1"><font face="Verdana" size="1"><b>${heading}</b></font></td>
  </tr><tr><td class="c2">
    <table cellspacing="0" cellpadding="2" border="0" width="100%"><tr><td>
      ${inner}
    </td></tr></table>
  </td></tr></table>
</td></tr></table>`;
}

/** A form row whose label lives in the adjacent cell, unassociated. */
export function field(label: string, control: string): string {
  return `<tr><td class="c2" align="right"><font face="Verdana" size="1">${label}</font></td>
<td class="c3">${control}</td></tr>`;
}

export function esc(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string
  );
}

export function money(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}
