import { webhookCallback } from "grammy";
import { createBot } from "./bot";
import { db, type Env } from "./db";
import { buildPayload } from "./payload";
import { servePhoto } from "./photos";
import { renderSite } from "./site";

function authorised(url: URL, env: Env): boolean {
  if (!env.SITE_KEY) return true;
  return url.searchParams.get("k") === env.SITE_KEY;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") return new Response("ok");

    /* ---- Telegram webhook ---- */
    if (url.pathname === "/webhook") {
      if (request.method !== "POST") return new Response("not found", { status: 404 });
      if (request.headers.get("x-telegram-bot-api-secret-token") !== env.WEBHOOK_SECRET) {
        return new Response("unauthorized", { status: 401 });
      }
      const bot = createBot(env);
      return webhookCallback(bot, "cloudflare-mod")(request);
    }

    /* ---- photo proxy ---- */
    const photoMatch = url.pathname.match(/^\/photo\/(\d+)$/);
    if (photoMatch) {
      if (!authorised(url, env)) return new Response("unauthorized", { status: 401 });
      const sb = db(env);
      const { data } = await sb
        .from("restaurants")
        .select("photo_file_id")
        .eq("id", Number(photoMatch[1]))
        .maybeSingle();
      if (!data?.photo_file_id) return new Response("no photo", { status: 404 });
      return servePhoto(data.photo_file_id as string, env, request);
    }

    /* ---- the site ---- */
    if (url.pathname === "/") {
      if (!authorised(url, env)) return new Response("unauthorized", { status: 401 });
      const payload = await buildPayload(db(env));
      return new Response(renderSite(payload, env.SITE_KEY ?? ""), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (url.pathname === "/api/list") {
      if (!authorised(url, env)) return new Response("unauthorized", { status: 401 });
      return Response.json(await buildPayload(db(env)));
    }

    return new Response("not found", { status: 404 });
  },
};
