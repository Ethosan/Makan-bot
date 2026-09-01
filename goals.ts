import type { SupabaseClient } from "@supabase/supabase-js";

export type GoalKind = "outcome" | "process" | "stop";
export type Status = "on_track" | "slipping" | "stalled" | "done";
export type Outcome = "done" | "partial" | "dropped" | "missed";

export const KIND_LABEL: Record<GoalKind, string> = {
  outcome: "Outcome",
  process: "Process",
  stop: "Stop doing",
};

export const STATUS_LABEL: Record<Status, string> = {
  on_track: "On track",
  slipping: "Slipping",
  stalled: "Stalled",
  done: "Done",
};

export const STATUS_DOT: Record<Status, string> = {
  on_track: "\u{1F7E2}",
  slipping: "\u{1F7E1}",
  stalled: "\u{1F534}",
  done: "\u2705",
};

export const OUTCOME_LABEL: Record<Outcome, string> = {
  done: "Done",
  partial: "Partly there",
  dropped: "Dropped on purpose",
  missed: "Missed",
};

/** Three each is the cap. Five means none of them happen. */
export const GOAL_CAP = 3;

export interface Cycle {
  id: number;
  chat_id: number;
  name: string;
  starts_on: string;
  ends_on: string;
  closed: boolean;
}

export interface Goal {
  id: number;
  cycle_id: number;
  chat_id: number;
  owner_id: number | null;
  title: string;
  kind: GoalKind;
  measure: string | null;
  risk: string | null;
  outcome: Outcome | null;
  outcome_note: string | null;
  carried_from: number | null;
  checkins?: { month: string; status: Status; note: string | null }[];
}

const TZ = 8;

export function localToday(): Date {
  return new Date(Date.now() + TZ * 3600_000);
}

export function monthKey(d = localToday()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/** Four months from a start date, ending the day before it recurs. */
export function cycleWindow(start: Date): { starts_on: string; ends_on: string; name: string } {
  const s = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const e = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 4, 0));
  const mon = (d: Date) =>
    ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()];
  return {
    starts_on: s.toISOString().slice(0, 10),
    ends_on: e.toISOString().slice(0, 10),
    name: `${mon(s)}\u2013${mon(e)} ${e.getUTCFullYear()}`,
  };
}

/** Which month of the cycle we're in, 1-4. */
export function monthOf(cycle: Cycle): number {
  const s = new Date(cycle.starts_on + "T00:00:00Z");
  const n = localToday();
  return Math.min(4, Math.max(1,
    (n.getUTCFullYear() - s.getUTCFullYear()) * 12 + (n.getUTCMonth() - s.getUTCMonth()) + 1));
}

export function daysLeft(cycle: Cycle): number {
  const end = new Date(cycle.ends_on + "T23:59:59Z").getTime();
  return Math.ceil((end - localToday().getTime()) / 86_400_000);
}

/* ---------------- queries ---------------- */

export async function currentCycle(sb: SupabaseClient, chatId: number): Promise<Cycle | null> {
  const { data } = await sb
    .from("cycles")
    .select("*")
    .eq("chat_id", chatId)
    .eq("closed", false)
    .order("starts_on", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as Cycle) ?? null;
}

export async function startCycle(
  sb: SupabaseClient,
  chatId: number,
  from = localToday()
): Promise<Cycle | null> {
  const w = cycleWindow(from);
  const { data } = await sb.from("cycles").insert({ chat_id: chatId, ...w }).select().single();
  return (data as Cycle) ?? null;
}

export async function goalsOf(sb: SupabaseClient, cycleId: number): Promise<Goal[]> {
  const { data } = await sb
    .from("goals")
    .select("*, checkins(month, status, note)")
    .eq("cycle_id", cycleId)
    .order("created_at", { ascending: true });
  return (data ?? []).map((g: any) => ({
    ...g,
    id: Number(g.id),
    owner_id: g.owner_id === null ? null : Number(g.owner_id),
    checkins: (g.checkins ?? []).sort((a: any, b: any) => a.month.localeCompare(b.month)),
  })) as Goal[];
}

export async function goalById(sb: SupabaseClient, id: number): Promise<Goal | null> {
  const { data } = await sb
    .from("goals")
    .select("*, checkins(month, status, note)")
    .eq("id", id)
    .maybeSingle();
  if (!data) return null;
  return {
    ...(data as any),
    id: Number((data as any).id),
    owner_id: (data as any).owner_id === null ? null : Number((data as any).owner_id),
    checkins: ((data as any).checkins ?? []).sort((a: any, b: any) => a.month.localeCompare(b.month)),
  } as Goal;
}

export async function addGoal(
  sb: SupabaseClient,
  row: Partial<Goal> & { cycle_id: number; chat_id: number; title: string }
): Promise<Goal | null> {
  const { data } = await sb.from("goals").insert(row).select().single();
  return data ? ({ ...(data as any), id: Number((data as any).id) } as Goal) : null;
}

export async function dropGoal(sb: SupabaseClient, id: number) {
  await sb.from("goals").delete().eq("id", id);
}

export async function setCheckin(
  sb: SupabaseClient,
  goalId: number,
  status: Status,
  byId: number | null,
  note?: string | null
) {
  await sb.from("checkins").upsert(
    { goal_id: goalId, month: monthKey(), status, by_id: byId, note: note ?? null,
      updated_at: new Date().toISOString() },
    { onConflict: "goal_id,month" }
  );
}

export function latestStatus(g: Goal): Status | null {
  const c = g.checkins ?? [];
  return c.length ? c[c.length - 1].status : null;
}

/** How many cycles this goal has already been carried through. */
export async function carryDepth(sb: SupabaseClient, goal: Goal): Promise<number> {
  let depth = 0;
  let id = goal.carried_from;
  while (id && depth < 6) {
    const { data } = await sb.from("goals").select("carried_from").eq("id", id).maybeSingle();
    if (!data) break;
    depth += 1;
    id = (data as any).carried_from;
  }
  return depth;
}
