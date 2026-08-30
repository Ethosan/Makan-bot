import { webhookCallback } from "grammy";
import { createBot } from "./bot";
import type { Env } from "./db";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") return new Response("ok");

    if (url.pathname !== "/webhook" || request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }

    // Telegram echoes back the secret you set when registering the webhook.
    if (request.headers.get("x-telegram-bot-api-secret-token") !== env.WEBHOOK_SECRET) {
      return new Response("unauthorized", { status: 401 });
    }

    const bot = createBot(env);
    return webhookCallback(bot, "cloudflare-mod")(request);
  },
};
