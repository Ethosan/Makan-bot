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
import { combinedScore, fmt } from "./scoring";
import { mirrorToStorage } from "./photos";
import {
  GOAL_CAP,
  addGoal,
  carryDepth,
  currentCycle,
  dropGoal,
  goalById,
  goalsOf,
  latestStatus,
  monthOf,
  setCheckin,
  startCycle,
  type GoalKind,
  type Outcome,
  type Status,
} from "./goals";
import {
  checkinList,
  cycleCard,
  outcomeKeyboard,
  reviewPrompt,
  statusPrompt,
} from "./goalcards";
import {
  KIND_EMOJI,
  KIND_LABEL,
  addPlan,
  addPlanPhoto,
  dropPlan,
  guessKind,
  parseDate,
  parseTimeText,
  planById,
  plans,
  type PlanKind,
} from "./plans";
import {
  addWant,
  dropWant,
  parseWantLine,
  pick,
  pickWeighted,
  rollKeyboard,
  rollText,
  wantById,
  wantListText,
  wants,
} from "./wishlist";
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
  type Tier,
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

const HELP = `${TIER_EMOJI.fancy} <b>The List</b>

Most of the time you'll want the app \u2014 <b>/site</b> opens it, and everything below can be done there too.

<b><u>Places you've been</u></b>
<b>/add</b> \u2014 the wizard: name, tier, date, photo, then scores
<b>/rate <i>name</i></b> \u2014 reopen a place's rating card
<b>/todo</b> \u2014 what's still waiting on you
<b>/list</b> \u2014 everything, with ids
<b>/board</b> \u2014 print the leaderboard
<b>/when <i>name</i> 2025-12-02</b> \u2014 set a date you skipped
<b>/visit <i>name</i> | 120 | me</b> \u2014 been again. Bill and payer optional; leave the payer out if you split. Doesn't move the score.
<b>/order <i>name</i> | <i>what to get</i></b> \u2014 note for next time
<b>/remove <i>name</i></b> \u2014 delete an entry

<b><u>Bookings</u></b>
<b>/book <i>name</i> | 12 Sep 7.30pm | 2 pax</b> \u2014 or forward the confirmation and reply to it with <code>/book <i>name</i></code>
<b>/bookings</b> \u2014 what's coming up
<b>/unbook <i>id</i></b> \u2014 cancel one
<i>I'll nudge the day before and a few hours ahead, then ask how it was.</i>

<b><u>Four-month goals</u></b>
<b>/cycle</b> \u2014 the current cycle and where everything stands
<b>/newcycle</b> \u2014 start a four-month cycle
<b>/goal <i>title</i> | <i>how you'll know</i> | <i>what might stop it</i></b> \u2014 <code>shared</code> first for a joint one
<b>/checkin</b> \u2014 update where each goal is
<b>/review</b> \u2014 the end-of-cycle questions
<b>/close</b> \u2014 grade it and open the next one

<b><u>Upcoming</u></b>
<b>/plan <i>title</i> | 12 Sep | 7.30pm</b> \u2014 or reply to a screenshot with <code>/plan <i>title</i></code> and I'll read the date off it and keep the image
<b>/plan list</b> \u2014 everything planned

<b><u>Places you want to go</u></b>
<b>/want <i>name</i></b> \u2014 add one, or paste a whole list under the command, one per line. <code>| cheap</code> on the end tags the tier; anything in (brackets) becomes a note.
<b>/wants</b> \u2014 the whole want list
<b>/random</b> \u2014 pick somewhere new. <code>/random cheap</code> to narrow it.
<b>/again</b> \u2014 pick somewhere you've been, weighted towards what you rated highly. <code>/again fancy</code> to narrow it.

<b><u>Photos</u></b>
Reply to any card with a photo, or send one captioned <code>/photo <i>name</i></code>. Only one of you needs to.
Send the logo captioned <code>/logo <i>name</i></code> \u2014 that's what shows in the list.
<b>/unphoto <i>name</i></b> \u2014 take it off again

<b><u>Setup</u></b>
<b>/site</b> \u2014 open the app
<b>/setboard</b> \u2014 post &amp; pin the auto-updating board in this topic
<b>/weights</b> \u2014 how each tier is scored`;

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
    const m = caption.match(/^\/(photo|logo)(?:@\S+)?\s+(.+)$/i);
    if (m) {
      const slot = m[1].toLowerCase() === "logo" ? "logo" : "food";
      const restaurant = await findRestaurant(sb, ctx.chat.id, m[2]);
      if (!restaurant) {
        return reply(ctx, `Nothing matches "${escapeHtml(m[2])}".`);
      }
      const url = await mirrorToStorage(sb, env, fileId, restaurant.id);
      await setPhoto(sb, restaurant.id, fileId, url, slot);
      if (slot === "logo") {
        return reply(ctx, `Logo set for <b>${escapeHtml(restaurant.name)}</b>.`);
      }
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

  // The logo is what fronts the list, so it gets its own command.
  bot.command("logo", (ctx) =>
    reply(
      ctx,
      "Send the logo with <code>/logo Odette</code> as its caption, or reply to that place's card with one and add <code>logo</code> to the caption."
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

  // Repeat visits deliberately don't move the score.
  bot.command(["visit", "beenagain"], async (ctx) => {
    const raw = (ctx.match as string)?.trim();
    const ref = raw?.split("|")[0].trim();
    if (!ref) return reply(ctx, "Usage: <code>/visit Odette</code>, or <code>/visit Odette | 120 | me</code>");
    const restaurant = await findRestaurant(sb, ctx.chat.id, ref);
    if (!restaurant) return reply(ctx, `Nothing matches "${escapeHtml(ref)}".`);

    // Optional bill: /visit Odette | 120  (add "me" to say you paid it)
    const [, ...rest] = (ctx.match as string).split("|").map((x) => x.trim());
    const tail = rest.join(" ");
    const money = tail.match(/(\d+(?:\.\d{1,2})?)/);
    const iPaid = /\b(me|mine|i did)\b/i.test(tail);

    await sb.from("visits").insert({
      restaurant_id: restaurant.id,
      on_date: localDate(0),
      by_id: ctx.from?.id ?? null,
      amount: money ? Number(money[1]) : null,
      paid_by: iPaid ? ctx.from?.id ?? null : null,
    });
    const { data } = await sb.from("visits").select("id").eq("restaurant_id", restaurant.id);
    const n = (data ?? []).length;
    return reply(
      ctx,
      `Logged. You've been to <b>${escapeHtml(restaurant.name)}</b> ${n} time${n === 1 ? "" : "s"}.` +
        "\n<i>Score unchanged \u2014 going back says its own thing.</i>"
    );
  });

  bot.command("order", async (ctx) => {
    const args = (ctx.match as string)?.trim() ?? "";
    const [ref, ...rest] = args.split("|").map((x) => x.trim());
    if (!ref) return reply(ctx, "Usage: <code>/order Odette | bone marrow, skip the pasta</code>");
    const restaurant = await findRestaurant(sb, ctx.chat.id, ref);
    if (!restaurant) return reply(ctx, `Nothing matches "${escapeHtml(ref)}".`);

    const note = rest.join(" | ").trim();
    if (!note) {
      const { data } = await sb.from("restaurants").select("order_note")
        .eq("id", restaurant.id).maybeSingle();
      return reply(
        ctx,
        (data as any)?.order_note
          ? `<b>${escapeHtml(restaurant.name)}</b>\n${escapeHtml((data as any).order_note)}`
          : `Nothing noted for <b>${escapeHtml(restaurant.name)}</b> yet.`
      );
    }
    await sb.from("restaurants").update({ order_note: note }).eq("id", restaurant.id);
    return reply(ctx, `Noted for <b>${escapeHtml(restaurant.name)}</b>.`);
  });

  /* ---------------- want to eat ---------------- */

  bot.command("want", async (ctx) => {
    const args = (ctx.match as string)?.trim();
    const replied = ctx.message?.reply_to_message;

    // Reply to a reel or screenshot with /want and the bot indexes it without
    // you having to retype anything but the name.
    if (!args) {
      return reply(
        ctx,
        "Usage: <code>/want Kok Sen</code>, or <code>/want Kok Sen | cheap</code>.\n" +
          "<i>Reply to a post with it and I'll keep the link to that message.</i>"
      );
    }

    // One line or twenty — paste a whole list and every line becomes an entry.
    const parsed = args.split("\n").map(parseWantLine).filter(Boolean) as {
      name: string;
      tier: Tier | null;
      note: string | null;
    }[];
    if (!parsed.length) return reply(ctx, "Nothing to add there.");

    const added: string[] = [];
    const skipped: string[] = [];
    for (const item of parsed) {
      const { want, error } = await addWant(sb, {
        chat_id: ctx.chat.id,
        name: item.name,
        tier: item.tier,
        note: item.note,
        source_message_id: replied?.message_id ?? null,
        added_by: ctx.from?.id ?? null,
      });
      if (error || !want) skipped.push(`${item.name} \u2014 ${error}`);
      else added.push(want.name);
    }

    if (parsed.length === 1 && added.length === 1) {
      return reply(
        ctx,
        `Added <b>${escapeHtml(added[0])}</b> to the want list` +
          (parsed[0].tier ? ` as <i>${TIER_LABEL[parsed[0].tier!]}</i>.` : ". <i>Tag the tier later if you like.</i>")
      );
    }

    const out = [`Added <b>${added.length}</b> to the want list.`];
    if (skipped.length) out.push("", `Skipped ${skipped.length}:`, ...skipped.map(escapeHtml));
    out.push("", "<code>/wants</code> to see them, <code>/random</code> to pick one.");
    return reply(ctx, out.join("\n"));
  });

  bot.command(["wants", "wishlist"], async (ctx) =>
    reply(ctx, wantListText(await wants(sb, ctx.chat.id)))
  );

  bot.command("random", async (ctx) => {
    const raw = (ctx.match as string)?.trim();
    const tier = raw ? parseTier(raw) : null;
    if (raw && !tier) return reply(ctx, "Try <code>/random</code>, or <code>/random cheap</code>.");
    return roll(ctx, tier);
  });

  async function roll(ctx: Context, tier: Tier | null) {
    const list = await wants(sb, ctx.chat!.id, tier);
    const chosen = pick(list);
    if (!chosen) {
      return reply(
        ctx,
        tier
          ? `Nothing tagged <i>${TIER_LABEL[tier]}</i> on the want list yet.`
          : "The want list is empty. Add one with <code>/want Name</code>."
      );
    }
    return ctx.reply(rollText(chosen, tier), {
      parse_mode: "HTML",
      message_thread_id: ctx.message?.message_thread_id,
      reply_markup: rollKeyboard(chosen, tier),
    });
  }

  // The other roll: somewhere you've already been and liked.
  bot.command(["again", "revisit"], async (ctx) => {
    const raw = (ctx.match as string)?.trim();
    const tier = raw ? parseTier(raw) : null;
    if (raw && !tier) return reply(ctx, "Try <code>/again</code>, or <code>/again fancy</code>.");
    return rollAgain(ctx, tier);
  });

  async function rollAgain(ctx: Context, tier: Tier | null) {
    const rows = await allWithRatings(sb, ctx.chat!.id);
    const names = await peopleMap(sb);
    const needed = Math.max(2, names.size);
    const pool = rows
      .filter((r) => r.complete.length >= needed && (!tier || r.tier === tier))
      .map((r) => ({ row: r, score: combinedScore(r.complete, r.tier) }));

    const chosen = pickWeighted(pool, (p) => p.score);
    if (!chosen) {
      return reply(
        ctx,
        tier
          ? `Nothing fully rated in <i>${TIER_LABEL[tier]}</i> yet.`
          : "Nothing fully rated yet."
      );
    }

    const { row, score } = chosen;
    return ctx.reply(
      [
        `\u{1F501} <b>${escapeHtml(row.name)}</b>`,
        `<i>${TIER_LABEL[row.tier]}</i> \u00b7 you gave it <b>${fmt(score)}</b>`,
        "",
        "<i>weighted towards the ones you rated highly</i>",
      ].join("\n"),
      {
        parse_mode: "HTML",
        message_thread_id: ctx.message?.message_thread_id,
        reply_markup: new InlineKeyboard().text("\u{1F3B2} Again", `g:${tier ?? "any"}`),
      }
    );
  }

  bot.callbackQuery(/^g:(cheap|normal|fancy|any)$/, async (ctx) => {
    const raw = ctx.match![1];
    const tier = raw === "any" ? null : (raw as Tier);
    const rows = await allWithRatings(sb, ctx.chat!.id);
    const names = await peopleMap(sb);
    const needed = Math.max(2, names.size);
    const pool = rows
      .filter((r) => r.complete.length >= needed && (!tier || r.tier === tier))
      .map((r) => ({ row: r, score: combinedScore(r.complete, r.tier) }));
    const chosen = pickWeighted(pool, (p) => p.score);
    if (!chosen) return ctx.answerCallbackQuery({ text: "Nothing to pick from." });

    await ctx.editMessageText(
      [
        `\u{1F501} <b>${escapeHtml(chosen.row.name)}</b>`,
        `<i>${TIER_LABEL[chosen.row.tier]}</i> \u00b7 you gave it <b>${fmt(chosen.score)}</b>`,
        "",
        "<i>weighted towards the ones you rated highly</i>",
      ].join("\n"),
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("\u{1F3B2} Again", `g:${raw}`) }
    );
    return ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^w:roll:(cheap|normal|fancy|any)$/, async (ctx) => {
    const raw = ctx.match![1];
    const tier = raw === "any" ? null : (raw as Tier);
    const list = await wants(sb, ctx.chat!.id, tier);
    const chosen = pick(list.length > 1 ? list.filter((w) => !ctx.callbackQuery.message?.text?.includes(w.name)) : list)
      ?? pick(list);
    if (!chosen) return ctx.answerCallbackQuery({ text: "Nothing left to pick from." });

    await ctx.editMessageText(rollText(chosen, tier), {
      parse_mode: "HTML",
      reply_markup: rollKeyboard(chosen, tier),
    });
    return ctx.answerCallbackQuery();
  });

  // "We went" moves it off the want list and straight onto the rating card.
  bot.callbackQuery(/^w:went:(\d+)$/, async (ctx) => {
    const want = await wantById(sb, Number(ctx.match![1]));
    if (!want) return ctx.answerCallbackQuery({ text: "Already gone from the list." });

    const { restaurant, error } = await addRestaurant(sb, {
      chat_id: want.chat_id,
      name: want.name,
      tier: want.tier ?? "normal",
      visited_on: localDate(0),
    });
    if (error || !restaurant) {
      return ctx.answerCallbackQuery({ text: `Couldn't add it \u2014 ${error}`, show_alert: true });
    }

    await dropWant(sb, want.id);
    await ctx.editMessageText(
      `\u2705 <b>${escapeHtml(want.name)}</b> moved off the want list.` +
        (want.tier ? "" : "\n<i>Filed as Normal \u2014 change it on the card if that's wrong.</i>"),
      { parse_mode: "HTML" }
    );
    await postCard(want.chat_id, ctx.callbackQuery.message?.message_thread_id ?? null, restaurant);
    await refreshBoard(bot, sb, want.chat_id);
    return ctx.answerCallbackQuery({ text: "Now rate it." });
  });

  bot.callbackQuery(/^w:drop:(\d+)$/, async (ctx) => {
    const want = await wantById(sb, Number(ctx.match![1]));
    if (!want) return ctx.answerCallbackQuery({ text: "Already gone." });
    await dropWant(sb, want.id);
    await ctx.editMessageText(`Took <b>${escapeHtml(want.name)}</b> off the want list.`, {
      parse_mode: "HTML",
    });
    return ctx.answerCallbackQuery();
  });

  /* ---------------- upcoming ---------------- */

  bot.command(["plan", "upcoming"], async (ctx) => {
    const args = (ctx.match as string)?.trim() ?? "";
    const replied = ctx.message?.reply_to_message as any;
    const from = replied ? (replied.text ?? replied.caption ?? "") : "";

    if (!args && !from) {
      return reply(
        ctx,
        [
          "Usage: <code>/plan Odette | 12 Sep | 7.30pm</code>",
          "",
          "<i>Or reply to a screenshot you've already sent with</i> <code>/plan Odette</code><i> \u2014 I'll read the date off it and keep the image.</i>",
          "",
          "<code>/upcoming list</code> for everything planned.",
        ].join("\n")
      );
    }

    if (args.toLowerCase() === "list") {
      const list = await plans(sb, ctx.chat.id);
      if (!list.length) return reply(ctx, "Nothing planned yet.");
      return reply(
        ctx,
        ["\u{1F5D3}\uFE0F <b>UPCOMING</b>", "", ...list.map((p) => {
          const when = p.on_date
            ? `${p.on_date}${p.at_time ? ` \u00b7 ${p.at_time}` : ""}`
            : p.when_text ?? "date TBC";
          return `${KIND_EMOJI[p.kind]} <b>${escapeHtml(p.title)}</b>\n<i>${escapeHtml(when)}</i>` +
            (p.photos.length ? ` \u00b7 ${p.photos.length} \u{1F4CE}` : "");
        })].join("\n\n")
      );
    }

    const parts = args.split("|").map((x) => x.trim()).filter(Boolean);
    const title = parts[0] || "Untitled";
    const rest = parts.slice(1).join(" ");

    // The typed args win; anything missing gets read off the screenshot.
    const onDate = parseDate(rest) ?? (from ? parseDate(from) : null);
    const atTime = parseTimeText(rest) ?? (from ? parseTimeText(from) : null);
    const kind: PlanKind = guessKind(`${title} ${rest} ${from}`);

    const plan = await addPlan(sb, {
      chat_id: ctx.chat.id,
      title,
      kind,
      on_date: onDate,
      at_time: atTime,
      // Unparseable dates aren't an error \u2014 they're the normal early state.
      when_text: onDate ? null : rest || null,
      is_food: kind === "booking",
    });
    if (!plan) return reply(ctx, "Couldn't save that.");

    // Keep the screenshot with the plan, so it's findable later.
    let attached = 0;
    const photo = replied?.photo?.[replied.photo.length - 1];
    if (photo) {
      const url = await mirrorToStorage(sb, env, photo.file_id, plan.id);
      if (url) { await addPlanPhoto(sb, plan.id, url); attached = 1; }
    }

    const when = onDate
      ? `${onDate}${atTime ? ` \u00b7 ${atTime}` : ""}`
      : plan.when_text ?? "date TBC";
    return ctx.reply(
      [
        `${KIND_EMOJI[kind]} <b>${escapeHtml(title)}</b>`,
        `<i>${escapeHtml(when)}</i> \u00b7 ${KIND_LABEL[kind]}`,
        attached ? "\n<i>Screenshot saved with it.</i>" : "",
        !onDate ? "\n<i>No date yet \u2014 add one in the app when you know.</i>" : "",
      ].filter(Boolean).join("\n"),
      {
        parse_mode: "HTML",
        message_thread_id: ctx.message?.message_thread_id,
        reply_markup: new InlineKeyboard().text("\u2715 Remove", `pl:drop:${plan.id}`),
      }
    );
  });

  bot.callbackQuery(/^pl:drop:(\d+)$/, async (ctx) => {
    const plan = await planById(sb, Number(ctx.match![1]));
    if (!plan) return ctx.answerCallbackQuery({ text: "Already gone." });
    await dropPlan(sb, plan.id);
    await ctx.editMessageText(`Removed <b>${escapeHtml(plan.title)}</b>.`, { parse_mode: "HTML" });
    return ctx.answerCallbackQuery();
  });

  /* ---------------- four-month goals ---------------- */

  bot.command(["cycle", "goals"], async (ctx) => {
    const cycle = await currentCycle(sb, ctx.chat.id);
    if (!cycle) {
      return reply(
        ctx,
        "No cycle running. <code>/newcycle</code> starts a four-month one from this month."
      );
    }
    const goals = await goalsOf(sb, cycle.id);
    const names = await peopleMap(sb);
    return reply(ctx, cycleCard(cycle, goals, names));
  });

  bot.command("newcycle", async (ctx) => {
    const existing = await currentCycle(sb, ctx.chat.id);
    if (existing) {
      return reply(
        ctx,
        `<b>${escapeHtml(existing.name)}</b> is still running \u2014 <code>/close</code> it first.`
      );
    }
    const cycle = await startCycle(sb, ctx.chat.id);
    if (!cycle) return reply(ctx, "Couldn't start a cycle.");
    return reply(
      ctx,
      [
        `\u{1F3AF} <b>${escapeHtml(cycle.name)}</b> is open.`,
        `<i>${cycle.starts_on} to ${cycle.ends_on}</i>`,
        "",
        `${GOAL_CAP} goals each, plus any you share. Add them with:`,
        "<code>/goal Run a sub-55 10k | three runs a week by Dec | outcome</code>",
        "<code>/goal shared Cook at home 4 nights a week</code>",
        "",
        "<i>I'll ask for a check-in on the 1st of each month.</i>",
      ].join("\n")
    );
  });

  bot.command("goal", async (ctx) => {
    const cycle = await currentCycle(sb, ctx.chat.id);
    if (!cycle) return reply(ctx, "No cycle running. <code>/newcycle</code> first.");

    let args = (ctx.match as string)?.trim() ?? "";
    if (!args) {
      return reply(
        ctx,
        [
          "<code>/goal <i>title</i> | <i>how you'll know</i> | <i>what might stop it</i></code>",
          "",
          "Put <code>shared</code> first for one you both own.",
          "Add <code>process</code> or <code>stop</code> at the end to mark the type \u2014 default is an outcome.",
        ].join("\n")
      );
    }

    let ownerId: number | null = ctx.from!.id;
    if (/^shared\b/i.test(args)) {
      ownerId = null;
      args = args.replace(/^shared\b[:\s]*/i, "");
    }

    let kind: GoalKind = "outcome";
    if (/\bprocess\s*$/i.test(args)) { kind = "process"; args = args.replace(/\|?\s*process\s*$/i, ""); }
    else if (/\bstop\s*$/i.test(args)) { kind = "stop"; args = args.replace(/\|?\s*stop\s*$/i, ""); }

    const [title, measure, risk] = args.split("|").map((x) => x.trim());
    if (!title) return reply(ctx, "Needs a title.");

    const existing = await goalsOf(sb, cycle.id);
    const mine = existing.filter((g) => g.owner_id === ownerId);
    if (mine.length >= GOAL_CAP) {
      return reply(
        ctx,
        `That's already ${GOAL_CAP} ${ownerId === null ? "shared goals" : "goals"} for this cycle.\n` +
          "<i>The cap is the point \u2014 drop one first with</i> <code>/dropgoal</code><i>.</i>"
      );
    }

    const goal = await addGoal(sb, {
      cycle_id: cycle.id,
      chat_id: ctx.chat.id,
      owner_id: ownerId,
      title,
      kind,
      measure: measure || null,
      risk: risk || null,
    });
    if (!goal) return reply(ctx, "Couldn't save that.");

    const warn = !measure
      ? "\n\n<i>No measure set. If you can't answer it yes or no in four months, it's a wish \u2014 add one by editing in the app.</i>"
      : !risk
        ? "\n\n<i>Worth adding what might stop it \u2014 that line is the useful half at review.</i>"
        : "";

    return reply(
      ctx,
      `Added <b>${escapeHtml(title)}</b>${ownerId === null ? " <i>(shared)</i>" : ""}.` + warn
    );
  });

  bot.command("dropgoal", async (ctx) => {
    const cycle = await currentCycle(sb, ctx.chat.id);
    if (!cycle) return reply(ctx, "No cycle running.");
    const goals = await goalsOf(sb, cycle.id);
    const ref = (ctx.match as string)?.trim().toLowerCase();
    const goal = goals.find((g) => g.title.toLowerCase().includes(ref ?? "\u0000"));
    if (!ref || !goal) {
      return reply(
        ctx,
        ["Usage: <code>/dropgoal <i>part of the title</i></code>", "", ...goals.map((g) => `\u2022 ${escapeHtml(g.title)}`)].join("\n")
      );
    }
    await dropGoal(sb, goal.id);
    return reply(ctx, `Dropped <b>${escapeHtml(goal.title)}</b>.`);
  });

  bot.command("checkin", async (ctx) => {
    const cycle = await currentCycle(sb, ctx.chat.id);
    if (!cycle) return reply(ctx, "No cycle running.");
    const goals = await goalsOf(sb, cycle.id);
    if (!goals.length) return reply(ctx, "No goals to check in on yet.");
    const names = await peopleMap(sb);
    const { text, keyboard } = checkinList(goals, names);
    return ctx.reply(text, {
      parse_mode: "HTML",
      message_thread_id: ctx.message?.message_thread_id,
      reply_markup: keyboard,
    });
  });

  bot.callbackQuery(/^ci:pick:(\d+)$/, async (ctx) => {
    const goal = await goalById(sb, Number(ctx.match![1]));
    if (!goal) return ctx.answerCallbackQuery({ text: "Gone." });
    const { text, keyboard } = statusPrompt(goal);
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
    return ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^ci:set:(\d+):(on_track|slipping|stalled|done)$/, async (ctx) => {
    const goalId = Number(ctx.match![1]);
    await setCheckin(sb, goalId, ctx.match![2] as Status, ctx.from.id);
    const goal = await goalById(sb, goalId);
    if (!goal) return ctx.answerCallbackQuery();

    const cycle = await currentCycle(sb, ctx.chat!.id);
    const goals = cycle ? await goalsOf(sb, cycle.id) : [];
    const names = await peopleMap(sb);
    const { text, keyboard } = checkinList(goals, names);
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });

    // A goal carried through several cycles is worth naming out loud.
    const depth = await carryDepth(sb, goal);
    if (depth >= 2) {
      await ctx.reply(
        `<i>${escapeHtml(goal.title)} has carried through ${depth} cycles now. ` +
          "Worth asking whether it's actually a goal.</i>",
        { parse_mode: "HTML", message_thread_id: ctx.callbackQuery.message?.message_thread_id }
      );
    }
    return ctx.answerCallbackQuery({ text: "Noted." });
  });

  bot.callbackQuery("ci:back", async (ctx) => {
    const cycle = await currentCycle(sb, ctx.chat!.id);
    const goals = cycle ? await goalsOf(sb, cycle.id) : [];
    const names = await peopleMap(sb);
    const { text, keyboard } = checkinList(goals, names);
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
    return ctx.answerCallbackQuery();
  });

  bot.command("review", async (ctx) => {
    const cycle = await currentCycle(sb, ctx.chat.id);
    if (!cycle) return reply(ctx, "No cycle running.");
    const goals = await goalsOf(sb, cycle.id);
    await reply(ctx, reviewPrompt(cycle, goals));
    for (const g of goals.filter((x) => !x.outcome)) {
      await ctx.reply(
        `<b>${escapeHtml(g.title)}</b>` + (g.measure ? `\n<i>${escapeHtml(g.measure)}</i>` : ""),
        {
          parse_mode: "HTML",
          message_thread_id: ctx.message?.message_thread_id,
          reply_markup: outcomeKeyboard(g),
        }
      );
    }
  });

  bot.callbackQuery(/^rv:(done|partial|dropped|missed):(\d+)$/, async (ctx) => {
    const outcome = ctx.match![1] as Outcome;
    const goal = await goalById(sb, Number(ctx.match![2]));
    if (!goal) return ctx.answerCallbackQuery({ text: "Gone." });
    await sb.from("goals").update({ outcome }).eq("id", goal.id);
    const label = { done: "\u2705 Done", partial: "\u{1F7E1} Partly there",
                    dropped: "\u{1F5D1}\uFE0F Dropped on purpose", missed: "\u274C Missed" }[outcome];
    await ctx.editMessageText(`<b>${escapeHtml(goal.title)}</b>\n${label}`, { parse_mode: "HTML" });
    return ctx.answerCallbackQuery();
  });

  bot.command("close", async (ctx) => {
    const cycle = await currentCycle(sb, ctx.chat.id);
    if (!cycle) return reply(ctx, "No cycle running.");
    const goals = await goalsOf(sb, cycle.id);
    const unset = goals.filter((g) => !g.outcome);
    if (unset.length) {
      return reply(
        ctx,
        `Still ungraded: ${unset.map((g) => escapeHtml(g.title)).join(", ")}.\n` +
          "<i>Run /review first \u2014 the grading is the point.</i>"
      );
    }
    await sb.from("cycles").update({ closed: true }).eq("id", cycle.id);
    const next = await startCycle(sb, ctx.chat.id);
    const carry = goals.filter((g) => g.outcome === "partial");
    return reply(
      ctx,
      [
        `<b>${escapeHtml(cycle.name)}</b> closed.`,
        next ? `\n\u{1F3AF} <b>${escapeHtml(next.name)}</b> is open.` : "",
        carry.length
          ? `\n<i>Partly done last time: ${carry.map((g) => escapeHtml(g.title)).join(", ")}. ` +
            "Carry them over with /goal if they're still worth it.</i>"
          : "",
      ].filter(Boolean).join("\n")
    );
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
