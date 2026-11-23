// Statistics email: headline numbers and per-store tables in the body, the full page as a PDF attachment.
const BLUE = "#0772bc";
const F = "font-family:Segoe UI,Arial,sans-serif;";
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const hours = (h: number | null) => (h == null ? "\u2013" : h < 48 ? `${Math.round(h)} hr` : `${(h / 24).toFixed(1)} days`);

export function statsEmail(s: any, scope: string, label: string, note: string, sender: string, dashboard: string): { subject: string; html: string } {
  const o = s.overall || {};
  const subject = `Review report: ${scope} | ${label}`;
  const th = `${F}font-size:12px;color:#5b6573;text-align:right;padding:6px 8px;border-bottom:2px solid #d9dee5;`;
  const td = `${F}font-size:14px;text-align:right;padding:6px 8px;border-bottom:1px solid #e6e9ee;`;
  const kpi = (fig: string, cap: string, red = false) => `<td style="padding:10px 12px;border:1px solid #e6e9ee;vertical-align:top">
    <div style="${F}font-size:22px;font-weight:700;${red ? "color:#b3261e;" : ""}">${fig}</div><div style="${F}font-size:12px;color:#5b6573">${cap}</div></td>`;
  const rate = pct(o.answered || 0, o.total || 0);
  const kpis = `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;margin:0 0 20px"><tr>
    ${kpi(String(o.total || 0), "Google reviews")}${kpi(String(o.avg_stars ?? "\u2013"), "Average rating")}
    ${kpi(`${rate}%`, "Response rate", rate < 80)}${kpi(hours(o.avg_hours), "Avg reply time")}${kpi(String(o.open || 0), "Still unanswered", (o.open || 0) > 0)}</tr></table>`;
  const stores = (s.rooftops || []).slice().sort((a: any, b: any) => b.total - a.total);
  const byStore = stores.length ? `<p style="${F}font-size:15px;font-weight:700;margin:0 0 6px">By store</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;margin:0 0 20px">
    <tr><th style="${th}text-align:left">Store</th><th style="${th}">Reviews</th><th style="${th}">Rating</th><th style="${th}">Response rate</th><th style="${th}">Avg reply</th><th style="${th}">Unanswered</th><th style="${th}">Oldest open</th></tr>
    ${stores.map((r: any) => {
      const rr = pct(r.answered || 0, r.total || 0);
      const oldest = r.oldest_open ? Math.round((Date.now() - Date.parse(r.oldest_open)) / 86400_000) : null;
      return `<tr><td style="${td}text-align:left">${esc(String(r.name || r.rooftop_key).replace(/^Lester Glenn /, ""))}</td><td style="${td}">${r.total}</td><td style="${td}">${r.avg_stars ?? "\u2013"}</td>
        <td style="${td}${rr < 80 ? "color:#b3261e;font-weight:700;" : ""}">${rr}%</td><td style="${td}">${hours(r.avg_hours)}</td>
        <td style="${td}${r.open ? "font-weight:700;" : ""}">${r.open || 0}</td><td style="${td}${oldest != null && oldest > 3 ? "color:#b3261e;" : ""}">${oldest == null ? "\u2013" : oldest < 1 ? "Today" : oldest + " days"}</td></tr>`;
    }).join("")}</table>` : "";
  const sites = (s.bySite || []) as any[];
  const bySite = sites.length ? `<p style="${F}font-size:15px;font-weight:700;margin:0 0 6px">Reviews by site</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;margin:0 0 20px">
    <tr><th style="${th}text-align:left">Site</th><th style="${th}">Reviews</th><th style="${th}">Rating</th><th style="${th}">4\u20135 \u2605</th><th style="${th}">3 \u2605</th><th style="${th}">1\u20132 \u2605</th></tr>
    ${sites.map((r) => `<tr><td style="${td}text-align:left">${esc(r.site)}</td><td style="${td}">${r.total}</td><td style="${td}">${r.avg_stars ?? "\u2013"}</td>
      <td style="${td}">${r.positive || 0}</td><td style="${td}">${r.neutral || 0}</td><td style="${td}${r.negative ? "color:#b3261e;font-weight:700;" : ""}">${r.negative || 0}</td></tr>`).join("")}</table>` : "";
  const e = s.escalations;
  const esc2 = e && e.ready && e.escalated ? `<p style="${F}font-size:15px;font-weight:700;margin:0 0 6px">Escalations</p>
    <p style="${F}font-size:14px;margin:0 0 20px">${e.escalated} escalated, ${e.recovered} recovered (rating raised or review removed), a ${pct(e.recovered, e.escalated)}% recovery rate.
    ${(e.outcomes || []).length ? `Resolved: ${(e.outcomes as any[]).map((x) => `${esc(x.label)} ${x.n}`).join(", ")}.` : ""}</p>` : "";
  const html = `<div style="background:#f3f5f8;padding:20px 0"><table role="presentation" cellpadding="0" cellspacing="0" align="center" style="width:100%;max-width:720px;background:#ffffff;border-radius:8px;overflow:hidden">
    <tr><td style="background:${BLUE};padding:18px 24px"><p style="${F}color:#dbe9f5;font-size:13px;margin:0">${esc(scope)}</p>
      <p style="${F}color:#ffffff;font-size:22px;font-weight:700;margin:2px 0 0">Review report</p>
      <p style="${F}color:#dbe9f5;font-size:14px;margin:4px 0 0">${esc(label)}</p></td></tr>
    <tr><td style="padding:20px 24px">
      ${note ? `<p style="${F}font-size:15px;font-weight:700;margin:0 0 4px">Note from ${esc(sender)}:</p><p style="${F}font-size:15px;line-height:22px;margin:0 0 18px;white-space:pre-wrap">${esc(note)}</p>` : ""}
      ${kpis}${byStore}${bySite}${esc2}
      <p style="${F}font-size:13px;color:#5b6573;margin:8px 0 0">The headline numbers cover Google reviews; Reviews by site covers every site. The full statistics page is attached as a PDF.
        Details are in the <a href="${esc(dashboard)}" style="color:${BLUE}">review dashboard</a>.</p>
    </td></tr></table></div>`;
  return { subject, html };
}
