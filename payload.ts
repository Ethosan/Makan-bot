import type { SupabaseClient } from "@supabase/supabase-js";
import { peopleMap } from "./db";
import { combinedScore, disagreement, personalScore, TIERS, type Tier } from "./scoring";

export interface SitePerson {
  id: number;
  name: string;
}

export interface SiteEntry {
  id: number;
  name: string;
  tier: Tier;
  visited_on: string | null;
  photo: boolean;
  combined: number;
  gap: number;
  scores: { personId: number; total: number; food: number; ambiance: number; aesthetics: number; service: number }[];
  tierRank: number;
  overallRank: number;
  vsTier: number;
}

export interface SitePayload {
  people: SitePerson[];
  entries: SiteEntry[];
  pending: { name: string; tier: Tier; progress: string }[];
  counts: Record<Tier | "all", number>;
}

/** Everything the site renders, computed the same way the pinned board is. */
export async function buildPayload(sb: SupabaseClient): Promise<SitePayload> {
  const { data } = await sb
    .from("restaurants")
    .select("id, name, tier, visited_on, photo_file_id, photo_url, ratings(telegram_id, food, ambiance, aesthetics, service)");

  const names = await peopleMap(sb);
  const people: SitePerson[] = [...names.entries()].map(([id, name]) => ({ id, name }));
  const needed = Math.max(2, people.length);

  const all = (data ?? []) as any[];
  const entries: SiteEntry[] = [];
  const pending: SitePayload["pending"] = [];

  for (const r of all) {
    const ratings = (r.ratings ?? []).map((x: any) => ({
      telegram_id: Number(x.telegram_id),
      food: x.food === null ? null : Number(x.food),
      ambiance: x.ambiance === null ? null : Number(x.ambiance),
      aesthetics: x.aesthetics === null ? null : Number(x.aesthetics),
      service: x.service === null ? null : Number(x.service),
    }));
    const done = ratings.filter(
      (x: any) => x.food !== null && x.ambiance !== null && x.aesthetics !== null && x.service !== null
    );

    if (done.length < needed) {
      pending.push({
        name: r.name,
        tier: r.tier,
        progress: people
          .map((p) => {
            const mine = ratings.find((x: any) => x.telegram_id === p.id);
            const n = mine
              ? ["food", "ambiance", "aesthetics", "service"].filter((c) => mine[c] !== null).length
              : 0;
            return `${p.name} ${n}/4`;
          })
          .join(" · "),
      });
      continue;
    }

    entries.push({
      id: Number(r.id),
      name: r.name,
      tier: r.tier,
      visited_on: r.visited_on,
      photo: Boolean(r.photo_file_id || r.photo_url),
      combined: combinedScore(done, r.tier),
      gap: disagreement(done, r.tier),
      scores: done.map((x: any) => ({
        personId: x.telegram_id,
        total: personalScore(x, r.tier),
        food: x.food,
        ambiance: x.ambiance,
        aesthetics: x.aesthetics,
        service: x.service,
      })),
      tierRank: 0,
      overallRank: 0,
      vsTier: 0,
    });
  }

  entries.sort((a, b) => b.combined - a.combined);
  entries.forEach((e, i) => (e.overallRank = i + 1));

  for (const tier of TIERS) {
    const inTier = entries.filter((e) => e.tier === tier);
    inTier.forEach((e, i) => (e.tierRank = i + 1));
    if (inTier.length) {
      const mean = inTier.reduce((s, e) => s + e.combined, 0) / inTier.length;
      inTier.forEach((e) => (e.vsTier = e.combined - mean));
    }
  }

  const counts = { all: entries.length } as Record<Tier | "all", number>;
  for (const tier of TIERS) counts[tier] = entries.filter((e) => e.tier === tier).length;

  return { people, entries, pending, counts };
}
