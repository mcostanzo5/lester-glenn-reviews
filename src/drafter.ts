import type { Env } from "./types";
import type { DraftResult } from "./router";
import type { Rooftop } from "./rooftops";
import { currentGuidelines, SAFETY_RULES } from "./guidelines";
import { Budget, unlimited } from "./budget";

const CONTRACT = `
Respond with ONLY a JSON object, no preamble and no code fences, in this shape:
{"department": "sales"|"service"|"parts"|"collision"|"finance"|"general",
 "sentiment": "positive"|"mixed"|"negative",
 "risk_level": "low"|"medium"|"high",
 "risk_flags": ["short reason"],
 "reply": "the reply text"}
risk_level is "low" only when the review is clearly positive and contains nothing
a manager would want to see before a public reply goes out.`;

const MAX_REPLY = 1500;

/** House style: no em-dashes, tidy spacing. */
export function cleanReply(text: string): string {
  return text.replace(/\s*\u2014\s*/g, ", ").replace(/\s+,/g, ",").replace(/[ \t]+/g, " ").trim();
}

function failed(reason: string): DraftResult {
  return { ok: false, department: "general", sentiment: "unknown", risk_level: "high", risk_flags: [reason], reply: "" };
}

export async function draftReply(env: Env, stars: number, text: string, rooftop: Rooftop, budget: Budget = unlimited()): Promise<DraftResult> {
  if (!env.ANTHROPIC_API_KEY) return failed("ANTHROPIC_API_KEY is not set");
  budget.take();
  const payload = {
    rooftop: { name: rooftop.name, brand: rooftop.brand, town: rooftop.town, phone: rooftop.phone, contacts: rooftop.contacts, signoff: rooftop.signoff },
    review: { stars, text: text || "(rating only, no text)" },
  };
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: env.CLAUDE_MODEL || "claude-sonnet-5",
        max_tokens: 800,
        system: (await currentGuidelines(env)).text + "\n\n" + SAFETY_RULES + "\n\n" + CONTRACT,
        messages: [{ role: "user", content: JSON.stringify(payload) }],
      }),
    });
    if (!res.ok) {
      const err: any = await res.json().catch(() => ({}));
      return failed(`Claude API error ${res.status}: ${String(err?.error?.message || "no details").slice(0, 200)}`);
    }
    const data: any = await res.json();
    const raw = (data.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    const body = raw.replace(/^```(?:json)?|```$/gm, "").trim();
    const parsed = JSON.parse(body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1));
    const reply = cleanReply(String(parsed.reply || ""));
    const flags: string[] = (parsed.risk_flags || []).map(String).filter(Boolean);
    if (!reply) flags.push("empty reply");
    if (reply.length > MAX_REPLY) flags.push("reply too long");
    return {
      ok: !!reply && reply.length <= MAX_REPLY,
      department: parsed.department || "general",
      sentiment: parsed.sentiment || "unknown",
      risk_level: parsed.risk_level || "high",
      risk_flags: flags,
      reply,
    };
  } catch (e) {
    return failed("Could not read Claude's response");
  }
}
