import { webhookCallback } from "grammy";
import { createBot } from "./bot";
import { allBoardChats, db, type Env } from "./db";
import { buildPayload } from "./payload";
import { refreshBoard } from "./leaderboard";
import { servePhoto } from "./photos";
import { renderSite } from "./site";
import { InlineKeyboard } from "grammy";
import { currentCycle, goalsOf, monthOf } from "./goals";
import { checkinList, midpointPrompt, reviewPrompt } from "./goalcards";
import { peopleMap } from "./db";

function authorised(url: URL, env: Env): boolean {
  if (!env.SITE_KEY) return true;
  return url.searchParams.get("k") === env.SITE_KEY;
}

/**
 * Monthly nudge. The cadence is the whole feature: people don't fail at the
 * review, they fail in month two. Three different messages depending on where
 * the cycle is - a normal check-in, a "is this still right?" at the halfway
 * mark, and the review prompts at the end.
 */
async function monthlyNudge(env: Env) {
  const sb = db(env);
  const bot = createBot(env);

  const { data: rows } = await sb.from("cycles").select("chat_id").eq("closed", false);
  const chats = [...new Set((rows ?? []).map((r: any) => Number(r.chat_id)))];

  for (const chatId of chats) {
    try {
      const cycle = await currentCycle(sb, chatId);
      if (!cycle) continue;
      const goals = await goalsOf(sb, cycle.id);
      if (!goals.length) continue;

      const month = monthOf(cycle);
      const names = await peopleMap(sb);

      if (month >= 5) {
        await bot.api.sendMessage(chatId, reviewPrompt(cycle, goals), { parse_mode: "HTML" });
        continue;
      }

      if (month === 3) {
        await bot.api.sendMessage(chatId, midpointPrompt(cycle, goals), { parse_mode: "HTML" });
      }

      const { text, keyboard } = checkinList(goals, names);
      await bot.api.sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: keyboard });
    } catch (e) {
      console.error("nudge failed", chatId, e);
    }
  }
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(monthlyNudge(env));
  },

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

    /* ---- redraw the pinned board after an edit made on the website ---- */
    if (url.pathname === "/refresh" && request.method === "POST") {
      if (!env.REFRESH_SECRET || request.headers.get("x-refresh-secret") !== env.REFRESH_SECRET) {
        return new Response("unauthorized", { status: 401 });
      }
      const sb = db(env);
      const bot = createBot(env);
      for (const chatId of await allBoardChats(sb)) {
        await refreshBoard(bot, sb, chatId).catch(() => {});
      }
      return new Response("ok");
    }

    /* ---- photo proxy ---- */
    const photoMatch = url.pathname.match(/^\/photo\/(\d+)$/);
    if (photoMatch) {
      if (!authorised(url, env)) return new Response("unauthorized", { status: 401 });
      const sb = db(env);
      const { data } = await sb
        .from("restaurants")
        .select("photo_file_id, photo_url")
        .eq("id", Number(photoMatch[1]))
        .maybeSingle();
      // Uploaded from the website? It already has a public URL.
      if (data?.photo_url) return Response.redirect(data.photo_url as string, 302);
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
