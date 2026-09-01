import { InlineKeyboard } from "grammy";
import { escapeHtml } from "./leaderboard";
import {
  GOAL_CAP,
  KIND_LABEL,
  OUTCOME_LABEL,
  STATUS_DOT,
  STATUS_LABEL,
  daysLeft,
  latestStatus,
  monthOf,
  type Cycle,
  type Goal,
  type Status,
} from "./goals";

const STATUSES: Status[] = ["on_track", "slipping", "stalled", "done"];

/** Four dots, one per month of the cycle. Empty means no check-in that month. */
function trail(g: Goal, cycle: Cycle): string {
  const start = new Date(cycle.starts_on + "T00:00:00Z");
  const out: string[] = [];
  for (let i = 0; i < 4; i++) {
    const m = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1))
      .toISOString().slice(0, 10);
    const hit = (g.checkins ?? []).find((c) => c.month === m);
    out.push(hit ? STATUS_DOT[hit.status] : "\u26AA");
  }
  return out.join("");
}

export function cycleCard(
  cycle: Cycle,
  goals: Goal[],
  names: Map<number, string>
): string {
  const lines = [
    `\u{1F3AF} <b>${escapeHtml(cycle.name).toUpperCase()}</b>`,
    `<i>month ${monthOf(cycle)} of 4 \u00b7 ${daysLeft(cycle)} days left</i>`,
    "",
  ];

  const groups: [string, Goal[]][] = [
    ["Together", goals.filter((g) => g.owner_id === null)],
    ...[...names.entries()].map(
      ([id, name]) => [name, goals.filter((g) => g.owner_id === id)] as [string, Goal[]]
    ),
  ];

  for (const [label, list] of groups) {
    if (!list.length) continue;
    lines.push(`<b>${escapeHtml(label)}</b>`);
    for (const g of list) {
      lines.push(`${trail(g, cycle)}  ${escapeHtml(g.title)}`);
      if (g.measure) lines.push(`<i>       ${escapeHtml(g.measure)}</i>`);
    }
    lines.push("");
  }

  if (!goals.length) {
    lines.push(`<i>No goals yet. ${GOAL_CAP} each, plus shared ones.</i>`, "");
  }

  lines.push("<i>/checkin to update \u00b7 /goal to add one</i>");
  return lines.join("\n");
}

export function checkinList(goals: Goal[], names: Map<number, string>): {
  text: string;
  keyboard: InlineKeyboard;
} {
  const month = new Date().toLocaleString("en-GB", { month: "long" });
  const kb = new InlineKeyboard();
  const lines = [
    `\u{1F4CD} <b>${month} check-in</b>`,
    "",
    "<i>Ten minutes. What moved, what didn't, what changes.</i>",
    "",
  ];

  for (const g of goals) {
    const s = latestStatus(g);
    const who = g.owner_id === null ? "Together" : names.get(g.owner_id) ?? "?";
    lines.push(`${s ? STATUS_DOT[s] : "\u26AA"} <b>${escapeHtml(g.title)}</b> \u00b7 <i>${escapeHtml(who)}</i>`);
    kb.text(`${s ? STATUS_DOT[s] : "\u26AA"} ${g.title.slice(0, 26)}`, `ci:pick:${g.id}`).row();
  }

  return { text: lines.join("\n"), keyboard: kb };
}

export function statusPrompt(g: Goal): { text: string; keyboard: InlineKeyboard } {
  const kb = new InlineKeyboard();
  STATUSES.forEach((s, i) => {
    kb.text(`${STATUS_DOT[s]} ${STATUS_LABEL[s]}`, `ci:set:${g.id}:${s}`);
    if (i % 2 === 1) kb.row();
  });
  kb.row().text("\u2190 Back", "ci:back");

  const text = [
    `<b>${escapeHtml(g.title)}</b>`,
    `<i>${KIND_LABEL[g.kind]}</i>`,
    g.measure ? `\nHow you'll know: <i>${escapeHtml(g.measure)}</i>` : "",
    g.risk ? `You said the risk was: <i>${escapeHtml(g.risk)}</i>` : "",
    "",
    "Where is it?",
  ].filter(Boolean).join("\n");

  return { text, keyboard: kb };
}

/** Month two gets a different question: is this still the right goal? */
export function midpointPrompt(cycle: Cycle, goals: Goal[]): string {
  const stalled = goals.filter((g) => latestStatus(g) === "stalled");
  return [
    `\u{1F501} <b>Halfway through ${escapeHtml(cycle.name)}</b>`,
    "",
    "Different question this month: is each of these still worth doing?",
    "",
    "Dropping a goal on purpose is a good outcome. Letting it rot isn't.",
    stalled.length
      ? `\n<i>${stalled.map((g) => escapeHtml(g.title)).join(", ")} ${
          stalled.length === 1 ? "has" : "have"
        } been stalled \u2014 keep or drop?</i>`
      : "",
  ].filter(Boolean).join("\n");
}

export function reviewPrompt(cycle: Cycle, goals: Goal[]): string {
  const done = goals.filter((g) => latestStatus(g) === "done").length;
  return [
    `\u{1F3C1} <b>${escapeHtml(cycle.name)} is up</b>`,
    `<i>${done} of ${goals.length} finished</i>`,
    "",
    "Sit down together and go through these, one goal at a time:",
    "",
    "1. Did it happen? Done, partly, dropped on purpose, or missed.",
    "2. If it didn't \u2014 was the goal wrong, or did you just not do it?",
    "3. You wrote down what would stop each one. Was that what actually stopped it?",
    "4. What carries into the next four months, and what are you letting go?",
    "",
    "<i>/close when you're done, and I'll open the next cycle.</i>",
  ].join("\n");
}

export function outcomeKeyboard(g: Goal): InlineKeyboard {
  return new InlineKeyboard()
    .text("\u2705 Done", `rv:done:${g.id}`)
    .text("\u{1F7E1} Partly", `rv:partial:${g.id}`)
    .row()
    .text("\u{1F5D1}\uFE0F Dropped", `rv:dropped:${g.id}`)
    .text("\u274C Missed", `rv:missed:${g.id}`);
}

export function outcomeLine(g: Goal): string {
  return g.outcome ? `<b>${escapeHtml(g.title)}</b> \u2014 ${OUTCOME_LABEL[g.outcome]}` : "";
}
