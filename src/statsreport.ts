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
    ${kpi(`${rate}%`, "Response rate", rate < 80)}${kpi(hours(o.avg_hours), "Avg reply time")}${kpi(String(o.open || 0), "Still unanswered", (o.open || 0) > 0)}
    ${kpi(String(o.open_escalations || 0), "Open escalations, all sites", (o.open_escalations || 0) > 0)}</tr></table>`;
  const stores = (s.rooftops || []).slice().sort((a: any, b: any) => (b.all_total || 0) - (a.all_total || 0));
  const order = ["Google", "DealerRater", "Cars.com", "Facebook"];
  const siteLine = (m: Record<string, number> = {}) => Object.keys(m).sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)).map((k) => `${esc(k)} ${m[k]}`).join(", ");
  const rr = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : "\u2013");
  const showVol = stores.some((r: any) => r.sold != null || r.ros != null);
  const tot = stores.reduce((a: any, r: any) => ({ reviews: a.reviews + (r.all_total || 0), sold: a.sold + (r.sold || 0), ros: a.ros + (r.ros || 0),
    withVol: a.withVol + ((r.sold || r.ros) ? (r.all_total || 0) : 0) }), { reviews: 0, sold: 0, ros: 0, withVol: 0 });
  // A compact version of the table styles: By store has 13 columns and has to fit a 720px email
  const thS = `${F}font-size:11px;color:#5b6573;text-align:right;padding:5px 4px;border-bottom:2px solid #d9dee5;line-height:13px;`;
  const tdS = `${F}font-size:12px;text-align:right;padding:5px 4px;border-bottom:1px solid #e6e9ee;`;
  const byStore = stores.length ? `<p style="${F}font-size:15px;font-weight:700;margin:0 0 6px">By store</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;margin:0 0 20px">
    <tr><th style="${thS}text-align:left;padding-left:0">Store</th><th style="${thS}">Reviews</th><th style="${thS}">Rating</th><th style="${thS}">Response<br>rate</th><th style="${thS}">Avg<br>reply</th><th style="${thS}">Un&shy;answered</th><th style="${thS}">Open<br>escal&shy;ations</th><th style="${thS}">Oldest<br>open</th>
      ${showVol ? `<th style="${thS}">Sold</th><th style="${thS}">ROs</th><th style="${thS}">Cus&shy;tomers</th><th style="${thS}">Review<br>rate</th>` : ""}</tr>
    ${stores.map((r: any) => {
      const rate = pct(r.answered || 0, r.total || 0);
      const oldest = r.oldest_open ? Math.round((Date.now() - Date.parse(r.oldest_open)) / 86400_000) : null;
      const cust = (r.sold || 0) + (r.ros || 0);
      return `<tr><td style="${tdS}text-align:left">${esc(String(r.name || r.rooftop_key).replace(/^Lester Glenn /, ""))}</td>
        <td style="${tdS}"><b>${r.all_total || 0}</b>${r.all_total ? `<div style="${F}font-size:10px;line-height:13px;color:#5b6573">${siteLine(r.sites)}</div>` : ""}</td>
        <td style="${tdS}">${r.avg_stars ?? "\u2013"}</td>
        <td style="${tdS}${r.total && rate < 80 ? "color:#b3261e;font-weight:700;" : ""}">${r.total ? rate + "%" : "\u2013"}</td><td style="${tdS}">${hours(r.avg_hours)}</td>
        <td style="${tdS}${r.open ? "font-weight:700;" : ""}">${r.open || 0}</td><td style="${tdS}${r.open_escalations ? "color:#b3261e;font-weight:700;" : ""}">${r.open_escalations || 0}</td>
        <td style="${tdS}${oldest != null && oldest > 3 ? "color:#b3261e;" : ""}">${oldest == null ? "\u2013" : oldest < 1 ? "Today" : oldest + " days"}</td>
        ${showVol ? `<td style="${tdS}">${r.sold ?? "\u2013"}</td><td style="${tdS}">${r.ros ?? "\u2013"}</td><td style="${tdS}">${cust || "\u2013"}</td><td style="${tdS}"><b>${rr(r.all_total || 0, cust)}</b></td>` : ""}</tr>`;
    }).join("")}
    ${stores.length > 1 ? `<tr><td style="${tdS}text-align:left;border-bottom:0"><b>All stores</b></td><td style="${tdS}border-bottom:0"><b>${tot.reviews}</b></td><td colspan="6" style="${tdS}border-bottom:0"></td>
      ${showVol ? `<td style="${tdS}border-bottom:0"><b>${tot.sold || "\u2013"}</b></td><td style="${tdS}border-bottom:0"><b>${tot.ros || "\u2013"}</b></td><td style="${tdS}border-bottom:0"><b>${tot.sold + tot.ros || "\u2013"}</b></td><td style="${tdS}border-bottom:0"><b>${rr(tot.withVol, tot.sold + tot.ros)}</b></td>` : ""}</tr>` : ""}
    </table>` : "";
  const sites = (s.bySite || []) as any[];
  const bySite = sites.length ? `<p style="${F}font-size:15px;font-weight:700;margin:0 0 6px">Reviews by site</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;margin:0 0 20px">
    <tr><th style="${th}text-align:left">Site</th><th style="${th}">Reviews</th><th style="${th}">Rating</th><th style="${th}">4\u20135 \u2605</th><th style="${th}">3 \u2605</th><th style="${th}">1\u20132 \u2605</th><th style="${th}">Unanswered</th></tr>
    ${sites.map((r) => `<tr><td style="${td}text-align:left">${esc(r.site)}</td><td style="${td}">${r.total}</td><td style="${td}">${r.avg_stars ?? "\u2013"}</td>
      <td style="${td}">${r.positive || 0}</td><td style="${td}">${r.neutral || 0}</td><td style="${td}${r.negative ? "color:#b3261e;font-weight:700;" : ""}">${r.negative || 0}</td><td style="${td}${r.unanswered ? "font-weight:700;" : ""}">${r.unanswered || 0}</td></tr>`).join("")}</table>` : "";
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
      <p style="${F}font-size:13px;color:#5b6573;margin:8px 0 0">The headline numbers cover Google reviews posted in this range. In By store, Reviews counts every site (breakdown underneath), Review rate is reviews divided by customers (sold plus repair orders), and rating, response rate, reply time and unanswered cover Google. Open escalations, which counts every open escalation on any site. Oldest open includes open escalations, timed from when they were first escalated. Reviews by site covers every site. The full statistics page is attached as a PDF.
        Details are in the <a href="${esc(dashboard)}" style="color:${BLUE}">review dashboard</a>.</p>
    </td></tr></table></div>`;
  return { subject, html };
}
