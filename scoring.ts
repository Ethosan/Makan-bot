export type Tier = "cheap" | "normal" | "fancy";
export type Category = "food" | "ambiance" | "aesthetics" | "service";

/** Order the wizard walks you through. */
export const CATEGORIES: Category[] = ["food", "ambiance", "aesthetics", "service"];

export const CATEGORY_LABEL: Record<Category, string> = {
  food: "Food",
  ambiance: "Ambiance",
  aesthetics: "Aesthetics",
  service: "Service",
};

/** Shown under each question so you're both scoring the same thing. */
export const CATEGORY_HINT: Record<Category, string> = {
  food: "The actual cooking. Ignore everything else.",
  ambiance: "How the room felt — noise, lighting, crowd, comfort.",
  aesthetics: "How it looked — plating, interior, the photos you took.",
  service: "Staff. Attentive, warm, competent, or none of the above.",
};

export interface PartialRating {
  telegram_id: number;
  food: number | null;
  ambiance: number | null;
  aesthetics: number | null;
  service: number | null;
}

export interface Rating extends PartialRating {
  food: number;
  ambiance: number;
  aesthetics: number;
  service: number;
}

// Weights are per-tier on purpose: food should dominate at a $6 stall, while
// service and room matter far more when you're paying for them.
// Each set must sum to 1. Nothing else depends on the exact numbers.
export const WEIGHTS: Record<Tier, Record<Category, number>> = {
  cheap:  { food: 0.65, ambiance: 0.15, aesthetics: 0.10, service: 0.10 },
  normal: { food: 0.50, ambiance: 0.20, aesthetics: 0.10, service: 0.20 },
  fancy:  { food: 0.40, ambiance: 0.20, aesthetics: 0.15, service: 0.25 },
};

/**
 * How the OVERALL board compares places from different tiers.
 *
 *   "raw"      - straight combined score. Simple, but fancy places have a
 *                structural edge: they can buy ambiance and service.
 *   "relative" - how far a place sits above or below its own tier's average,
 *                so an outstanding hawker stall can beat a merely-good fancy
 *                restaurant. Needs a few rated places per tier to mean anything.
 */
export const OVERALL_MODE: "raw" | "relative" = "raw";

export const TIERS: Tier[] = ["cheap", "normal", "fancy"];

export const TIER_LABEL: Record<Tier, string> = {
  cheap: "Cheap eats",
  normal: "Normal",
  fancy: "Fancy",
};

export const TIER_EMOJI: Record<Tier, string> = {
  cheap: "\u{1F35C}",
  normal: "\u{1F37D}\uFE0F",
  fancy: "\u{1F942}",
};

export function isComplete(r: PartialRating): r is Rating {
  return CATEGORIES.every((c) => r[c] !== null && r[c] !== undefined);
}

export function nextCategory(r: PartialRating | null): Category | null {
  if (!r) return CATEGORIES[0];
  return CATEGORIES.find((c) => r[c] === null || r[c] === undefined) ?? null;
}

export function answeredCount(r: PartialRating | null): number {
  if (!r) return 0;
  return CATEGORIES.filter((c) => r[c] !== null && r[c] !== undefined).length;
}

/** Weighted score for one person's rating of one place. */
export function personalScore(r: Rating, tier: Tier): number {
  const w = WEIGHTS[tier];
  return CATEGORIES.reduce((sum, c) => sum + r[c] * w[c], 0);
}

/** Combined score: the mean of both weighted scores. */
export function combinedScore(ratings: Rating[], tier: Tier): number {
  if (!ratings.length) return 0;
  return ratings.reduce((s, r) => s + personalScore(r, tier), 0) / ratings.length;
}

/** How far apart the two of you landed, on the weighted scale. */
export function disagreement(ratings: Rating[], tier: Tier): number {
  if (ratings.length < 2) return 0;
  const s = ratings.map((r) => personalScore(r, tier));
  return Math.abs(s[0] - s[1]);
}

export function fmt(n: number): string {
  return n.toFixed(2);
}

export function signed(n: number): string {
  return (n >= 0 ? "+" : "") + n.toFixed(2);
}

export function parseTier(input: string): Tier | null {
  const t = input.trim().toLowerCase();
  if (["cheap", "c", "hawker"].includes(t)) return "cheap";
  if (["normal", "n", "casual", "mid"].includes(t)) return "normal";
  if (["fancy", "f", "atas"].includes(t)) return "fancy";
  return null;
}
