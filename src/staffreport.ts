import type { Env } from "./types";
import { getTeams } from "./escalate";
import { rooftopFor } from "./rooftops";

// Monthly staff review report, emailed to each store's escalation team(s):
// sales -> sales team, service -> service team, anything else -> both.

export type ReportRole = "" | "sales" | "service" | "other";
const ROLE_LABEL: Record<string, string> = { sales: "Sales", service: "Service", other: "Other", "": "Sales and service" };
const SITES = ["Google", "DealerRater", "Cars.com", "Facebook"] as const;
const BLUE = "#0772bc";

export interface Person {
  id: number; full_name: string; role: string; reviews: number; positive: number; neutral: number; negative: number; avg_stars: number | null;
  on_google: number; on_dealerrater: number; on_cars: number; on_facebook: number; on_other: number;
  mentions: { site: string; reviewer: string; stars: number; date: string; tagged: boolean; review_id: string }[];
}

export function teamsForRole(role: ReportRole): ("sales" | "service")[] {
  return role === "sales" ? ["sales"] : role === "service" ? ["service"] : ["sales", "service"];
}

export async function defaultRecipients(env: Env, rooftop: string, role: ReportRole): Promise<string[]> {
  const t = await getTeams(env, rooftop);
  const list = [...new Set(teamsForRole(role).flatMap((k) => t[k] || []))];
  return list.length ? list : t.store || [];
}

