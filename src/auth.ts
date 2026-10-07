import type { Env, User } from "./types";

// Verifies the Cloudflare Access login token on every API call, then looks up
// the person's role. Access already blocks anyone who hasn't signed in with
// Microsoft; this is a second check plus identity.

let jwks: { keys: any[]; at: number } | null = null;

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
}

async function keysFor(team: string): Promise<any[]> {
  if (jwks && Date.now() - jwks.at < 3600_000) return jwks.keys;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error("Could not load Access signing keys");
  const data: any = await res.json();
  jwks = { keys: data.keys || [], at: Date.now() };
  return jwks.keys;
}

async function verifyAccessJwt(token: string, env: Env): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
  const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
  const jwk = (await keysFor(env.ACCESS_TEAM_DOMAIN)).find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return null;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return null;
  if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return null;
  return typeof payload.email === "string" ? payload.email.toLowerCase() : null;
}

export async function identify(req: Request, env: Env): Promise<{ user?: User; error?: string; status?: number }> {
  let email: string | null = null;
  if (env.DEV_AUTH_EMAIL && new URL(req.url).hostname === "localhost") {
    email = env.DEV_AUTH_EMAIL.toLowerCase();
  } else {
    if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
      return { error: "Sign-in is not configured yet. Set ACCESS_TEAM_DOMAIN and ACCESS_AUD.", status: 503 };
    }
    const token = req.headers.get("cf-access-jwt-assertion");
    if (!token) return { error: "Not signed in.", status: 401 };
    try { email = await verifyAccessJwt(token, env); } catch { email = null; }
    if (!email) return { error: "Your sign-in could not be verified. Refresh the page to sign in again.", status: 401 };
  }

  const admins = (env.ADMIN_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (admins.includes(email)) return { user: { email, role: "admin", rooftops: "*" } };

  const row = await env.DB.prepare("SELECT role, rooftops FROM users WHERE email = ?").bind(email).first<{ role: User["role"]; rooftops: string }>();
  if (!row) return { error: `${email} doesn't have access yet. Ask an admin to add you in Settings.`, status: 403 };
  return { user: { email, role: row.role, rooftops: row.rooftops === "*" ? "*" : row.rooftops.split(",").filter(Boolean) } };
}

export function canSee(user: User, rooftopKey: string): boolean {
  return user.rooftops === "*" || user.rooftops.includes(rooftopKey);
}

export function canAct(user: User, rooftopKey: string): boolean {
  return user.role !== "viewer" && canSee(user, rooftopKey);
}
