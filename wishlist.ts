import type { SupabaseClient } from "@supabase/supabase-js";
import { InlineKeyboard } from "grammy";
import { TIERS, TIER_EMOJI, TIER_LABEL, parseTier, type Tier } from "./scoring";
import { escapeHtml } from "./leaderboard";

export interface Want {
  id: number;
  chat_id: number;
  name: string;
  tier: Tier | null;
  note: string | null;
  source_message_id: number | null;
}

export async function addWant(
  sb: SupabaseClient,
  row: {
    chat_id: number;
    name: string;
    tier: Tier | null;
    note?: string | null;
    source_message_id?: number | null;
    added_by?: number | null;
  }
): Promise<{ want?: Want; error?: string }> {
  const { data, error } = await sb.from("wishlist").insert(row).select().single();
  if (error) {
    if (error.code === "23505") return { error: "already on the want list" };
    return { error: error.message };
  }
  return { want: data as Want };
}

export async function wants(sb: SupabaseClient, chatId: number, tier?: Tier | null): Promise<Want[]> {
  let q = sb.from("wishlist").select("*").eq("chat_id", chatId);
  // An explicit tier means exactly that tier. A plain roll includes untagged
  // ones, since "unknown" is still a candidate when you have no preference.
  if (tier) q = q.eq("tier", tier);
  const { data } = await q;
  return (data ?? []) as Want[];
}

export async function wantById(sb: SupabaseClient, id: number): Promise<Want | null> {
  const { data } = await sb.from("wishlist").select("*").eq("id", id).maybeSingle();
  return (data as Want) ?? null;
}

export async function dropWant(sb: SupabaseClient, id: number) {
  await sb.from("wishlist").delete().eq("id", id);
}

export function pick<T>(items: T[]): T | null {
  return items.length ? items[Math.floor(Math.random() * items.length)] : null;
}

export function wantListText(list: Want[]): string {
  if (!list.length) return "Nothing on the want list yet. Add one with <code>/want Name</code>.";

  const lines = [`\u{1F4DD} <b>WANT TO EAT</b> \u00b7 ${list.length}`, ""];
  for (const tier of TIERS) {
    const inTier = list.filter((w) => w.tier === tier);
    if (!inTier.length) continue;
    lines.push(`${TIER_EMOJI[tier]} <b>${TIER_LABEL[tier]}</b>`);
    for (const w of inTier) lines.push(`• ${escapeHtml(w.name)}`);
    lines.push("");
  }
  const untagged = list.filter((w) => !w.tier);
  if (untagged.length) {
    lines.push("<b>Not tagged yet</b>");
    for (const w of untagged) lines.push(`• ${escapeHtml(w.name)}`);
    lines.push("");
  }
  lines.push("<i>/random to pick one, or /random cheap</i>");
  return lines.join("\n");
}

export function rollText(w: Want, tier: Tier | null): string {
  return [
    `\u{1F3B2} <b>${escapeHtml(w.name)}</b>`,
    w.tier ? `<i>${TIER_LABEL[w.tier]}</i>` : "<i>tier not tagged</i>",
    w.note ? `\n${escapeHtml(w.note)}` : "",
    "",
    tier ? `<i>from the ${TIER_LABEL[tier].toLowerCase()} shortlist</i>` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function rollKeyboard(w: Want, tier: Tier | null): InlineKeyboard {
  return new InlineKeyboard()
    .text("\u{1F3B2} Again", `w:roll:${tier ?? "any"}`)
    .text("\u2705 We went", `w:went:${w.id}`)
    .row()
    .text("\u2715 Take it off the list", `w:drop:${w.id}`);
}

/**
 * Parses one line of a pasted list. Handles the shapes people actually paste:
 * bullets, numbering, a trailing "| tier", and a parenthetical aside that
 * becomes the note.
 *
 *   "- LES AMIS (when we rich rich)"  ->  LES AMIS, note "when we rich rich"
 *   "3. Odette | fancy"               ->  Odette, tier fancy
 */
export function parseWantLine(line: string): { name: string; tier: Tier | null; note: string | null } | null {
  let s = line.replace(/^\s*[-*\u2022\u2013\u2014]\s*/, "").replace(/^\s*\d+[.)]\s*/, "").trim();
  if (!s) return null;

  let tier: Tier | null = null;
  if (s.includes("|")) {
    const parts = s.split("|");
    const maybe = parseTier(parts[parts.length - 1]);
    if (maybe) {
      tier = maybe;
      parts.pop();
      s = parts.join("|").trim();
    }
  }

  let note: string | null = null;
  const paren = s.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  if (paren && paren[1].trim()) {
    s = paren[1].trim();
    note = paren[2].trim() || null;
  }

  return s ? { name: s, tier, note } : null;
}

/**
 * Weighted pick for revisits. Uniform random keeps offering the place you
 * both scored 6.5, which isn't what "where should we go" means. Squaring the
 * distance above 4 makes a 8.9 roughly three times likelier than a 6.9,
 * without ever ruling the low ones out.
 */
export function pickWeighted<T>(items: T[], scoreOf: (t: T) => number): T | null {
  if (!items.length) return null;
  const weights = items.map((it) => Math.pow(Math.max(0.1, scoreOf(it) - 4), 2));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}
