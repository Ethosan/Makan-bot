import type { Env } from "./db";

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