export async function storeReport(env: Env, rooftop: string, role: ReportRole, range: [string, string]): Promise<Person[]> {
  const roleSql = role ? " AND s.role = ?" : "";
  const base = `FROM mentions m JOIN reviews r ON r.id = m.review_id JOIN staff s ON s.id = m.staff_id
    WHERE m.rooftop_key = ? AND r.is_sample = 0 AND r.status != 'removed' AND m.review_time >= ? AND m.review_time < ? AND m.match IN ('auto','manual')${roleSql}`;
  const args = [rooftop, range[0], range[1], ...(role ? [role] : [])];
  const people = (await env.DB.prepare(`SELECT s.id, s.full_name, s.role,
      COUNT(DISTINCT m.review_id) AS reviews,
      COUNT(DISTINCT CASE WHEN m.stars >= 4 THEN m.review_id END) AS positive,
      COUNT(DISTINCT CASE WHEN m.stars = 3 THEN m.review_id END) AS neutral,
      COUNT(DISTINCT CASE WHEN m.stars BETWEEN 1 AND 2 THEN m.review_id END) AS negative,
      ROUND(AVG(NULLIF(m.stars, 0)), 2) AS avg_stars,
      COUNT(DISTINCT CASE WHEN r.source IS NULL THEN m.review_id END) AS on_google,
      COUNT(DISTINCT CASE WHEN r.source = 'DealerRater' THEN m.review_id END) AS on_dealerrater,
      COUNT(DISTINCT CASE WHEN r.source = 'Cars.com' THEN m.review_id END) AS on_cars,
      COUNT(DISTINCT CASE WHEN r.source = 'Facebook' THEN m.review_id END) AS on_facebook,
      COUNT(DISTINCT CASE WHEN r.source IS NOT NULL AND r.source NOT IN ('DealerRater', 'Cars.com', 'Facebook') THEN m.review_id END) AS on_other
    ${base} GROUP BY s.id ORDER BY reviews DESC, s.full_name`).bind(...args).all<any>()).results as Person[];
  if (!people.length) return [];
  const rows = (await env.DB.prepare(`SELECT DISTINCT m.staff_id, m.review_id, COALESCE(r.source, 'Google') AS site, r.reviewer_name, m.stars, m.review_time,
      MAX(CASE WHEN m.tagged_by = 'site' THEN 1 ELSE 0 END) AS tagged
    ${base} GROUP BY m.staff_id, m.review_id ORDER BY m.review_time DESC`).bind(...args).all<any>()).results;
  const byPerson = new Map<number, Person>(people.map((p) => [p.id, { ...p, mentions: [] }]));
  for (const r of rows) {
    byPerson.get(r.staff_id)?.mentions.push({ site: r.site, reviewer: r.reviewer_name || "(name not shown)", stars: r.stars || 0,
      date: r.review_time, tagged: !!r.tagged, review_id: r.review_id });
  }
  return [...byPerson.values()];
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" });
const starsTxt = (n: number) => (n ? "\u2605".repeat(n) + "\u2606".repeat(5 - n) : "no rating");
const F = "font-family:Segoe UI,Arial,sans-serif;";

export function reportEmail(store: string, role: ReportRole, label: string, people: Person[], note: string, sender: string, dashboard: string): { subject: string; html: string } {
  const subject = `Staff review report: ${store} | ${ROLE_LABEL[role]} | ${label}`;
  const th = `${F}font-size:12px;color:#5b6573;text-align:right;padding:6px 8px;border-bottom:2px solid #d9dee5;`;
  const td = `${F}font-size:14px;text-align:right;padding:6px 8px;border-bottom:1px solid #e6e9ee;`;
  const summary = `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;margin:0 0 22px">
    <tr><th style="${th}text-align:left">Name</th><th style="${th}">Total</th><th style="${th}">Google</th><th style="${th}">DealerRater</th><th style="${th}">Cars.com</th><th style="${th}">Facebook</th>
      ${people.some((p) => p.on_other) ? `<th style="${th}">Other</th>` : ""}<th style="${th}">4\u20135 \u2605</th><th style="${th}">1\u20132 \u2605</th><th style="${th}">Avg</th></tr>
    ${people.map((p) => `<tr><td style="${td}text-align:left"><b>${esc(p.full_name)}</b></td><td style="${td}"><b>${p.reviews}</b></td>
      <td style="${td}">${p.on_google}</td><td style="${td}">${p.on_dealerrater}</td><td style="${td}">${p.on_cars}</td><td style="${td}">${p.on_facebook}</td>
      ${people.some((x) => x.on_other) ? `<td style="${td}">${p.on_other}</td>` : ""}
      <td style="${td}">${p.positive}</td><td style="${td}${p.negative ? "color:#b3261e;font-weight:700;" : ""}">${p.negative}</td><td style="${td}">${p.avg_stars ?? "\u2013"}</td></tr>`).join("")}
    <tr><td style="${td}text-align:left;border-bottom:0"><b>Total</b></td><td style="${td}border-bottom:0"><b>${people.reduce((a, p) => a + p.reviews, 0)}</b></td>
      <td colspan="8" style="${td}border-bottom:0"></td></tr></table>`;
  const detail = people.map((p) => {
    const sites = [...SITES, ...[...new Set(p.mentions.map((m) => m.site))].filter((s) => !(SITES as readonly string[]).includes(s))];
    const blocks = sites.map((site) => {
      const list = p.mentions.filter((m) => m.site === site);
      if (!list.length) return "";
      return `<p style="${F}font-size:13px;font-weight:700;color:${BLUE};margin:10px 0 4px">${esc(site)} (${list.length})</p>
        <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 4px 0">
        ${list.map((m) => `<tr><td style="${F}font-size:14px;padding:2px 14px 2px 0">${esc(m.reviewer)}${m.tagged ? ` <span style="color:#5b6573;font-size:12px">(tagged)</span>` : ""}</td>
          <td style="${F}font-size:14px;padding:2px 14px 2px 0;color:${m.stars && m.stars <= 2 ? "#b3261e" : "#d08a00"};white-space:nowrap">${starsTxt(m.stars)}</td>
          <td style="${F}font-size:13px;padding:2px 0;color:#5b6573;white-space:nowrap">${day(m.date)}</td></tr>`).join("")}</table>`;
    }).join("");
    return `<div style="border-top:1px solid #d9dee5;padding:12px 0 6px">
      <p style="${F}font-size:16px;margin:0"><b>${esc(p.full_name)}</b> <span style="color:#5b6573;font-size:14px">${p.reviews} review${p.reviews === 1 ? "" : "s"}${p.negative ? `, <span style="color:#b3261e">${p.negative} negative</span>` : ""}</span></p>${blocks}</div>`;
  }).join("");
  const html = `<div style="background:#f3f5f8;padding:20px 0"><table role="presentation" cellpadding="0" cellspacing="0" align="center" style="width:100%;max-width:680px;background:#ffffff;border-radius:8px;overflow:hidden">
    <tr><td style="background:${BLUE};padding:18px 24px"><p style="${F}color:#dbe9f5;font-size:13px;margin:0">${esc(store)}</p>
      <p style="${F}color:#ffffff;font-size:22px;font-weight:700;margin:2px 0 0">Staff review report</p>
      <p style="${F}color:#dbe9f5;font-size:14px;margin:4px 0 0">${esc(ROLE_LABEL[role])}, ${esc(label)}</p></td></tr>
    <tr><td style="padding:20px 24px">
      ${note ? `<p style="${F}font-size:15px;font-weight:700;margin:0 0 4px">Note from ${esc(sender)}:</p><p style="${F}font-size:15px;line-height:22px;margin:0 0 18px;white-space:pre-wrap">${esc(note)}</p>` : ""}
      <p style="${F}font-size:15px;font-weight:700;margin:0 0 8px">Totals</p>${summary}
      <p style="${F}font-size:15px;font-weight:700;margin:0 0 2px">Reviews by person and site</p>
      <p style="${F}font-size:13px;color:#5b6573;margin:0 0 6px">Each reviewer who named or tagged the person, newest first. "(tagged)" means the customer tagged them on DealerRater or Cars.com. Facebook reviews are the ones added to the dashboard by hand.</p>
      ${detail}
      <p style="${F}font-size:13px;color:#5b6573;margin:18px 0 0">Spreadsheets attached: totals, and every review behind them. Full reviews are in the <a href="${esc(dashboard)}" style="color:${BLUE}">review dashboard</a> (Staff tab).</p>
    </td></tr></table></div>`;
  return { subject, html };
}

const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
export function reportCsvs(store: string, people: Person[]): { totals: string; details: string } {
  const totals = [["Name", "Store", "Role", "Total reviews", "Google", "DealerRater", "Cars.com", "Facebook", "Other sites", "4-5 stars", "3 stars", "1-2 stars", "Average stars"].map(cell).join(",")]
    .concat(people.map((p) => [p.full_name, store, ROLE_LABEL[p.role] || p.role, p.reviews, p.on_google, p.on_dealerrater, p.on_cars, p.on_facebook, p.on_other, p.positive, p.neutral, p.negative, p.avg_stars ?? ""].map(cell).join(",")));
  const details = [["Name", "Store", "Role", "Site", "Reviewer", "Stars", "Date", "Tagged on site"].map(cell).join(",")]
    .concat(people.flatMap((p) => p.mentions.map((m) => [p.full_name, store, ROLE_LABEL[p.role] || p.role, m.site, m.reviewer, m.stars || "", day(m.date), m.tagged ? "Yes" : ""].map(cell).join(","))));
  return { totals: "\uFEFF" + totals.join("\r\n"), details: "\uFEFF" + details.join("\r\n") };
}

export const storeName = (key: string) => rooftopFor(key).name;
