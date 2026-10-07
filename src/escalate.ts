import type { Env, ReviewRow, User } from "./types";
import { nowIso } from "./types";
import { rooftopByKey } from "./rooftops";
import { checkAddresses, decryptText, encryptText, sendAs } from "./mail";
import { logEvent } from "./agent";

// Escalations email a store team about a review, sent from the escalating
// person's own mailbox. The last escalation's concern, customer details, note
// and recipients are kept with the review (encrypted) so follow-ups start
// pre-filled. Approved by Matt Costanzo per company PII policy.

export type Concern = "sales" | "service" | "both" | "other";
export type Team = "sales" | "service" | "store";

export const CONCERN_LABEL: Record<Concern, string> = {
  sales: "Sales Concern", service: "Service Concern", both: "Sales & Service Concern", other: "Other Concern",
};

const FIELD_LABEL: Record<string, string> = {
  dms: "Client / DMS #", client: "Client name",
  salesperson: "Salesperson", deal: "Deal #", dealDate: "Deal date",
  ro: "RO #", roDate: "RO date", advisor: "Service advisor",
};

export const FIELDS_FOR: Record<Concern, string[]> = {
  sales: ["dms", "client", "salesperson", "deal", "dealDate"],
  service: ["dms", "client", "ro", "roDate", "advisor"],
  both: ["dms", "client"],
  other: ["dms", "client"],
};

/** Which team lists a concern goes to by default. */
export const TEAMS_FOR: Record<Concern, Team[]> = {
  sales: ["sales"], service: ["service"], both: ["sales", "service"], other: ["store"],
};

const MAX_RECIPIENTS = 50;

export async function getTeams(env: Env, rooftop: string): Promise<Record<Team, string[]>> {
  const rows = (await env.DB.prepare("SELECT team, emails FROM team_lists WHERE rooftop_key = ?").bind(rooftop)
    .all<{ team: Team; emails: string }>()).results;
  const out: Record<Team, string[]> = { sales: [], service: [], store: [] };
  for (const r of rows) out[r.team] = r.emails.split(",").filter(Boolean);
  return out;
}

export async function saveTeams(env: Env, rooftop: string, lists: Record<Team, string[]>, by: string) {
  const stmt = env.DB.prepare(`INSERT INTO team_lists (rooftop_key, team, emails, updated_by, updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(rooftop_key, team) DO UPDATE SET emails=excluded.emails, updated_by=excluded.updated_by, updated_at=excluded.updated_at`);
  await env.DB.batch((["sales", "service", "store"] as Team[]).map((t) => stmt.bind(rooftop, t, lists[t].join(","), by, nowIso())));
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function et(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)) + " ET";
}

function plainDate(v: string): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(v + "T12:00:00Z") : null;
  return d ? new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "medium" }).format(d) : v;
}

export interface EscalationInput {
  concern: Concern;
  fields: Record<string, string>;
  note: string;
  recipients: string[];
}

/** Validates the form. Returns cleaned input or an error message. */
export function parseEscalation(env: Env, body: any): { input?: EscalationInput; error?: string } {
  const concern = body?.concern as Concern;
  if (!FIELDS_FOR[concern]) return { error: "Pick what kind of concern this is." };
  const fields: Record<string, string> = {};
  for (const k of FIELDS_FOR[concern]) {
    const v = String(body?.fields?.[k] ?? "").trim().slice(0, 120);
    if (v) fields[k] = v;
  }
  const note = String(body?.note ?? "").trim().slice(0, 4000).replace(/\s*\u2014\s*/g, ", ");
  if (!Object.keys(fields).length && !note) return { error: "Add a note, or the customer details, so the team knows what to do." };
  const { ok, bad } = checkAddresses(env, body?.recipients);
  if (bad.length) return { error: `These addresses can't be used: ${bad.join(", ")}. Only company addresses are allowed.` };
  if (!ok.length) return { error: "Add at least one person to send this to." };
  if (ok.length > MAX_RECIPIENTS) return { error: `That's more than ${MAX_RECIPIENTS} people. Narrow the list.` };
  return { input: { concern, fields, note, recipients: ok } };
}

