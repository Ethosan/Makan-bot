import type { Bot } from "grammy";
import type { SupabaseClient } from "@supabase/supabase-js";
import { allWithRatings, getBoard, peopleMap, type ScoredRow } from "./db";
import {
  CATEGORIES,
  CATEGORY_LABEL,
  OVERALL_MODE,
  TIERS,
  TIER_EMOJI,
  TIER_LABEL,
  combinedScore,
  disagreement,
  fmt,
  signed,
  type Rating,
  type Tier,
} from "./scoring";

const MEDALS = ["\u{1F947}", "\u{1F948}", "\u{1F949}"];
const GAP_FLAG = 1.5;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface Entry {
  id: number;
  name: string;
  tier: Tier;
  score: number;
  gap: number;
}

function rank(i: number): string {
  return i < 3 ? MEDALS[i] : `<b>${i + 1}.</b>`;
}

export async function renderBoard(sb: SupabaseClient, chatId: number): Promise<string> {
  const rows = await allWithRatings(sb, chatId);
  const names = await peopleMap(sb);
  const needed = Math.max(2, names.size);

  const done: Entry[] = rows
    .filter((r) => r.complete.length >= needed)
    .map((r) => ({
      id: r.id,
      name: r.name,
      tier: r.tier,
      score: combinedScore(r.complete, r.tier),
      gap: disagreement(r.complete, r.tier),
    }));

  const out: string[] = ["\u{1F37D}\uFE0F <b>THE LIST</b>", ""];

  if (!done.length) {
    out.push("<i>Nothing fully rated yet.</i>", "");
  } else {
    out.push(...overallSection(done), "");
    for (const tier of TIERS) {
      const inTier = done.filter((e) => e.tier === tier).sort((a, b) => b.score - a.score);
      if (!inTier.length) continue;
      out.push(`${TIER_EMOJI[tier]} <b>${TIER_LABEL[tier].toUpperCase()}</b>`);
      inTier.forEach((e, i) =>
        out.push(`${rank(i)} ${escapeHtml(e.name)} — <b>${fmt(e.score)}</b>${e.gap >= GAP_FLAG ? "  \u26A1" : ""}`)
      );
      out.push("");
    }
  }

  const pending = rows.filter((r) => r.complete.length < needed);
  if (pending.length) {
    out.push("<b>In progress</b>");
    for (const r of pending) out.push(`• ${escapeHtml(r.name)} — ${progressLine(r, names)}`);
    out.push("");
  }

  out.push(
    `<i>\u26A1 = you two disagreed by ${GAP_FLAG}+ · updated ${new Date()
      .toISOString()
      .slice(0, 16)
      .replace("T", " ")} UTC</i>`
  );
  return out.join("\n");
}

function overallSection(done: Entry[]): string[] {
  const lines = ["\u{1F3C6} <b>OVERALL</b>"];

  if (OVERALL_MODE === "raw") {
    const sorted = [...done].sort((a, b) => b.score - a.score).slice(0, 10);
    sorted.forEach((e, i) =>
      lines.push(`${rank(i)} ${TIER_EMOJI[e.tier]} ${escapeHtml(e.name)} — <b>${fmt(e.score)}</b>`)
    );
    return lines;
  }

  // "relative": rank by distance from each tier's own average, so a standout
  // cheap place can beat a merely-decent fancy one.
  const means = new Map<Tier, number>();
  for (const tier of TIERS) {
    const t = done.filter((e) => e.tier === tier);
    if (t.length) means.set(tier, t.reduce((s, e) => s + e.score, 0) / t.length);
  }
  const sorted = done
    .map((e) => ({ ...e, delta: e.score - (means.get(e.tier) ?? e.score) }))
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 10);

  lines.push("<i>ranked vs. the average for their own tier</i>");
  sorted.forEach((e, i) =>
    lines.push(
      `${rank(i)} ${TIER_EMOJI[e.tier]} ${escapeHtml(e.name)} — <b>${signed(e.delta)}</b> <i>(${fmt(e.score)})</i>`
    )
  );
  return lines;
}

function progressLine(r: ScoredRow, names: Map<number, string>): string {
  const bits: string[] = [];
  for (const [id, name] of names) {
    const mine = r.ratings.find((x) => x.telegram_id === id);
    const n = mine ? CATEGORIES.filter((c) => mine[c] !== null).length : 0;
    bits.push(`${escapeHtml(name)} ${n}/4`);
  }
  return bits.join(" · ") || "not started";
}

/** Rewrites the pinned board in place. Safe to call after every change. */
export async function refreshBoard(bot: Bot, sb: SupabaseClient, chatId: number) {
  const board = await getBoard(sb, chatId);
  if (!board) return;
  try {
    await bot.api.editMessageText(chatId, board.message_id, await renderBoard(sb, chatId), {
      parse_mode: "HTML",
    });
  } catch (e: any) {
    // Telegram rejects byte-identical edits. Harmless.
    if (!String(e?.description ?? "").includes("message is not modified")) throw e;
  }
}

/** The reveal, once you've both finished. */
export function revealText(
  name: string,
  tier: Tier,
  visited: string | null,
  ratings: Rating[],
  names: Map<number, string>
): string {
  const lines = [
    `${TIER_EMOJI[tier]} <b>${escapeHtml(name)}</b> · <i>${TIER_LABEL[tier]}</i>`,
  ];
  if (visited) lines.push(`<i>${visited}</i>`);
  lines.push("");

  const header = CATEGORIES.map((c) => CATEGORY_LABEL[c].slice(0, 3)).join("  ");
  lines.push(`<code>          ${header}</code>`);
  for (const r of ratings) {
    const who = (names.get(r.telegram_id) ?? "?").slice(0, 9).padEnd(9);
    const cells = CATEGORIES.map((c) => String(r[c]).padStart(3).padEnd(5)).join("");
    lines.push(`<code>${escapeHtml(who)} ${cells}</code>`);
  }
  lines.push("");

  for (const r of ratings) {
    const who = names.get(r.telegram_id) ?? "?";
    lines.push(`${escapeHtml(who)}: <b>${fmt(combinedScore([r], tier))}</b>`);
  }

  if (ratings.length >= 2) {
    lines.push("", `<b>Combined: ${fmt(combinedScore(ratings, tier))}</b>`);
    const gap = disagreement(ratings, tier);
    if (gap >= GAP_FLAG) lines.push(`\u26A1 You were ${fmt(gap)} apart on this one.`);
  }
  return lines.join("\n");
}
