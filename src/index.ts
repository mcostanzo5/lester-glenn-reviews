import type { Env } from "./types";
import { mode } from "./types";
import { identify } from "./auth";
import { handleApi, json } from "./api";
import { runAgent } from "./agent";

export function isRunHour(time: number, hours = "8,12,16,20"): boolean {
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(new Date(time)));
  return hours.split(",").map((x) => Number(x.trim())).includes(h);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
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
    const s = await runAgent(env, "schedule");
    console.log("run", JSON.stringify(s));
  },
} satisfies ExportedHandler<Env>;
