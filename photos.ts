import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "./db";

/**
 * Copies a Telegram photo into Supabase Storage so the Netlify site can show
 * it without the bot token. Returns the public URL, or null if it didn't work
 * — the bot's own cards still render from the file id either way.
 */
export async function mirrorToStorage(
  sb: SupabaseClient,
  env: Env,
  fileId: string,
  restaurantId: number
): Promise<string | null> {
  try {
    const meta = await fetch(
      `https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`
    ).then((r) => r.json() as Promise<any>);
    if (!meta?.ok || !meta.result?.file_path) return null;

    const path: string = meta.result.file_path;
    const upstream = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${path}`);
    if (!upstream.ok) return null;

    const ext = (path.split(".").pop() ?? "jpg").toLowerCase();
    const key = `${restaurantId}-${Date.now()}.${ext}`;
    const bytes = new Uint8Array(await upstream.arrayBuffer());

    const { error } = await sb.storage.from("photos").upload(key, bytes, {
      contentType: upstream.headers.get("content-type") ?? "image/jpeg",
      upsert: true,
    });
    if (error) return null;

    return sb.storage.from("photos").getPublicUrl(key).data.publicUrl;
  } catch {
    return null;
  }
}

/**
 * Telegram file URLs need the bot token and expire after about an hour, so the
 * site can't link them directly. This proxies them and caches the bytes at the
 * edge — the file id is stable even though the URL isn't.
 */
export async function servePhoto(fileId: string, env: Env, request: Request): Promise<Response> {
  const cache = (caches as any).default as Cache;
  const cacheKey = new Request(new URL(request.url).toString(), { method: "GET" });

  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const meta = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`
  ).then((r) => r.json() as Promise<any>);

  if (!meta?.ok || !meta.result?.file_path) {
    return new Response("photo unavailable", { status: 404 });
  }

  const upstream = await fetch(
    `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${meta.result.file_path}`
  );
  if (!upstream.ok) return new Response("photo unavailable", { status: 404 });

  const response = new Response(upstream.body, {
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "image/jpeg",
      "cache-control": "public, max-age=604800",
    },
  });

  await cache.put(cacheKey, response.clone());
  return response;
}
