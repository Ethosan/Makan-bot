import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { CATEGORIES, isComplete, type Category, type PartialRating, type Rating, type Tier } from "./scoring";

export interface Restaurant {
  id: number;
  chat_id: number;
  name: string;
  tier: Tier;
  visited_on: string | null;
  photo_file_id: string | null;
  photo_url: string | null;
  card_message_id: number | null;
}

export interface Draft {
  id: number;
  chat_id: number;
  thread_id: number | null;
  user_id: number;
  prompt_message_id: number | null;
  panel_message_id: number | null;
  restaurant_id: number | null;
  name: string | null;
  tier: Tier | null;
  step: "name" | "tier" | "date" | "photo";
}

export interface Env {
  BOT_TOKEN: string;
  SITE_TOKEN?: string;
  WEBHOOK_SECRET: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  /** Optional. Shown by /site so you can pin the link in the group. */
  SITE_URL?: string;
  /** Optional. If set, the site and its photos require ?k=<this value>. */
  SITE_KEY?: string;
  /** Optional. Lets the Netlify site tell the bot to redraw its pinned board. */
  REFRESH_SECRET?: string;
}

export function db(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });
}

/* ---------- people ---------- */

export async function upsertPerson(sb: SupabaseClient, id: number, name: string) {
  await sb.from("people").upsert({ telegram_id: id, display_name: name });
}

export async function peopleMap(sb: SupabaseClient): Promise<Map<number, string>> {
  const { data } = await sb.from("people").select("telegram_id, display_name");
  return new Map((data ?? []).map((p) => [Number(p.telegram_id), p.display_name as string]));
}

/* ---------- drafts ---------- */

export async function createDraft(
  sb: SupabaseClient,
  chatId: number,
  threadId: number | null,
  userId: number
): Promise<Draft> {
  const { data } = await sb
    .from("drafts")
    .insert({ chat_id: chatId, thread_id: threadId, user_id: userId, step: "name" })
    .select()
    .single();
  return data as Draft;
}

export async function updateDraft(sb: SupabaseClient, id: number, patch: Partial<Draft>) {
  await sb.from("drafts").update(patch).eq("id", id);
}

export async function draftById(sb: SupabaseClient, id: number): Promise<Draft | null> {
  const { data } = await sb.from("drafts").select("*").eq("id", id).maybeSingle();
  return (data as Draft) ?? null;
}

/** The one open draft waiting on a photo from this person. */
export async function draftAwaitingPhoto(
  sb: SupabaseClient,
  chatId: number,
  userId: number
): Promise<Draft | null> {
  const { data } = await sb
    .from("drafts")
    .select("*")
    .eq("chat_id", chatId)
    .eq("user_id", userId)
    .eq("step", "photo")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as Draft) ?? null;
}

export async function draftByPrompt(
  sb: SupabaseClient,
  chatId: number,
  promptMessageId: number
): Promise<Draft | null> {
  const { data } = await sb
    .from("drafts")
    .select("*")
    .eq("chat_id", chatId)
    .eq("prompt_message_id", promptMessageId)
    .maybeSingle();
  return (data as Draft) ?? null;
}

export async function deleteDraft(sb: SupabaseClient, id: number) {
  await sb.from("drafts").delete().eq("id", id);
}

/* ---------- restaurants ---------- */

export async function addRestaurant(
  sb: SupabaseClient,
  row: { chat_id: number; name: string; tier: Tier; visited_on?: string | null }
): Promise<{ restaurant?: Restaurant; error?: string }> {
  const { data, error } = await sb
    .from("restaurants")
    .insert({ ...row, visited_on: row.visited_on ?? null })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") return { error: "that one's already on the list" };
    return { error: error.message };
  }
  return { restaurant: data as Restaurant };
}

export async function restaurantById(sb: SupabaseClient, id: number): Promise<Restaurant | null> {
  const { data } = await sb.from("restaurants").select("*").eq("id", id).maybeSingle();
  return (data as Restaurant) ?? null;
}

export async function findRestaurant(
  sb: SupabaseClient,
  chatId: number,
  ref: string
): Promise<Restaurant | null> {
  if (/^\d+$/.test(ref.trim())) {
    const { data } = await sb
      .from("restaurants")
      .select("*")
      .eq("chat_id", chatId)
      .eq("id", Number(ref))
      .maybeSingle();
    if (data) return data as Restaurant;
  }
  const { data } = await sb
    .from("restaurants")
    .select("*")
    .eq("chat_id", chatId)
    .ilike("name", ref.trim())
    .limit(1)
    .maybeSingle();
  return (data as Restaurant) ?? null;
}

export async function setCardMessage(sb: SupabaseClient, id: number, messageId: number) {
  await sb.from("restaurants").update({ card_message_id: messageId }).eq("id", id);
}

export async function setPhoto(
  sb: SupabaseClient,
  id: number,
  fileId: string | null,
  url?: string | null
) {
  await sb.from("restaurants").update({ photo_file_id: fileId, photo_url: url ?? null }).eq("id", id);
}

/**
 * Telegram file ids only resolve inside Telegram, so the web view needs a real
 * URL. Pull the bytes down once and park them in Supabase Storage.
 */
export async function mirrorPhoto(
  sb: SupabaseClient,
  botToken: string,
  restaurantId: number,
  fileId: string
): Promise<string | null> {
  try {
    const metaRes = await fetch(
      `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`
    );
    const meta = (await metaRes.json()) as any;
    const path = meta?.result?.file_path;
    if (!path) return null;

    const fileRes = await fetch(`https://api.telegram.org/file/bot${botToken}/${path}`);
    if (!fileRes.ok) return null;
    const bytes = await fileRes.arrayBuffer();

    const ext = path.split(".").pop()?.toLowerCase() || "jpg";
    const key = `${restaurantId}-${Date.now()}.${ext}`;
    const { error } = await sb.storage.from("photos").upload(key, bytes, {
      contentType: fileRes.headers.get("content-type") ?? "image/jpeg",
      upsert: true,
    });
    if (error) return null;

    return sb.storage.from("photos").getPublicUrl(key).data.publicUrl;
  } catch {
    return null;
  }
}