export function buildEmail(r: ReviewRow, input: EscalationInput, sender: User, origin: string, sentAt: string) {
  const store = rooftopByKey(r.rooftop_key).name;
  const followups = r.escalation_open ?? 0;      // earlier sends since last resolved
  const commNumber = (r.escalation_count ?? 0) + 1;
  const firstAt = r.escalation_first_at || sentAt;
  const who = sender.name ? `${sender.name} (${sender.email})` : sender.email;
  const stars = r.stars ? "\u2605".repeat(r.stars) + "\u2606".repeat(5 - r.stars) : "No rating";
  const subject = `${r.is_sample ? "[TEST, sample review] " : ""}${CONCERN_LABEL[input.concern]}: ${store} | ${r.stars ? r.stars + "-star" : "Unrated"} Google review${followups ? ` | Follow-up #${followups}` : ""}`;

  // Outlook ignores inherited fonts and falls back to Times New Roman, so every element sets its own.
  const F = "font-family:Arial,Helvetica,sans-serif;";
  const T = `${F}font-size:16px;line-height:24px;color:#1f2933;`;
  const STAR = "font-family:'Segoe UI Symbol','Apple Symbols',Arial,sans-serif;";
  const starIcons = (size: number) => r.stars
    ? `<span style="${STAR}font-size:${size}px;line-height:1;letter-spacing:2px;color:#e39b12">${"\u2605".repeat(r.stars)}</span><span style="${STAR}font-size:${size}px;line-height:1;letter-spacing:2px;color:#c9d1d9">${"\u2605".repeat(5 - r.stars)}</span>`
    : "";
  const starText = r.stars ? `${r.stars} out of 5 stars` : "No star rating";

  const row = (label: string, value: string, strong = false) =>
    `<tr><td style="${F}font-size:15px;line-height:22px;padding:6px 16px 6px 0;color:#5b6875;white-space:nowrap;vertical-align:top">${esc(label)}</td><td style="${T}padding:6px 0;${strong ? "font-weight:bold;" : ""}">${value}</td></tr>`;
  const heading = (text: string) => `<p style="${F}font-size:17px;line-height:24px;font-weight:bold;color:#1f2933;margin:0 0 8px">${text}</p>`;

  const customerRows = Object.entries(input.fields)
    .map(([k, v]) => row(FIELD_LABEL[k], esc(k.endsWith("Date") ? plainDate(v) : v), k === "client"))
    .join("");

  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#f3f5f8;${F}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f8"><tr><td align="center" style="padding:24px 12px;${F}">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#ffffff;border:1px solid #dbe1e8">
<tr><td style="background:#0772bc;padding:18px 24px;${F}">
  <div style="${F}font-size:15px;line-height:20px;color:#ffffff">${esc(store)}</div>
  <div style="${F}font-size:22px;line-height:30px;font-weight:bold;color:#ffffff">${esc(CONCERN_LABEL[input.concern])}${followups ? ` (follow-up #${followups})` : ""}</div>
</td></tr>
<tr><td style="padding:20px 24px 4px;${F}">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr>
    <td style="padding:0 12px 0 0;vertical-align:middle">${starIcons(28)}</td>
    <td style="${F}font-size:17px;line-height:24px;font-weight:bold;color:#1f2933;vertical-align:middle">${starText}</td>
  </tr></table>
</td></tr>
<tr><td style="padding:16px 24px 24px;${F}">
  ${customerRows ? `${heading("We believe the customer that left the review is:")}
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 22px">${customerRows}</table>` : ""}
  ${input.note ? `${heading(`Note from ${esc(sender.name || sender.email)}:`)}
  <div style="${T}white-space:pre-wrap;margin:0 0 22px">${esc(input.note)}</div>` : ""}
  ${heading("The review")}
  <div style="${T}background:#f3f5f8;border-left:4px solid #e39b12;padding:12px 16px;margin:0 0 22px;white-space:pre-wrap">${r.text ? esc(r.text) : "<em>Rating only, no written review</em>"}</div>
  <table role="presentation" cellpadding="0" cellspacing="0" style="border-top:1px solid #dbe1e8;width:100%">
    <tr><td colspan="2" style="height:8px;font-size:0;line-height:0">&nbsp;</td></tr>
    ${row("Star rating", r.stars ? `${starIcons(18)} <span style="${T}">(${r.stars} of 5)</span>` : "None")}
    ${row("Review received", esc(et(r.create_time)))}
    ${row("First sent to the team", esc(et(firstAt)) + (followups ? "" : " (this email)"))}
    ${row("Follow-ups without resolution", String(followups), followups > 0)}
    ${row("Communication #", `${commNumber} for this review`)}
    ${row("Sent by", esc(who))}
  </table>
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 8px"><tr><td style="background:#0772bc;border-radius:6px">
    <a href="${esc(origin)}/?review=${encodeURIComponent(r.id)}" style="${F}font-size:16px;line-height:20px;font-weight:bold;color:#ffffff;text-decoration:none;padding:12px 20px;display:inline-block">Open the review</a>
  </td></tr></table>
  <p style="${F}font-size:14px;line-height:20px;color:#5b6875;margin:12px 0 0">Reply to this email to reach ${esc(sender.name || sender.email)}.</p>
</td></tr></table>
<p style="${F}font-size:13px;line-height:18px;color:#5b6875;margin:12px 0 0">Sent from Lester Glenn Reviews</p>
</td></tr></table></body></html>`;
  return { subject, html };
}

export async function sendEscalation(env: Env, r: ReviewRow, input: EscalationInput, user: User, origin: string) {
  const sentAt = nowIso();
  const email = buildEmail(r, input, user, origin, sentAt);
  await sendAs(env, user.email, { to: input.recipients, subject: email.subject, html: email.html });
  const followups = r.escalation_open ?? 0;
  const details = await encryptText(env, JSON.stringify({ concern: input.concern, fields: input.fields, note: input.note, recipients: input.recipients }));
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO escalations (review_id, concern, recipients, included_customer, followup_number, sent_by, sent_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(r.id, input.concern, input.recipients.join(","), Object.keys(input.fields).length ? 1 : 0, followups, user.email, sentAt),
    env.DB.prepare(`UPDATE reviews SET escalation_count = escalation_count + 1, escalation_open = escalation_open + 1,
      escalation_first_at = COALESCE(escalation_first_at, ?), escalation_last_at = ?, escalation_details = ? WHERE id = ?`).bind(sentAt, sentAt, details, r.id),
  ]);
  await logEvent(env, r.id, user.email, "escalated",
    `${CONCERN_LABEL[input.concern]} sent to ${input.recipients.length} ${input.recipients.length === 1 ? "person" : "people"}${followups ? `, follow-up #${followups}` : ""}`);
}

export async function resolveEscalation(env: Env, r: ReviewRow, user: User) {
  await env.DB.prepare("UPDATE reviews SET escalation_open = 0, escalation_resolved_at = ? WHERE id = ?").bind(nowIso(), r.id).run();
  await logEvent(env, r.id, user.email, "escalation_resolved");
}

/** The last escalation's details for pre-filling a follow-up, or null. */
export async function lastEscalation(env: Env, r: ReviewRow): Promise<{ concern: Concern; fields: Record<string, string>; note: string; recipients: string[] } | null> {
  const raw = await decryptText(env, (r as any).escalation_details);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
