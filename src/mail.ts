import type { Env } from "./types";
import { nowIso } from "./types";

// Sends escalation emails from the signed-in person's own Microsoft 365
// mailbox. At sign-in, Microsoft gives the app a refresh token for that person
// (delegated Mail.Send: the app can only send as the person who signed in).
// It's stored encrypted in D1 and exchanged for a short-lived token when
// they send. The email lands in their own Sent Items.

export const GRAPH_SCOPES = "offline_access https://graph.microsoft.com/Mail.Send";
const LOGIN_BASE = "https://login.microsoftonline.com";
const GRAPH = "https://graph.microsoft.com/v1.0";

export class MailError extends Error {
  constructor(message: string, public needsSignIn = false) { super(message); }
}

export function mailConfigured(env: Env): boolean {
  return !!(env.MS_TENANT_ID && env.MS_CLIENT_ID && env.MS_CLIENT_SECRET);
}

export function allowedDomains(env: Env): string[] {
  return (env.MAIL_ALLOWED_DOMAINS || "lesterglenn.com").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
}

/** Cleans a list of addresses. Returns the valid ones and any that were rejected. */
export function checkAddresses(env: Env, input: unknown): { ok: string[]; bad: string[] } {
  const raw = Array.isArray(input) ? input.map(String) : String(input || "").split(/[\s,;]+/);
  const domains = allowedDomains(env);
  const ok = new Set<string>();
  const bad: string[] = [];
  for (const a of raw.map((x) => x.trim().toLowerCase()).filter(Boolean)) {
    const m = a.match(/^[^@\s<>"]+@([^@\s<>"]+\.[a-z]{2,})$/);
    if (m && domains.includes(m[1])) ok.add(a);
    else bad.push(a);
  }
  return { ok: [...ok], bad };
}

/* ---- Encrypted token storage ---- */

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function tokenKey(env: Env): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(`lg-tokens:${env.SESSION_SECRET || env.MS_CLIENT_SECRET}`));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function storeRefreshToken(env: Env, email: string, refreshToken: string): Promise<void> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await tokenKey(env), enc.encode(refreshToken)));
  await env.DB.prepare(`INSERT INTO ms_tokens (email, token, updated_at) VALUES (?,?,?)
    ON CONFLICT(email) DO UPDATE SET token=excluded.token, updated_at=excluded.updated_at`)
    .bind(email, `${b64(iv)}.${b64(sealed)}`, nowIso()).run();
}

async function loadRefreshToken(env: Env, email: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT token FROM ms_tokens WHERE email = ?").bind(email).first<{ token: string }>();
  if (!row) return null;
  try {
    const [iv, data] = row.token.split(".");
    return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await tokenKey(env), unb64(data)));
  } catch { return null; } // key changed (client secret renewed): they just sign in again
}

export async function forgetRefreshToken(env: Env, email: string): Promise<void> {
  try { await env.DB.prepare("DELETE FROM ms_tokens WHERE email = ?").bind(email).run(); } catch { /* table not created yet */ }
  accessCache.delete(email);
}

/** Whether this person can send right now (has a stored Microsoft token). */
export async function canSendAs(env: Env, email: string): Promise<boolean> {
  try { return !!(await env.DB.prepare("SELECT 1 AS ok FROM ms_tokens WHERE email = ?").bind(email).first()); }
  catch { return false; }
}

const accessCache = new Map<string, { token: string; exp: number }>();

async function accessTokenFor(env: Env, email: string): Promise<string> {
  // Always check the stored permission first, so signing out stops sending right away
  const refresh = await loadRefreshToken(env, email);
  if (!refresh) accessCache.delete(email);
  const cached = accessCache.get(email);
  if (refresh && cached && Date.now() < cached.exp - 60_000) return cached.token;
  if (!refresh) throw new MailError("To send from your mailbox, sign out and sign back in once.", true);
  const res = await fetch(`${LOGIN_BASE}/${env.MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.MS_CLIENT_ID,
      client_secret: env.MS_CLIENT_SECRET!,
      grant_type: "refresh_token",
      refresh_token: refresh,
      scope: GRAPH_SCOPES,
    }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    if (data.error === "invalid_grant" || data.error === "interaction_required") {
      await forgetRefreshToken(env, email);
      throw new MailError("Your Microsoft permission to send expired. Sign out and sign back in, then send again.", true);
    }
    throw new MailError(`Microsoft didn't allow sending (${data.error || res.status}). Check that the app has the delegated Mail.Send permission with admin consent.`);
  }
  if (data.refresh_token) await storeRefreshToken(env, email, data.refresh_token); // Microsoft rotates these
  accessCache.set(email, { token: data.access_token, exp: Date.now() + (data.expires_in ?? 3600) * 1000 });
  return data.access_token;
}

export interface Outgoing { to: string[]; subject: string; html: string }

/** Sends as the signed-in person, from their own mailbox. */
export async function sendAs(env: Env, email: string, m: Outgoing): Promise<void> {
  if (!mailConfigured(env)) throw new MailError("Microsoft sign-in isn't fully set up, so email can't be sent.");
  const res = await fetch(`${GRAPH}/me/sendMail`, {
    method: "POST",
    headers: { authorization: `Bearer ${await accessTokenFor(env, email)}`, "content-type": "application/json" },
    body: JSON.stringify({
      message: {
        subject: m.subject,
        body: { contentType: "HTML", content: m.html },
        toRecipients: m.to.map((a) => ({ emailAddress: { address: a } })),
      },
      saveToSentItems: true,
    }),
  });
  if (res.status !== 202 && !res.ok) {
    const err: any = await res.json().catch(() => ({}));
    const msg = err?.error?.message || `status ${res.status}`;
    if (res.status === 401) { await forgetRefreshToken(env, email); throw new MailError("Your Microsoft session for sending expired. Sign out and back in, then send again.", true); }
    if (res.status === 403) throw new MailError(`Microsoft refused to send from your mailbox (${msg}). IT may need to grant the Mail.Send permission.`);
    throw new MailError(`The email didn't send: ${msg}`);
  }
}
