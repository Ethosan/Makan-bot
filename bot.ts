import { Bot, Context, InlineKeyboard } from "grammy";
import {
  addRestaurant,
  allWithRatings,
  createDraft,
  db,
  deleteDraft,
  deleteRestaurant,
  draftAwaitingPhoto,
  draftById,
  draftByPrompt,
  findRestaurant,
  getBoard,
  peopleMap,
  ratingsFor,
  restaurantByCard,
  restaurantById,
  setBoard,
  setCardMessage,
  setCategory,
  setPhoto,
  undoLast,
  updateDraft,
  upsertPerson,
  type Env,
  type Restaurant,
} from "./db";
import { escapeHtml, refreshBoard, renderBoard, revealText } from "./leaderboard";
import { mirrorToStorage } from "./photos";
import {
  CATEGORY_HINT,
  CATEGORY_LABEL,
  TIERS,
  TIER_EMOJI,
  TIER_LABEL,
  WEIGHTS,
  answeredCount,
  isComplete,
  nextCategory,
  parseTier,
  type Rating,
} from "./scoring";
import {
  NAME_PROMPT,
  dateKeyboard,
  datePanel,
  photoKeyboard,
  photoPanel,
  ratingCard,
  scoreKeyboard,
  tapToast,
  tierKeyboard,
  tierPanel,
} from "./wizard";

/** Your local clock, for the Today / Yesterday buttons. SGT = 8. */
const TZ_OFFSET_HOURS = 8;

