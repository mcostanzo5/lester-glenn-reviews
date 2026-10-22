export interface Rooftop {
  key: string;
  name: string;
  brand: string;
  town: string;
  phone: string; // leave blank to keep phone numbers out of replies
  signoff: string;
  contacts: Record<string, string>;
  matchAll?: string[];
  matchAny?: string[];
}

const store: Record<string, string> = { sales: "our Sales Manager", service: "our Service Manager", parts: "our Parts Manager", finance: "our Finance Manager" };

function rt(key: string, name: string, brand: string, town: string, matchAll: string[], matchAny?: string[], contacts: Record<string, string> = store): Rooftop {
  return { key, name, brand, town, phone: "", signoff: key === "group" ? "The Lester Glenn Team" : `The ${name} Team`, contacts, matchAll, matchAny };
}

// Matched in order against each Google location title; first match wins.
// Keep specific entries (Freehold, Old Bridge) above general ones (Chevrolet).
export const ROOFTOPS: Rooftop[] = [
  rt("collision", "Lester Glenn Collision Center", "Collision", "Toms River", ["collision"], undefined, { collision: "our Collision Center Manager" }),
  rt("chevy-freehold", "Lester Glenn Chevrolet of Freehold", "Chevrolet", "Freehold", ["chevrolet", "freehold"]),
  rt("chevy-old-bridge", "Lester Glenn Chevrolet of Old Bridge", "Chevrolet", "Old Bridge", ["chevrolet", "old bridge"]),
  rt("gmc", "Lester Glenn GMC", "GMC", "Toms River", ["gmc"]),
  rt("chevy-toms-river", "Lester Glenn Chevrolet", "Chevrolet", "Toms River", ["chevrolet"]),
  rt("cdjr", "Lester Glenn Chrysler Dodge Jeep Ram FIAT", "Chrysler Dodge Jeep Ram FIAT", "Toms River", [], ["jeep", "dodge", "chrysler"]),
  rt("ford", "Lester Glenn Ford", "Ford", "Ocean", ["ford"]),
  rt("honda", "Lester Glenn Honda", "Honda", "Sea Girt", ["honda"]),
  rt("hyundai", "Lester Glenn Hyundai", "Hyundai", "Toms River", ["hyundai"]),
  rt("mazda", "Lester Glenn Mazda", "Mazda", "Toms River", ["mazda"]),
  rt("subaru", "Lester Glenn Subaru", "Subaru", "Toms River", ["subaru"]),
  // The group-level Google listing. Reviewers here often can't be tied to one store,
  // so replies point them to Customer Care.
  rt("group", "Lester Glenn Auto Group", "", "", ["auto group"], undefined,
    { general: "our Customer Care team at customercare@lesterglenn.com", sales: "our Customer Care team at customercare@lesterglenn.com", service: "our Customer Care team at customercare@lesterglenn.com" }),
];

export const DEFAULT_ROOFTOP: Rooftop = {
  // Catch-all for any Google listing that doesn't match a store above. If this shows up
  // in the dashboard, a listing name needs a matching rule.
  key: "other", name: "Unmatched Google listing", brand: "", town: "", phone: "",
  signoff: "The Lester Glenn Team", contacts: { sales: "our Sales Manager", service: "our Service Manager" },
};

export function matchRooftop(title: string | undefined): Rooftop {
  const t = (title || "").toLowerCase();
  for (const r of ROOFTOPS) {
    const all = (r.matchAll || []).every((k) => t.includes(k));
    const any = !r.matchAny?.length || r.matchAny.some((k) => t.includes(k));
    if (all && any) return r;
  }
  return DEFAULT_ROOFTOP;
}

/** The store as customers know it. Unmatched listings use their own Google listing name. */
export function rooftopFor(key: string, listingTitle?: string | null): Rooftop {
  const r = rooftopByKey(key);
  if (r.key !== "other") return r;
  const name = (listingTitle || "").trim() || "Lester Glenn Auto Group";
  return { ...r, name, signoff: "The Lester Glenn Team" };
}

export function rooftopByKey(key: string): Rooftop {
  return ROOFTOPS.find((r) => r.key === key) || DEFAULT_ROOFTOP;
}
