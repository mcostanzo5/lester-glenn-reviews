import type { Env } from "./types";
import { nowIso } from "./types";
import { FILES_SCOPE, graphTokenFor } from "./mail";

// Weekly backup of the dashboard database to a SharePoint folder, using the Microsoft
// sign-in of BACKUP_USER. Two files per backup: the full database (JSON, gzipped) and a
// reviews spreadsheet (CSV). Encrypted fields (notes, escalation details) stay encrypted;
// stored Microsoft sign-ins are never included.

const GRAPH = "https://graph.microsoft.com/v1.0";
const TABLES = ["reviews", "events", "escalations", "escalation_outcomes", "rating_changes", "team_lists", "users", "staff",
  "mentions", "review_notes", "review_topics", "draft_edits", "settings", "locations", "runs"]; // never ms_tokens
const CHUNK = 320 * 1024 * 16; // 5 MiB, a multiple of 320 KiB as Microsoft requires
const PREFIX = "lester-glenn-reviews-backup-";

export function backupConfigured(env: Env): boolean {
  return !!(env.BACKUP_SITE && backupUser(env));
}
function backupUser(env: Env): string {
  return (env.BACKUP_USER || (env.ADMIN_EMAILS || "").split(",")[0] || "").trim().toLowerCase();
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function csv(rows: any[], cols: string[]): string {
  const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\r\n");
}

async function graph(token: string, method: string, url: string, body?: unknown) {
  const res = await fetch(url.startsWith("http") ? url : GRAPH + url, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok && res.status !== 204) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`SharePoint said ${res.status}: ${err?.error?.message || "no details"}`);
  }
  return res.status === 204 ? {} : res.json().catch(() => ({}));
}

async function upload(token: string, siteId: string, folder: string, name: string, bytes: Uint8Array) {
  const path = encodeURI(`${folder}/${name}`);
  const session: any = await graph(token, "POST", `/sites/${siteId}/drive/root:/${path}:/createUploadSession`,
    { item: { "@microsoft.graph.conflictBehavior": "replace" } });
  for (let start = 0; start < bytes.length; start += CHUNK) {
    const end = Math.min(start + CHUNK, bytes.length);
    const res = await fetch(session.uploadUrl, {
      method: "PUT",
      headers: { "content-range": `bytes ${start}-${end - 1}/${bytes.length}` },
      body: bytes.slice(start, end),
    });
    if (!res.ok) throw new Error(`Upload of ${name} stopped at ${start} bytes (${res.status}).`);
  }
}

export async function runBackup(env: Env, trigger: string): Promise<{ ok: boolean; message: string; files?: string[]; bytes?: number }> {
  const record = async (r: object) => {
    try {
      await env.DB.prepare(`INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('backup:last', ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
        .bind(JSON.stringify({ ...r, at: nowIso(), trigger }), trigger, nowIso()).run();
    } catch { /* settings table missing */ }
  };
  if (!backupConfigured(env)) return { ok: false, message: "Backups aren't set up. Add BACKUP_SITE in wrangler.toml (see README)." };
  try {
    const token = await graphTokenFor(env, backupUser(env), FILES_SCOPE);
    const [host, ...rest] = env.BACKUP_SITE!.replace(/^https?:\/\//, "").replace(/\/$/, "").split("/");
    const site: any = await graph(token, "GET", `/sites/${host}:/${rest.join("/")}`);
    const folder = (env.BACKUP_FOLDER || "Review Dashboard Backups").replace(/^\/|\/$/g, "");

    const data: Record<string, unknown[]> = {};
    for (const t of TABLES) {
      try { data[t] = (await env.DB.prepare(`SELECT * FROM ${t}`).all()).results; } catch { /* table not set up */ }
    }
    const stamp = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const full = await gzip(JSON.stringify({ exported_at: nowIso(), note: "Notes and escalation details are encrypted with the app's key.", tables: data }));
    const sheet = new TextEncoder().encode("\uFEFF" + csv((data.reviews || []) as any[],
      ["id", "rooftop_key", "location_title", "reviewer_name", "stars", "text", "create_time", "status", "reply_text", "reply_time", "reply_source", "source", "escalation_count", "escalation_outcome"]));
    const files = [`${PREFIX}${stamp}.json.gz`, `${PREFIX}${stamp}-reviews.csv`];
    await upload(token, site.id, folder, files[0], full);
    await upload(token, site.id, folder, files[1], sheet);

    // Keep the newest BACKUP_KEEP backups (two files each)
    const keep = (parseInt(env.BACKUP_KEEP || "12", 10) || 12) * 2;
    const list: any = await graph(token, "GET", `/sites/${site.id}/drive/root:/${encodeURI(folder)}:/children?$select=id,name&$top=500`);
    const ours = (list.value || []).filter((f: any) => String(f.name).startsWith(PREFIX)).sort((a: any, b: any) => (a.name < b.name ? 1 : -1));
    for (const old of ours.slice(keep)) await graph(token, "DELETE", `/sites/${site.id}/drive/items/${old.id}`);

    const result = { ok: true, message: `Saved ${files.join(" and ")} to ${folder}.`, files, bytes: full.length + sheet.length };
    await record(result);
    return result;
  } catch (e) {
    const result = { ok: false, message: (e as Error).message };
    await record(result);
    return result;
  }
}

export async function lastBackup(env: Env): Promise<any> {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'backup:last'").first<{ value: string }>();
    return row ? JSON.parse(row.value) : null;
  } catch { return null; }
}