function localDate(daysAgo = 0): string {
  const t = Date.now() + TZ_OFFSET_HOURS * 3600_000 - daysAgo * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

const HELP = `${TIER_EMOJI.fancy} <b>Restaurant list</b>

<b>/add</b> — walk through adding a place, tap by tap. This is the main one.
<b>/rate <i>name</i></b> — bring back a place's rating card
<b>/list</b> — everything, with ids
<b>/todo</b> — what's still waiting on you
<b>/board</b> — print the leaderboard
<b>/site</b> — link to the web version, with photos
<b>/setboard</b> — post &amp; pin the auto-updating board here
<b>/when <i>name</i> 2025-12-02</b> — set a date you skipped
<b>photo</b> — reply to a card with one, or caption it <code>/photo <i>name</i></code>. Only one of you needs to.
<b>/weights</b> — how each tier is scored
<b>/remove <i>name</i></b> — delete an entry

<i>Faster, if you're backfilling a batch:</i>
<code>/quickadd Odette | fancy | 2025-12-02</code>
<code>/bulk</code> then one place per line`;

export function createBot(env: Env): Bot {
  const bot = new Bot(env.BOT_TOKEN);
  const sb = db(env);

  bot.use(async (ctx, next) => {
    if (ctx.from && !ctx.from.is_bot) {
      await upsertPerson(sb, ctx.from.id, ctx.from.first_name ?? "Someone");
    }
    await next();
  });

  const reply = (ctx: Context, text: string, kb?: InlineKeyboard) =>
    ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: kb,
      message_thread_id: ctx.message?.message_thread_id,
      link_preview_options: { is_disabled: true },
    });

  /**
   * Posts a rating card. Photo cards are sent as photos from the start, since
   * Telegram won't let you edit a text message into a media one.
   */
  async function postCard(
    chatId: number,
    threadId: number | null,
    restaurant: Restaurant
  ): Promise<number> {
    const ratings = await ratingsFor(sb, restaurant.id);
    const names = await peopleMap(sb);
    const body = ratingCard(restaurant, ratings, names);
    const kb = scoreKeyboard(restaurant.id, ratings.some((r) => answeredCount(r) > 0));
    const opts = {
      parse_mode: "HTML" as const,
      reply_markup: kb,
      message_thread_id: threadId ?? undefined,
    };

    let msg;
    if (restaurant.photo_file_id) {
      try {
        msg = await bot.api.sendPhoto(chatId, restaurant.photo_file_id, { ...opts, caption: body });
      } catch {
        // File ids from image documents aren't valid for sendPhoto.
        msg = await bot.api.sendDocument(chatId, restaurant.photo_file_id, { ...opts, caption: body });
      }
    } else {
      msg = await bot.api.sendMessage(chatId, body, opts);
    }

    await setCardMessage(sb, restaurant.id, msg.message_id);
    return msg.message_id;
  }

  /** Swaps a card out for a fresh one — used when a photo arrives after the fact. */
  async function replaceCard(chatId: number, threadId: number | null, restaurant: Restaurant) {
    if (restaurant.card_message_id) {
      try {
        await bot.api.deleteMessage(chatId, restaurant.card_message_id);
      } catch {
        // Older than 48h or already gone. Not worth failing over.
      }
    }
    await postCard(chatId, threadId, restaurant);
  }

  /* ---------------- basics ---------------- */

  bot.command(["start", "help"], (ctx) => reply(ctx, HELP));

  bot.command("weights", (ctx) =>
    reply(
      ctx,
      [
        "How each tier is scored:",
        "",
        ...TIERS.map((t) => {
          const w = WEIGHTS[t];
          return `${TIER_EMOJI[t]} <b>${TIER_LABEL[t]}</b> — food ${w.food * 100}% · ambiance ${
            w.ambiance * 100
          }% · aesthetics ${w.aesthetics * 100}% · service ${w.service * 100}%`;
        }),
      ].join("\n")
    )
  );

  bot.command("board", async (ctx) => reply(ctx, await renderBoard(sb, ctx.chat.id)));

  bot.command("site", (ctx) => {
    if (!env.SITE_URL) {
      return reply(
        ctx,
        "No site URL set yet. Add a <code>SITE_URL</code> variable in Cloudflare with your worker address."
      );
    }
    const link = env.SITE_KEY
      ? `${env.SITE_URL}?k=${encodeURIComponent(env.SITE_KEY)}`
      : env.SITE_URL;
    return ctx.reply(`\u{1F517} <a href="${link}">The List</a>`, {
      parse_mode: "HTML",
      message_thread_id: ctx.message?.message_thread_id,
    });
  });

  bot.command("setboard", async (ctx) => {
    // Clear out the previous board so repeat runs don't leave dead copies behind.
    const existing = await getBoard(sb, ctx.chat.id);
    if (existing) {
      try {
        await ctx.api.unpinChatMessage(ctx.chat.id, existing.message_id);
      } catch {
        /* wasn't pinned */
      }
      try {
        await ctx.api.deleteMessage(ctx.chat.id, existing.message_id);
      } catch {
        /* too old, or already gone */
      }
    }

    const msg = await ctx.reply(await renderBoard(sb, ctx.chat.id), {
      parse_mode: "HTML",
      message_thread_id: ctx.message?.message_thread_id,
    });
    await setBoard(sb, ctx.chat.id, ctx.message?.message_thread_id ?? null, msg.message_id);

    try {
      await ctx.api.pinChatMessage(ctx.chat.id, msg.message_id, { disable_notification: true });
    } catch (e: any) {
      // Don't fail silently — an unpinned board looks like the command did nothing.
      await reply(
        ctx,
        "Board posted, but I couldn't pin it — I need to be an <b>admin</b> here with " +
          "<b>Pin Messages</b> enabled.\n\n<i>It'll still keep itself up to date. Grant the " +
          "permission and run /setboard again to pin it.</i>"
      );
      console.error("pin failed", e?.description ?? e);
    }
  });

  bot.command("list", async (ctx) => {
    const rows = await allWithRatings(sb, ctx.chat.id);
    if (!rows.length) return reply(ctx, "Empty so far. /add to start.");
    const lines = rows
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(
        (r) =>
          `<code>${r.id}</code> ${TIER_EMOJI[r.tier]} ${escapeHtml(r.name)}` +
          (r.complete.length >= 2 ? " ✓" : ` <i>(${r.ratings.length ? "part-rated" : "unrated"})</i>`)
      );
    return reply(ctx, lines.join("\n"));
  });

  bot.command("todo", async (ctx) => {
    const rows = await allWithRatings(sb, ctx.chat.id);
    const mine = rows.filter((r) => {
      const own = r.ratings.find((x) => x.telegram_id === ctx.from!.id) ?? null;
      return !own || !isComplete(own);
    });
    if (!mine.length) return reply(ctx, "You're all caught up. ✅");
    return reply(
      ctx,
      [
        "Still needs you:",
        ...mine.map((r) => {
          const own = r.ratings.find((x) => x.telegram_id === ctx.from!.id) ?? null;
          return `<code>${r.id}</code> ${escapeHtml(r.name)} — ${answeredCount(own)}/4`;
        }),
        "",
        "<code>/rate <i>name</i></code> to open a card.",
      ].join("\n")
    );
  });

  /* ---------------- add wizard ---------------- */

  bot.command("add", async (ctx) => {
    const draft = await createDraft(
      sb,
      ctx.chat.id,
      ctx.message?.message_thread_id ?? null,
      ctx.from!.id
    );
    const prompt = await ctx.reply(NAME_PROMPT, {
      parse_mode: "HTML",
      message_thread_id: ctx.message?.message_thread_id,
      reply_markup: { force_reply: true, input_field_placeholder: "Restaurant name" },
    });
    await updateDraft(sb, draft.id, { prompt_message_id: prompt.message_id });
  });

  // Step 1 lands here: a reply to the bot's name prompt.
  bot.on("message:text", async (ctx, next) => {
    const replyTo = ctx.message.reply_to_message?.message_id;
    if (!replyTo) return next();
    const draft = await draftByPrompt(sb, ctx.chat.id, replyTo);
    if (!draft || draft.step !== "name") return next();

    const name = ctx.message.text.trim();
    if (!name) return;

    await updateDraft(sb, draft.id, { name, step: "tier" });
    const panel = await ctx.reply(tierPanel(name), {
      parse_mode: "HTML",
      message_thread_id: draft.thread_id ?? undefined,
      reply_markup: tierKeyboard(draft.id),
    });
    await updateDraft(sb, draft.id, { panel_message_id: panel.message_id });
  });

  // Step 2: tier chosen.
  bot.callbackQuery(/^t:(\d+):(cheap|normal|fancy)$/, async (ctx) => {
    const draftId = Number(ctx.match![1]);
    const tier = ctx.match![2] as "cheap" | "normal" | "fancy";
    const draft = await draftById(sb, draftId);
    if (!draft) return ctx.answerCallbackQuery({ text: "That draft's gone. /add again." });

    await updateDraft(sb, draftId, { tier, step: "date" });
    await ctx.editMessageText(datePanel(draft.name ?? "", tier), {
      parse_mode: "HTML",
      reply_markup: dateKeyboard(draftId),
    });
    return ctx.answerCallbackQuery();
  });

  // Step 3: date chosen -> create the place and drop the rating card.
  bot.callbackQuery(/^d:(\d+):(today|yday|skip)$/, async (ctx) => {
    const draftId = Number(ctx.match![1]);
    const when = ctx.match![2];
    const draft = await draftById(sb, draftId);
    if (!draft?.name || !draft.tier) {
      return ctx.answerCallbackQuery({ text: "That draft's gone. /add again." });
    }

    const visited = when === "today" ? localDate(0) : when === "yday" ? localDate(1) : null;
    const { restaurant, error } = await addRestaurant(sb, {
      chat_id: draft.chat_id,
      name: draft.name,
      tier: draft.tier,
      visited_on: visited,
    });
    await deleteDraft(sb, draftId);

    if (error || !restaurant) {
      await ctx.editMessageText(`Couldn't add it — ${escapeHtml(error ?? "unknown error")}.`, {
        parse_mode: "HTML",
      });
      return ctx.answerCallbackQuery();
    }

    await updateDraft(sb, draftId, { step: "photo", restaurant_id: restaurant.id });
    await ctx.editMessageText(photoPanel(restaurant.name, restaurant.tier), {
      parse_mode: "HTML",
      reply_markup: photoKeyboard(draftId),
    });
    await refreshBoard(bot, sb, draft.chat_id);
    return ctx.answerCallbackQuery({ text: "Added. Photo next \u2014 or skip." });
  });

  // Step 4: skipped the photo. Drop a plain text card.
  bot.callbackQuery(/^p:(\d+):skip$/, async (ctx) => {
    const draftId = Number(ctx.match![1]);
    const draft = await draftById(sb, draftId);
    const restaurant = draft?.restaurant_id ? await restaurantById(sb, draft.restaurant_id) : null;
    if (!restaurant) return ctx.answerCallbackQuery({ text: "That draft's gone." });

    await deleteDraft(sb, draftId);
    const names = await peopleMap(sb);
    await ctx.editMessageText(ratingCard(restaurant, [], names), {
      parse_mode: "HTML",
      reply_markup: scoreKeyboard(restaurant.id, false),
    });
    await setCardMessage(sb, restaurant.id, ctx.callbackQuery.message!.message_id);
    return ctx.answerCallbackQuery({ text: "Both of you tap your scores." });
  });

  bot.callbackQuery(/^x:(\d+)$/, async (ctx) => {
    await deleteDraft(sb, Number(ctx.match![1]));
    await ctx.editMessageText("Cancelled.");
    return ctx.answerCallbackQuery();
  });

  /* ---------------- photos ---------------- */

  // Three ways in: mid-wizard, replying to a card, or a photo captioned /photo <name>.
  bot.on(["message:photo", "message:document"], async (ctx, next) => {
    // Photos sent as files arrive as documents, so accept image documents too.
    const photo = ctx.message.photo?.[ctx.message.photo.length - 1];
    const doc = ctx.message.document;
    const fileId = photo
      ? photo.file_id
      : doc?.mime_type?.startsWith("image/")
        ? doc.file_id
        : null;
    if (!fileId) return next();
    const threadId = ctx.message.message_thread_id ?? null;

    const pending = await draftAwaitingPhoto(sb, ctx.chat.id, ctx.from!.id);
    if (pending?.restaurant_id) {
      const restaurant = await restaurantById(sb, pending.restaurant_id);
      if (restaurant) {
        await setPhoto(sb, restaurant.id, fileId, await mirrorToStorage(sb, env, fileId, restaurant.id));
        await deleteDraft(sb, pending.id);
        if (pending.panel_message_id) {
          try {
            await ctx.api.deleteMessage(ctx.chat.id, pending.panel_message_id);
          } catch {
            /* ignore */
          }
        }
        await postCard(ctx.chat.id, pending.thread_id ?? threadId, {
          ...restaurant,
          photo_file_id: fileId,
        });
        return;
      }
    }

    const repliedTo = ctx.message.reply_to_message?.message_id;
    if (repliedTo) {
      const restaurant = await restaurantByCard(sb, ctx.chat.id, repliedTo);
      if (restaurant) {
        await setPhoto(sb, restaurant.id, fileId, await mirrorToStorage(sb, env, fileId, restaurant.id));
        await replaceCard(ctx.chat.id, threadId, { ...restaurant, photo_file_id: fileId });
        return;
      }
    }

    const caption = ctx.message.caption ?? "";
    const m = caption.match(/^\/photo(?:@\S+)?\s+(.+)$/i);
    if (m) {
      const restaurant = await findRestaurant(sb, ctx.chat.id, m[1]);
      if (!restaurant) {
        return reply(ctx, `Nothing matches "${escapeHtml(m[1])}".`);
      }
      await setPhoto(sb, restaurant.id, fileId, await mirrorToStorage(sb, env, fileId, restaurant.id));
      await replaceCard(ctx.chat.id, threadId, { ...restaurant, photo_file_id: fileId });
      return;
    }

    return next();
  });

  bot.command("photo", (ctx) =>
    reply(
      ctx,
      "Send the photo with <code>/photo Odette</code> as its caption, or just reply to that place's card with a photo."
    )
  );

  bot.command("unphoto", async (ctx) => {
    const ref = (ctx.match as string)?.trim();
    if (!ref) return reply(ctx, "Usage: <code>/unphoto Odette</code>");
    const restaurant = await findRestaurant(sb, ctx.chat.id, ref);
    if (!restaurant) return reply(ctx, "Nothing matches that.");
    await setPhoto(sb, restaurant.id, null, null);
    await replaceCard(ctx.chat.id, ctx.message?.message_thread_id ?? null, {
      ...restaurant,
      photo_file_id: null,
    });
    return reply(ctx, `Photo removed from <b>${escapeHtml(restaurant.name)}</b>.`);
  });

  /* ---------------- rating taps ---------------- */

  bot.callbackQuery(/^r:(\d+):(\d+)$/, async (ctx) => {
    const restaurantId = Number(ctx.match![1]);
    const value = Number(ctx.match![2]);
    const restaurant = await restaurantById(sb, restaurantId);
    if (!restaurant) return ctx.answerCallbackQuery({ text: "That entry's gone." });

    const existing = (await ratingsFor(sb, restaurantId)).find(
      (r) => r.telegram_id === ctx.from.id
    ) ?? null;
    const category = nextCategory(existing);
    if (!category) {
      return ctx.answerCallbackQuery({
        text: "You've already done all four. Undo if you want to change one.",
        show_alert: true,
      });
    }

    const updated = await setCategory(sb, restaurantId, ctx.from.id, category, value);
    const next = nextCategory(updated);
    await redrawCard(ctx, restaurant, restaurantId);

    const toast = tapToast(
      CATEGORY_LABEL[category],
      value,
      next ? `${CATEGORY_LABEL[next]} — ${CATEGORY_HINT[next]}` : null
    );
    return ctx.answerCallbackQuery({ text: toast });
  });

  bot.callbackQuery(/^u:(\d+)$/, async (ctx) => {
    const restaurantId = Number(ctx.match![1]);
    const restaurant = await restaurantById(sb, restaurantId);
    if (!restaurant) return ctx.answerCallbackQuery({ text: "That entry's gone." });

    const updated = await undoLast(sb, restaurantId, ctx.from.id);
    await redrawCard(ctx, restaurant, restaurantId);
    const next = nextCategory(updated);
    return ctx.answerCallbackQuery({
      text: next ? `Cleared. Back to ${CATEGORY_LABEL[next]}.` : "Nothing to undo.",
    });
  });

  /** Redraws the card, or flips it to the reveal once you've both finished. */
  async function redrawCard(ctx: Context, restaurant: Restaurant, restaurantId: number) {
    const ratings = await ratingsFor(sb, restaurantId);
    const names = await peopleMap(sb);
    const done = ratings.filter(isComplete) as Rating[];
    const needed = Math.max(2, names.size);

    const hasPhoto = Boolean(restaurant.photo_file_id);

    if (done.length >= needed) {
      const body =
        "\u{1F513} <b>Both in.</b>\n\n" +
        revealText(restaurant.name, restaurant.tier, restaurant.visited_on, done, names);
      // Photo cards are media messages, so their text lives in the caption.
      if (hasPhoto) await ctx.editMessageCaption({ caption: body, parse_mode: "HTML" });
      else await ctx.editMessageText(body, { parse_mode: "HTML" });
    } else {
      const mine = ratings.some((r) => answeredCount(r) > 0);
      const body = ratingCard(restaurant, ratings, names);
      const kb = scoreKeyboard(restaurantId, mine);
      if (hasPhoto) {
        await ctx.editMessageCaption({ caption: body, parse_mode: "HTML", reply_markup: kb });
      } else {
        await ctx.editMessageText(body, { parse_mode: "HTML", reply_markup: kb });
      }
    }
    await refreshBoard(bot, sb, restaurant.chat_id);
  }

  /* ---------------- reopening a card ---------------- */

  bot.command("rate", async (ctx) => {
    const ref = (ctx.match as string)?.trim();
    if (!ref) return reply(ctx, "Usage: <code>/rate Odette</code> — or just <code>/todo</code>.");
    const restaurant = await findRestaurant(sb, ctx.chat.id, ref);
    if (!restaurant) return reply(ctx, `Nothing matches "${escapeHtml(ref)}".`);

    const ratings = await ratingsFor(sb, restaurant.id);
    const names = await peopleMap(sb);
    const done = ratings.filter(isComplete) as Rating[];

    if (done.length >= Math.max(2, names.size)) {
      const body = revealText(restaurant.name, restaurant.tier, restaurant.visited_on, done, names);
      if (restaurant.photo_file_id) {
        return ctx.api.sendPhoto(ctx.chat.id, restaurant.photo_file_id, {
          caption: body,
          parse_mode: "HTML",
          message_thread_id: ctx.message?.message_thread_id,
        });
      }
      return reply(ctx, body);
    }
    return postCard(ctx.chat.id, ctx.message?.message_thread_id ?? null, restaurant);
  });

  bot.command("when", async (ctx) => {
    const args = (ctx.match as string)?.trim() ?? "";
    const m = args.match(/^(.*?)\s+(\d{4}-\d{2}-\d{2})$/);
    if (!m) return reply(ctx, "Usage: <code>/when Odette 2025-12-02</code>");
    const restaurant = await findRestaurant(sb, ctx.chat.id, m[1]);
    if (!restaurant) return reply(ctx, "Nothing matches that.");
    await sb.from("restaurants").update({ visited_on: m[2] }).eq("id", restaurant.id);
    await refreshBoard(bot, sb, ctx.chat.id);
    return reply(ctx, `<b>${escapeHtml(restaurant.name)}</b> → ${m[2]}`);
  });

  bot.command("remove", async (ctx) => {
    const ref = (ctx.match as string)?.trim();
    if (!ref) return reply(ctx, "Usage: <code>/remove Odette</code>");
    const restaurant = await findRestaurant(sb, ctx.chat.id, ref);
    if (!restaurant) return reply(ctx, "Nothing matches that.");
    await deleteRestaurant(sb, restaurant.id);
    await refreshBoard(bot, sb, ctx.chat.id);
    return reply(ctx, `Removed <b>${escapeHtml(restaurant.name)}</b>.`);
  });

  /* ---------------- batch fast paths ---------------- */

  bot.command("quickadd", async (ctx) => {
    const args = (ctx.match as string)?.trim();
    if (!args) return reply(ctx, "Usage: <code>/quickadd Odette | fancy | 2025-12-02</code>");
    const [name, rawTier, rawDate] = args.split("|").map((s) => s.trim());
    const tier = rawTier ? parseTier(rawTier) : "normal";
    if (!name || !tier) return reply(ctx, "Need a name, and a tier of cheap / normal / fancy.");
    const date = rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null;

    const { restaurant, error } = await addRestaurant(sb, {
      chat_id: ctx.chat.id,
      name,
      tier,
      visited_on: date,
    });
    if (error || !restaurant) return reply(ctx, `Couldn't add it — ${escapeHtml(error ?? "?")}.`);

    await postCard(ctx.chat.id, ctx.message?.message_thread_id ?? null, restaurant);
    await refreshBoard(bot, sb, ctx.chat.id);
  });

  bot.command("bulk", async (ctx) => {
    const lines = ((ctx.match as string) ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return reply(ctx, "Put one place per line under the /bulk command.");

    const added: string[] = [];
    const skipped: string[] = [];
    for (const line of lines) {
      const [name, rawTier, rawDate] = line.split("|").map((s) => s.trim());
      const tier = rawTier ? parseTier(rawTier) : "normal";
      if (!name || !tier) {
        skipped.push(line);
        continue;
      }
      const date = rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null;
      const { restaurant, error } = await addRestaurant(sb, {
        chat_id: ctx.chat.id,
        name,
        tier,
        visited_on: date,
      });
      if (error || !restaurant) skipped.push(`${line} (${error})`);
      else added.push(`<code>${restaurant.id}</code> ${escapeHtml(restaurant.name)}`);
    }

    await refreshBoard(bot, sb, ctx.chat.id);
    const out = [`Added ${added.length}:`, ...added];
    if (skipped.length) out.push("", `Skipped ${skipped.length}:`, ...skipped.map(escapeHtml));
    out.push("", "<code>/todo</code> to see what needs rating, then <code>/rate <i>name</i></code>.");
    return reply(ctx, out.join("\n"));
  });

  bot.catch((err) => console.error("bot error", err));
  return bot;
}
