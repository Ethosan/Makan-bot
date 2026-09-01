import type { SupabaseClient } from "@supabase/supabase-js";

export type PlanKind = "booking" | "tickets" | "trip" | "plan";

export const KIND_LABEL: Record<PlanKind, string> = {
  booking: "Booking",
  tickets: "Tickets",
  trip: "Trip",
  plan: "Plan",
};

export const KIND_EMOJI: Record<PlanKind, string> = {
  booking: "\u{1F37D}\uFE0F",
  tickets: "\u{1F39F}\uFE0F",
  trip: "\u2708\uFE0F",
  plan: "\u{1F4CC}",
};

export interface Plan {
  id: number;
  chat_id: number;
  title: string;
  kind: PlanKind;
  on_date: string | null;
  at_time: string | null;
  when_text: string | null;
  note: string | null;
  photos: string[];
  is_food: boolean;
  archived: boolean;
}

/** Your local clock, for working out what "tomorrow" means. SGT = 8. */
const TZ = 8;

const MONTHS = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
const DAYS = ["sun","mon","tue","wed","thu","fri","sat"];

function localNow(): Date {
  return new Date(Date.now() + TZ * 3600_000);
}

function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Finds a calendar date in free text. Deliberately date-only: a plan's time is
 * kept as whatever you typed ("7.30pm", "doors 8"), because half of them don't
 * have a precise time and forcing one makes the thing annoying to use.
 */
export function parseDate(input: string): string | null {
  const text = input.toLowerCase().replace(/\u00a0/g, " ");
  const now = localNow();

  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const dmy = text.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
  if (dmy) {
    const year = dmy[3]
      ? (dmy[3].length === 2 ? 2000 + Number(dmy[3]) : Number(dmy[3]))
      : now.getUTCFullYear();
    return ymd(year, Number(dmy[2]) - 1, Number(dmy[1]));
  }

  const dm = text.match(/\b(\d{1,2})\s*(?:st|nd|rd|th)?\s+([a-z]{3,9})\b/);
  const md = text.match(/\b([a-z]{3,9})\s+(\d{1,2})\s*(?:st|nd|rd|th)?\b/);
  for (const pair of [dm ? [dm[1], dm[2]] : null, md ? [md[2], md[1]] : null]) {
    if (!pair) continue;
    const mi = MONTHS.indexOf(pair[1].slice(0, 3));
    if (mi === -1) continue;
    let year = now.getUTCFullYear();
    if (mi < now.getUTCMonth() - 1) year += 1; // a month already gone means next year
    return ymd(year, mi, Number(pair[0]));
  }

  if (/\btomorrow\b|\btmr\b/.test(text)) {
    const d = new Date(now.getTime() + 86_400_000);
    return ymd(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  if (/\btoday\b|\btonight\b/.test(text)) {
    return ymd(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  }

  const wd = text.match(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/);
  if (wd) {
    let delta = (DAYS.indexOf(wd[1]) - now.getUTCDay() + 7) % 7;
    if (delta === 0) delta = 7;
    const d = new Date(now.getTime() + delta * 86_400_000);
    return ymd(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }

  return null;
}

/** Pulls a time out of text and returns it as written, not normalised. */
export function parseTimeText(input: string): string | null {
  const m = input.match(/\b\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)\b/i) ?? input.match(/\b([01]?\d|2[0-3])[:.][0-5]\d\b/);
  return m ? m[0].trim() : null;
}

export function guessKind(text: string): PlanKind {
  const t = text.toLowerCase();
  if (/\bflight|hotel|airbnb|trip|itinerary|boarding\b/.test(t)) return "trip";
  if (/\bticket|seat|screening|concert|show|gig|match\b/.test(t)) return "tickets";
  if (/\breserv|booking|table|dining|restaurant|confirmed for\b/.test(t)) return "booking";
  return "plan";
}

/* ---------------- queries ---------------- */

export async function addPlan(
  sb: SupabaseClient,
  row: Partial<Plan> & { chat_id: number; title: string }
): Promise<Plan | null> {
  const { data } = await sb.from("plans").insert(row).select().single();
  return (data as Plan) ?? null;
}

export async function plans(sb: SupabaseClient, chatId: number): Promise<Plan[]> {
  const { data } = await sb
    .from("plans")
    .select("*")
    .eq("chat_id", chatId)
    .eq("archived", false)
    .order("on_date", { ascending: true, nullsFirst: false });
  return (data ?? []).map((p: any) => ({ ...p, id: Number(p.id), photos: p.photos ?? [] })) as Plan[];
}

export async function planById(sb: SupabaseClient, id: number): Promise<Plan | null> {
  const { data } = await sb.from("plans").select("*").eq("id", id).maybeSingle();
  return data ? ({ ...data, id: Number(data.id), photos: (data as any).photos ?? [] } as Plan) : null;
}

export async function addPlanPhoto(sb: SupabaseClient, id: number, url: string) {
  const plan = await planById(sb, id);
  if (!plan) return;
  await sb.from("plans").update({ photos: [...plan.photos, url] }).eq("id", id);
}

export async function dropPlan(sb: SupabaseClient, id: number) {
  await sb.from("plans").delete().eq("id", id);
}
