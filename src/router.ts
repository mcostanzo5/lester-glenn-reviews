// Decides whether a draft may post on its own. Anything uncertain goes to a manager.
// Claude's risk rating is one input; this keyword list backs it up.

const HARD_FLAGS = [
  /\battorney/i, /\blawyer/i, /\blaw ?suit/i, /\bsu(e|ing)\b/i, /\bcourt\b/i, /\blegal\b/i,
  /\bbbb\b/i, /better business/i, /attorney general/i, /consumer affairs/i, /\bdmv\b/i,
  /\binjur/i, /\bunsafe\b/i, /\bdanger/i, /\brecall/i,
  /\bpolice\b/i, /\bfraud/i, /\bscam/i, /\bstole/i, /\bthe(ft|if)/i,
  /\bdiscriminat/i, /\bracis/i, /\bharass/i, /\bsexis/i,
  /\brefund/i, /\bchargeback/i, /\bdispute/i, /\bcharged me/i,
  /\bnews\b/i, /\breporter/i, /\bsocial media\b/i,
];

export function keywordHits(text: string): string[] {
  const hits = new Set<string>();
  for (const re of HARD_FLAGS) {
    const m = (text || "").match(re);
    if (m) hits.add(m[0].toLowerCase());
  }
  return [...hits].sort();
}

export interface DraftResult {
  ok: boolean;
  department: string;
  sentiment: string;
  risk_level: string;
  risk_flags: string[];
  reply: string;
}

export function route(stars: number, text: string, d: DraftResult, minStars: number): { action: "auto" | "review"; reason: string } {
  if (!d.ok) return { action: "review", reason: "Drafting problem: " + (d.risk_flags.join(", ") || "unknown") };
  const hits = keywordHits(text);
  if (hits.length) return { action: "review", reason: "Sensitive keywords: " + hits.join(", ") };
  if (stars < minStars) return { action: "review", reason: `${stars} star review` };
  if (d.sentiment !== "positive") return { action: "review", reason: `Sentiment is ${d.sentiment}` };
  if (d.risk_level !== "low") return { action: "review", reason: `Risk ${d.risk_level}: ${d.risk_flags.join(", ") || "no detail"}` };
  return { action: "auto", reason: "Positive, low risk" };
}