/** Everything, for the web view. */
export async function allForSite(sb: SupabaseClient): Promise<ScoredRow[]> {
  const { data } = await sb
    .from("restaurants")
    .select(
      "id, name, tier, visited_on, photo_url, ratings(telegram_id, food, ambiance, aesthetics, service)"
    )
    .order("created_at", { ascending: false });

  return (data ?? []).map((r: any) => {
    const ratings = normalise(r.ratings ?? []);
    return {
      id: Number(r.id),
      name: r.name as string,
      tier: r.tier as Tier,
      visited_on: r.visited_on as string | null,
      photo_url: (r.photo_url as string | null) ?? null,
      ratings,
      complete: ratings.filter(isComplete),
    };
  });
}

/** Finds the place whose rating card a user just replied to. */
export async function restaurantByCard(
  sb: SupabaseClient,
  chatId: number,
  messageId: number
): Promise<Restaurant | null> {
  const { data } = await sb
    .from("restaurants")
    .select("*")
    .eq("chat_id", chatId)
    .eq("card_message_id", messageId)
    .maybeSingle();
  return (data as Restaurant) ?? null;
}

export async function deleteRestaurant(sb: SupabaseClient, id: number) {
  await sb.from("restaurants").delete().eq("id", id);
}

/* ---------- ratings ---------- */

function normalise(rows: any[]): PartialRating[] {
  return rows.map((r) => ({
    telegram_id: Number(r.telegram_id),
    food: r.food === null ? null : Number(r.food),
    ambiance: r.ambiance === null ? null : Number(r.ambiance),
    aesthetics: r.aesthetics === null ? null : Number(r.aesthetics),
    service: r.service === null ? null : Number(r.service),
  }));
}

export async function ratingsFor(sb: SupabaseClient, restaurantId: number): Promise<PartialRating[]> {
  const { data } = await sb
    .from("ratings")
    .select("telegram_id, food, ambiance, aesthetics, service")
    .eq("restaurant_id", restaurantId);
  return normalise(data ?? []);
}

/** Writes one category for one person and returns the updated row. */
export async function setCategory(
  sb: SupabaseClient,
  restaurantId: number,
  telegramId: number,
  category: Category,
  value: number | null
): Promise<PartialRating> {
  const { data: existing } = await sb
    .from("ratings")
    .select("telegram_id, food, ambiance, aesthetics, service")
    .eq("restaurant_id", restaurantId)
    .eq("telegram_id", telegramId)
    .maybeSingle();

  const base: any = existing ?? {
    telegram_id: telegramId,
    food: null,
    ambiance: null,
    aesthetics: null,
    service: null,
  };

  const row = {
    restaurant_id: restaurantId,
    telegram_id: telegramId,
    food: base.food,
    ambiance: base.ambiance,
    aesthetics: base.aesthetics,
    service: base.service,
    updated_at: new Date().toISOString(),
  };
  (row as any)[category] = value;

  const { data } = await sb.from("ratings").upsert(row).select().single();
  return normalise([data])[0];
}

/** Clears the most recently answered category, for the undo button. */
export async function undoLast(
  sb: SupabaseClient,
  restaurantId: number,
  telegramId: number
): Promise<PartialRating | null> {
  const { data } = await sb
    .from("ratings")
    .select("telegram_id, food, ambiance, aesthetics, service")
    .eq("restaurant_id", restaurantId)
    .eq("telegram_id", telegramId)
    .maybeSingle();
  if (!data) return null;
  const current = normalise([data])[0];
  const answered = CATEGORIES.filter((c) => current[c] !== null);
  if (!answered.length) return current;
  return setCategory(sb, restaurantId, telegramId, answered[answered.length - 1], null);
}

/* ---------- aggregate ---------- */

export interface ScoredRow {
  id: number;
  name: string;
  tier: Tier;
  visited_on: string | null;
  photo_url?: string | null;
  ratings: PartialRating[];
  complete: Rating[];
}

export async function allWithRatings(sb: SupabaseClient, chatId: number): Promise<ScoredRow[]> {
  const { data } = await sb
    .from("restaurants")
    .select("id, name, tier, visited_on, ratings(telegram_id, food, ambiance, aesthetics, service)")
    .eq("chat_id", chatId);

  return (data ?? []).map((r: any) => {
    const ratings = normalise(r.ratings ?? []);
    return {
      id: Number(r.id),
      name: r.name as string,
      tier: r.tier as Tier,
      visited_on: r.visited_on as string | null,
      ratings,
      complete: ratings.filter(isComplete),
    };
  });
}

/* ---------- board ---------- */

export async function getBoard(sb: SupabaseClient, chatId: number) {
  const { data } = await sb.from("boards").select("*").eq("chat_id", chatId).maybeSingle();
  return data as { chat_id: number; thread_id: number | null; message_id: number } | null;
}

export async function setBoard(
  sb: SupabaseClient,
  chatId: number,
  threadId: number | null,
  messageId: number
) {
  await sb.from("boards").upsert({ chat_id: chatId, thread_id: threadId, message_id: messageId });
}

/** Every chat with a pinned board, for the website's refresh hook. */
export async function allBoardChats(sb: SupabaseClient): Promise<number[]> {
  const { data } = await sb.from("boards").select("chat_id");
  return (data ?? []).map((b: any) => Number(b.chat_id));
}
