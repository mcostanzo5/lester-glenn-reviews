import type { Env } from "./types";
import { nowIso } from "./types";
import { ROOFTOPS } from "./rooftops";

// Fictional reviews for dry-run mode so the dashboard and statistics have
// something to show before Google approves API access. No real customers.

const RECENT: [string, number, string][] = [
  ["subaru", 5, "Dropped off my Outback for its 30k service and they had it done in under two hours. The waiting area was clean and the advisor explained everything without trying to upsell me."],
  ["chevy-freehold", 5, ""],
  ["honda", 4, "Great experience buying my CR-V. Sales process was smooth, only knock is finance took a while at the end."],
  ["hyundai", 3, "Service was fine but I waited over an hour past the time they quoted me and nobody gave me an update."],
  ["ford", 1, "Brought my truck in for a check engine light, they charged me for a diagnostic and the light came back on the next day. Called twice and never got a call back."],
  ["cdjr", 1, "They added fees at signing that were never discussed. I have already contacted my attorney about this."],
  ["collision", 5, "After my accident this team handled everything with my insurance and the car looks brand new. Could not have asked for better."],
  ["chevy-toms-river", 5, "Mike in sales made buying my Silverado painless. No pressure, straight answers, and he stayed late so I could take it home that night."],
];

const POOL: [number, string][] = [
  [5, "Quick oil change, friendly service advisor, and they washed the car too."],
  [5, "Best car buying experience I have had. No games and a fair trade-in number."],
  [5, "Parts counter had exactly what I needed and got me out the door fast."],
  [5, ""],
  [5, "Service department is always on time and upfront about costs."],
  [4, "Good experience overall. The shuttle ran a little late but the work was done right."],
  [4, "Salesperson knew the product well. Paperwork took longer than I hoped."],
  [4, ""],
  [3, "Car was fixed but I had to call three times for an update."],
  [3, "Decent price, but the loaner situation was confusing."],
  [2, "Appointment was at 8 and they did not start on my car until almost 11."],
  [2, "Felt rushed through the finance office."],
  [1, "Nobody returned my calls about a warranty repair for a week."],
  [5, "Mike in sales was patient and never pushy. Dana in finance had the paperwork done in twenty minutes."],
  [5, "Kaitlyn at the service desk kept me updated by text the whole day. Great experience."],
  [4, "Jordan found me exactly the trim I wanted. Delivery took a bit long but Jordan stayed with me."],
  [2, "Mike told me the car would be ready by noon and it wasn't ready until four."],
  [5, "Mike S. in service explained every line on the invoice. First time I didn't feel upsold."],
  [3, "Kaitlyn was nice but the wait for an oil change was over two hours."],
];

const REPLIES: Record<string, string> = {
  good: "We appreciate you taking the time to share this, and we look forward to seeing you again soon.",
  mid: "Thanks for the honest feedback. We'd like to hear more so we can do better next time, please reach out to our manager directly.",
  bad: "We're sorry your visit fell short. Please contact our manager directly so we can follow up personally.",
};

function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export async function loadSamples(env: Env): Promise<number> {
  await clearSamples(env);
  const rand = rng(1956);
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  const insert = env.DB.prepare(
    `INSERT INTO reviews (id, location_name, rooftop_key, location_title, stars, text, create_time, update_time, status,
       reply_text, reply_time, reply_source, is_sample, synced_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)`
  );

  RECENT.forEach(([key, stars, text], i) => {
    const r = ROOFTOPS.find((x) => x.key === key)!;
    const t = new Date(now - (i + 1) * 3.5 * 3600_000).toISOString();
    stmts.push(insert.bind(`sample/recent/${i}`, `sample/${key}`, key, r.name, stars, text, t, t, "new", null, null, null, nowIso()));
  });

  for (let i = 0; i < 140; i++) {
    const r = ROOFTOPS[Math.floor(rand() * ROOFTOPS.length)];
    const [stars, text] = POOL[Math.floor(rand() * POOL.length)];
    const created = now - (2 + rand() * 180) * 86400_000;
    const t = new Date(created).toISOString();
    const roll = rand();
    let status = "replied_external", source: string | null = "google";
    if (roll < 0.08) { status = "old_unanswered"; source = null; }
    else if (roll < 0.35 && stars >= 4) { status = "auto_posted"; source = "agent"; }
    else if (roll < 0.45) { status = "approved_posted"; source = "manager"; }
    const hours = stars >= 4 ? 1 + rand() * 30 : 3 + rand() * 90;
    const replyTime = source ? new Date(created + hours * 3600_000).toISOString() : null;
    const reply = source ? `${stars >= 4 ? REPLIES.good : stars === 3 ? REPLIES.mid : REPLIES.bad}\n${r.signoff}` : null;
    stmts.push(insert.bind(`sample/history/${i}`, `sample/${r.key}`, r.key, r.name, stars, text, t, t, status, reply, replyTime, source, nowIso()));
  }
  await env.DB.batch(stmts);
  return stmts.length;
}

export async function clearSamples(env: Env): Promise<void> {
  // Tables added by later setup steps may not exist yet, so each is cleared on its own
  for (const sql of ["DELETE FROM mentions WHERE review_id LIKE 'sample/%'", "DELETE FROM escalations WHERE review_id LIKE 'sample/%'"]) {
    try { await env.DB.prepare(sql).run(); } catch { /* not set up yet */ }
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM events WHERE review_id LIKE 'sample/%'"),
    env.DB.prepare("DELETE FROM reviews WHERE is_sample = 1"),
  ]);
}
