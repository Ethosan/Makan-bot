import { InlineKeyboard } from "grammy";
import type { PartialRating, Tier } from "./scoring";
import {
  CATEGORIES,
  CATEGORY_HINT,
  CATEGORY_LABEL,
  TIERS,
  TIER_EMOJI,
  TIER_LABEL,
  answeredCount,
  nextCategory,
} from "./scoring";
import { escapeHtml } from "./leaderboard";
import type { Restaurant } from "./db";

/* ---------------- add wizard ---------------- */

export const NAME_PROMPT =
  "\u{1F37D}\uFE0F <b>New place</b>\n\nReply to this message with the name.";

export function tierKeyboard(draftId: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const t of TIERS) kb.text(`${TIER_EMOJI[t]} ${TIER_LABEL[t]}`, `t:${draftId}:${t}`).row();
  return kb.text("\u2715 Cancel", `x:${draftId}`);
}

export function tierPanel(name: string): string {
  return [
    `\u{1F37D}\uFE0F <b>${escapeHtml(name)}</b>`,
    "",
    "What kind of place was it?",
    "",
    "<i>This decides how the four scores get weighted, and which list it ranks in.</i>",
  ].join("\n");
}

export function dateKeyboard(draftId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("Today", `d:${draftId}:today`)
    .text("Yesterday", `d:${draftId}:yday`)
    .row()
    .text("Skip \u2014 don't remember", `d:${draftId}:skip`)
    .row()
    .text("\u2715 Cancel", `x:${draftId}`);
}

export function datePanel(name: string, tier: Tier): string {
  return [
    `${TIER_EMOJI[tier]} <b>${escapeHtml(name)}</b> \u00b7 <i>${TIER_LABEL[tier]}</i>`,
    "",
    "When did you go?",
    "",
    "<i>Backfilling something older? Skip, then set it later with /when.</i>",
  ].join("\n");
}

export function photoKeyboard(draftId: number): InlineKeyboard {
  return new InlineKeyboard().text("Skip \u2014 no photo", `p:${draftId}:skip`);
}

export function photoPanel(name: string, tier: Tier): string {
  return [
    `${TIER_EMOJI[tier]} <b>${escapeHtml(name)}</b> \u00b7 <i>${TIER_LABEL[tier]}</i>`,
    "",
    "Send a photo now and it'll go on the card.",
    "",
    "<i>If nothing happens, reply directly to this message with the photo.</i>",
    "",
    "<i>Just one between you \u2014 whoever has the better shot. You can also add or change it later by replying to the card with a photo.</i>",
  ].join("\n");
}

/* ---------------- rating card ---------------- */

const FILLED = "\u25CF";
const EMPTY = "\u25CB";

export function scoreKeyboard(restaurantId: number, anyProgress: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (let n = 1; n <= 5; n++) kb.text(String(n), `r:${restaurantId}:${n}`);
  kb.row();
  for (let n = 6; n <= 10; n++) kb.text(String(n), `r:${restaurantId}:${n}`);
  if (anyProgress) kb.row().text("\u21A9 Undo my last", `u:${restaurantId}`);
  return kb;
}

/**
 * The live card. Shows each person's progress as dots without leaking any
 * numbers — the scores stay sealed until you've both finished.
 */
export function ratingCard(
  restaurant: Restaurant,
  ratings: PartialRating[],
  names: Map<number, string>
): string {
  const lines = [
    `${TIER_EMOJI[restaurant.tier]} <b>${escapeHtml(restaurant.name)}</b> \u00b7 <i>${
      TIER_LABEL[restaurant.tier]
    }</i>`,
  ];
  if (restaurant.visited_on) lines.push(`<i>${restaurant.visited_on}</i>`);
  lines.push("");

  const entries = names.size ? [...names.entries()] : [];
  if (!entries.length) {
    lines.push("<i>Tap a number to start.</i>");
  } else {
    for (const [id, name] of entries) {
      const mine = ratings.find((r) => r.telegram_id === id) ?? null;
      const n = answeredCount(mine);
      const dots = CATEGORIES.map((_, i) => (i < n ? FILLED : EMPTY)).join("");
      const next = nextCategory(mine);
      const label = next ? CATEGORY_LABEL[next] : "done \u2713";
      lines.push(
        `<code>${escapeHtml(name.slice(0, 10).padEnd(10))}</code> ${dots}  ${
          next ? `\u2192 ${label}` : `<b>${label}</b>`
        }`
      );
    }
  }

  lines.push("", "<i>Tap 1\u201310 for whichever category you're on. Order: food, ambiance, aesthetics, service.</i>");
  return lines.join("\n");
}

/** Short toast after a tap — the only place the category hint appears. */
export function tapToast(justAnswered: string, value: number, next: string | null): string {
  if (!next) return `${justAnswered} ${value} \u2713  \u2014 that's all four from you.`;
  return `${justAnswered} ${value} \u2713  \u2192 next: ${next}`;
}

export function hintFor(category: keyof typeof CATEGORY_HINT): string {
  return CATEGORY_HINT[category];
}
