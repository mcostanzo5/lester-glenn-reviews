import type { Env } from "./types";
import { mode } from "./types";
import { identify } from "./auth";
import { callback, login, logout, msConfigured, page, sessionEmail } from "./msauth";
import { handleApi, json } from "./api";
import { runAgent } from "./agent";

/** Secret header value that lets a scheduled run hand its work to this Worker's own address. */
async function internalToken(env: Env): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`lg-internal:${env.SESSION_SECRET || env.MS_CLIENT_SECRET || ""}`),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("scheduled-run")));
  return btoa(String.fromCharCode(...sig));
}

function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function isRunHour(time: number, hours = "8,12,16,20"): boolean {
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(new Date(time)));
  return hours.split(",").map((x) => Number(x.trim())).includes(h);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const local = url.hostname === "localhost" && !!env.DEV_AUTH_EMAIL;

    // A scheduled run handing its work to the pinned location (see scheduled() below)
    if (url.pathname === "/__scheduled-run" && req.method === "POST") {
      const given = req.headers.get("x-internal-run") || "";
      if (!given || !sameSecret(given, await internalToken(env))) return new Response("Not found", { status: 404 });
      const s = await runAgent(env, "schedule");
      return new Response(JSON.stringify(s), { headers: { "content-type": "application/json" } });
    }

    if (!local && !msConfigured(env)) {
      return page("Almost there", "Microsoft sign-in isn't set up yet. Add MS_TENANT_ID, MS_CLIENT_ID and the MS_CLIENT_SECRET secret in Cloudflare.", undefined, 503);
    }
    if (url.pathname === "/auth/login") return login(req, env);
    if (url.pathname === "/auth/callback") return callback(req, env);
    if (url.pathname === "/auth/logout") return logout(req, env);

    // Dashboard files: only for signed-in people
    if (!url.pathname.startsWith("/api/")) {
      if (!local && !(await sessionEmail(req, env))) {
        return Response.redirect(`${url.origin}/auth/login?returnTo=${encodeURIComponent(url.pathname + url.search)}`, 302);
      }
      return env.ASSETS.fetch(req);
    }

    const who = await identify(req, env);
    if (!who.user) return json({ error: who.error }, who.status || 401);
    try {
      return await handleApi(req, env, who.user);
    } catch (e) {
      console.error(e);
      return json({ error: "Something went wrong on the server. Try again, and check the Worker logs if it keeps happening." }, 500);
    }
  },

  async scheduled(event: ScheduledController, env: Env, _ctx: ExecutionContext) {
    // Dry run is for manual testing only, so scheduled runs don't spend Claude credits on samples
    if (mode(env) === "dry_run") return;
    // Only run at the configured Eastern hours; the other cron wake-ups exit right away
    if (!isRunHour(event.scheduledTime, env.RUN_HOURS_ET)) return;
    // Cloudflare can start scheduled runs in any of its data centers, including ones in places
    // Claude doesn't serve. Hand the run to this Worker's own address, which is pinned to the
    // eastern U.S. by [placement] in wrangler.toml. If that fails, run here as before.
    if (env.SELF_URL) {
      try {
        const res = await fetch(`${env.SELF_URL.replace(/\/$/, "")}/__scheduled-run`, {
          method: "POST", headers: { "x-internal-run": await internalToken(env) },
        });
        if (res.ok) { console.log("run (pinned)", await res.text()); return; }
        console.warn("handoff returned", res.status, "running here instead");
      } catch (e) {
        console.warn("handoff failed, running here instead", e);
      }
    }
    const s = await runAgent(env, "schedule");
    console.log("run", JSON.stringify(s));
  },
} satisfies ExportedHandler<Env>;
