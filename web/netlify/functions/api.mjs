import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

/**
 * Everything the site does goes through here, so the Supabase key never
 * reaches the browser. The password is checked server-side on every call.
 */

const TIERS = ["cheap", "normal", "fancy"];
const TIER_LABEL = { cheap: "Cheap eats", normal: "Normal", fancy: "Fancy" };
const escapeHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const CATS = ["food", "ambiance", "aesthetics", "service"];

const WEIGHTS = {
  cheap:  { food: 0.65, ambiance: 0.15, aesthetics: 0.10, service: 0.10 },
  normal: { food: 0.50, ambiance: 0.20, aesthetics: 0.10, service: 0.20 },
  fancy:  { food: 0.40, ambiance: 0.20, aesthetics: 0.15, service: 0.25 },
};

/** The group this site is bound to. Everything is scoped to it, so the site and
 *  the pinned Telegram board always show the same list. */
/** Fallback tenant, used only by the original shared-password path. */
const legacyChatId = () => Number(process.env.CHAT_ID ?? 0);

/** Web-only pairs get positive ids; Telegram groups are always negative. */
function newPairId() {
  return 1_000_000_000_000 + Math.floor(Math.random() * 900_000_000_000);
}

/**
 * Every member needs a stable numeric id, because that's what a rating is keyed
 * by. Telegram members reuse their Telegram id so nothing has to move; web-only
 * members get one well clear of that range.
 */
async function addMember(db, row) {
  const { data } = await db.from("members").insert(row).select().single();
  const person_id = row.telegram_id ?? 900000000000 + Number(data.id);
  await db.from("members").update({ person_id }).eq("id", data.id);
  // The bot reads names out of `people`, so keep it in step.
  await db.from("people").upsert({ telegram_id: person_id, display_name: row.display_name });
  return person_id;
}

function inviteUrl(request, code) {
  const origin = new URL(request.url).origin;
  return `${origin}/?join=${code}`;
}

function newInviteCode() {
  // No 0/O/1/I — these get read aloud and typed by hand.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () =>
    alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

/**
 * Three ways to prove who you are, in order of strength:
 *   1. Telegram Mini App  — signed by Telegram, tells us the telegram_id
 *   2. Supabase session   — an email account on the website
 *   3. The shared password — the original ETAL setup, kept working as-is
 * Returns the tenant and the member, or null.
 */
async function identify(db, body) {
  const tg = verifyInitData(body.initData);
  if (tg) {
    const { data } = await db.from("members").select("*").eq("telegram_id", tg.id).maybeSingle();
    if (data) return { chat_id: Number(data.chat_id), member: data, via: "telegram" };
    // Known to the bot but not yet in a pair.
    return { chat_id: null, member: null, via: "telegram", telegram: tg };
  }

  if (body.accessToken) {
    const { data: userRes } = await db.auth.getUser(body.accessToken);
    const user = userRes?.user;
    if (user) {
      const { data } = await db.from("members").select("*").eq("auth_id", user.id).maybeSingle();
      if (data) return { chat_id: Number(data.chat_id), member: data, via: "email", user };
      return { chat_id: null, member: null, via: "email", user };
    }
  }

  if (process.env.SITE_PASSWORD && body.password === process.env.SITE_PASSWORD) {
    return { chat_id: legacyChatId(), member: null, via: "password" };
  }

  return null;
}

/** Money is optional everywhere; anything unparseable becomes null, not zero. */
function amountOf(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/**
 * When the site is opened as a Telegram Mini App, Telegram signs a blob telling
 * us exactly who the user is. Verifying it against the bot token is real
 * authentication — better than the shared password, and it means we know which
 * of them is rating without asking.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
function verifyInitData(initData) {
  if (!initData || !process.env.BOT_TOKEN) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const check = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secret = crypto.createHmac("sha256", "WebAppData").update(process.env.BOT_TOKEN).digest();
  const expected = crypto.createHmac("sha256", secret).update(check).digest("hex");

  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  // Reject anything older than a day, so a copied link can't be replayed forever.
  const authDate = Number(params.get("auth_date") ?? 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null;

  try {
    const user = JSON.parse(params.get("user") ?? "null");
    return user?.id ? { id: Number(user.id), name: user.first_name ?? "Someone" } : null;
  } catch {
    return null;
  }
}

/** Posts to the group. Used when something changes on the site. */
async function announce(text, replyMarkup) {
  if (!process.env.BOT_TOKEN || !chatId()) return;
  try {
    await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId(),
        message_thread_id: process.env.TOPIC_ID ? Number(process.env.TOPIC_ID) : undefined,
        text,
        parse_mode: "HTML",
        disable_notification: true,
        link_preview_options: { is_disabled: true },
        reply_markup: replyMarkup,
      }),
    });
  } catch {
    // An announcement failing shouldn't fail the save.
  }
}

const openButton = () =>
  process.env.MINIAPP_URL
    ? { inline_keyboard: [[{ text: "Open the list", url: process.env.MINIAPP_URL }]] }
    : undefined;

const sb = () =>
  createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const personalScore = (r, tier) => CATS.reduce((s, c) => s + Number(r[c]) * WEIGHTS[tier][c], 0);
const complete = (r) => CATS.every((c) => r[c] !== null && r[c] !== undefined);

/** Nudges the bot to redraw its pinned board after a change made here. */
async function pingBot() {
  if (!process.env.WORKER_URL || !process.env.REFRESH_SECRET) return;
  try {
    await fetch(`${process.env.WORKER_URL}/refresh`, {
      method: "POST",
      headers: { "x-refresh-secret": process.env.REFRESH_SECRET },
    });
  } catch {
    // The board catches up on the next Telegram interaction anyway.
  }
}

async function pairInvite(db, chat_id, request) {
  const { data } = await db.from("pairs").select("invite_code").eq("chat_id", chat_id).maybeSingle();
  return data?.invite_code ? inviteUrl(request, data.invite_code) : null;
}

async function pairIsFull(db, chat_id) {
  const { data } = await db.from("members").select("id").eq("chat_id", chat_id);
  return (data ?? []).length >= 2;
}

export default async (request) => {
  // Diagnostic: open /api?diag=1 in a browser. Counts and flags only, no names,
  // no data. Tells us exactly what the function sees rather than what we assume.
  const url = new URL(request.url);
  if (request.method === "GET" && url.searchParams.get("diag")) {
    const db = sb();
    const raw = process.env.CHAT_ID ?? null;
    const id = legacyChatId();
    const out = {
      env: {
        CHAT_ID_raw: raw,
        CHAT_ID_parsed: id,
        CHAT_ID_has_whitespace: raw !== null && raw !== raw.trim(),
        SITE_PASSWORD_set: Boolean(process.env.SITE_PASSWORD),
        SUPABASE_URL_set: Boolean(process.env.SUPABASE_URL),
        SUPABASE_SERVICE_KEY_set: Boolean(process.env.SUPABASE_SERVICE_KEY),
        SUPABASE_ANON_KEY_set: Boolean(process.env.SUPABASE_ANON_KEY),
        BOT_TOKEN_set: Boolean(process.env.BOT_TOKEN),
      },
      db: {},
    };
    try {
      const [mAll, mMine, rAll, rMine, pAll] = await Promise.all([
        db.from("members").select("chat_id, person_id"),
        db.from("members").select("person_id").eq("chat_id", id),
        db.from("restaurants").select("chat_id"),
        db.from("restaurants").select("id").eq("chat_id", id),
        db.from("people").select("telegram_id"),
      ]);
      out.db = {
        members_total: (mAll.data ?? []).length,
        members_chat_ids: [...new Set((mAll.data ?? []).map((m) => String(m.chat_id)))],
        members_missing_person_id: (mAll.data ?? []).filter((m) => m.person_id === null).length,
        members_for_CHAT_ID: (mMine.data ?? []).length,
        restaurants_total: (rAll.data ?? []).length,
        restaurants_chat_ids: [...new Set((rAll.data ?? []).map((r) => String(r.chat_id)))],
        restaurants_for_CHAT_ID: (rMine.data ?? []).length,
        people_total: (pAll.data ?? []).length,
        errors: [mAll, mMine, rAll, rMine, pAll]
          .map((r) => r.error?.message).filter(Boolean),
      };
      const built = await buildList(db, id);
      out.buildList = {
        roster: built.people.length,
        rated: built.entries.length,
        pending: built.pending.length,
      };
    } catch (e) {
      out.db.threw = e?.message ?? String(e);
    }
    return json(out);
  }

  if (request.method !== "POST") return json({ error: "POST only" }, 405);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Bad request" }, 400);
  }

  // Two ways in. Inside Telegram we know exactly who this is; in a plain
  // browser the shared password gets you in and you say who you are.
  const db = sb();

  // The client needs these to run Supabase auth in the browser.
  if (body.action === "config") {
    return json({
      supabaseUrl: process.env.SUPABASE_URL,
      supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? null,
      passwordEnabled: Boolean(process.env.SITE_PASSWORD),
    });
  }

  const who = await identify(db, body);
  if (!who) return json({ error: "Wrong password" }, 401);

  const tgUser = who.via === "telegram" ? (who.telegram ?? { id: who.member?.telegram_id }) : null;
  const chatId = () => who.chat_id;

  if (body.action === "whoami") {
    return json({
      verified: who.via !== "password",
      via: who.via,
      me: who.member?.person_id ? Number(who.member.person_id)
          : who.member?.telegram_id ? Number(who.member.telegram_id)
          : (tgUser?.id ?? null),
      memberId: who.member?.id ?? null,
      inPair: who.chat_id !== null,
      name: who.member?.display_name ?? who.user?.email ?? null,
      invite_url: who.chat_id ? await pairInvite(db, who.chat_id, request) : null,
      partnered: who.chat_id ? await pairIsFull(db, who.chat_id) : false,
    });
  }

  /* ---- joining and creating pairs ---- */

  if (body.action === "createPair") {
    if (who.chat_id) return json({ error: "You're already in a pair" }, 400);
    const name = String(body.displayName ?? "").trim();
    if (!name) return json({ error: "Needs your name" }, 400);

    const chat_id = newPairId();
    const invite_code = newInviteCode();
    const { error } = await db.from("pairs")
      .insert({ chat_id, name: body.pairName || null, invite_code });
    if (error) return json({ error: error.message }, 400);

    const person_id = await addMember(db, {
      chat_id, auth_id: who.user?.id ?? null, telegram_id: tgUser?.id ?? null, display_name: name,
    });
    return json({ chat_id, invite_code, person_id, invite_url: inviteUrl(request, invite_code) });
  }

  if (body.action === "joinPair") {
    if (who.chat_id) return json({ error: "You're already in a pair" }, 400);
    const code = String(body.code ?? "").trim().toUpperCase();
    const name = String(body.displayName ?? "").trim();
    if (!code || !name) return json({ error: "Needs the code and your name" }, 400);

    const { data: pair } = await db.from("pairs").select("chat_id")
      .eq("invite_code", code).maybeSingle();
    if (!pair) return json({ error: "No pair with that code" }, 404);

    const { data: existing } = await db.from("members").select("id").eq("chat_id", pair.chat_id);
    if ((existing ?? []).length >= 2) return json({ error: "That pair is full" }, 400);

    const person_id = await addMember(db, {
      chat_id: Number(pair.chat_id),
      auth_id: who.user?.id ?? null,
      telegram_id: tgUser?.id ?? null,
      display_name: name,
    });
    return json({ chat_id: Number(pair.chat_id), person_id });
  }

  if (who.chat_id === null) {
    return json({ error: "Not in a pair yet", needsPair: true }, 403);
  }

  // Nobody can write someone else's scores.
  if (tgUser?.id && body.personId && Number(body.personId) !== Number(tgUser.id)) {
    return json({ error: "You can only set your own scores" }, 403);
  }

  try {
    switch (body.action) {
      case "list":
        return json(await buildList(db, chatId));

      case "add": {
        const { name, tier, visited_on } = body;
        if (!name?.trim()) return json({ error: "Needs a name" }, 400);
        if (!TIERS.includes(tier)) return json({ error: "Pick a tier" }, 400);
        const { data, error } = await db
          .from("restaurants")
          .insert({
            chat_id: chatId(),
            name: name.trim(),
            tier,
            visited_on: visited_on || null,
          })
          .select()
          .single();
        if (error) {
          return json(
            { error: error.code === "23505" ? "That one's already on the list" : error.message },
            400
          );
        }
        await pingBot();
        await announce(
          `\u{1F4CD} <b>${escapeHtml(name.trim())}</b> added \u2014 ${TIER_LABEL[tier]}. Both of you need to rate it.`,
          openButton()
        );
        return json({ id: data.id });
      }

      case "update": {
        // Scoped by chat so the site can never edit another group's rows.
        const patch = {};
        if (body.name !== undefined) patch.name = String(body.name).trim();
        if (body.tier !== undefined) patch.tier = body.tier;
        if (body.visited_on !== undefined) patch.visited_on = body.visited_on || null;
        const { error } = await db
          .from("restaurants")
          .update(patch)
          .eq("id", body.id)
          .eq("chat_id", chatId());
        if (error) return json({ error: error.message }, 400);
        await pingBot();
        return json({ ok: true });
      }

      case "delete":
        await db.from("restaurants").delete().eq("id", body.id).eq("chat_id", chatId());
        await pingBot();
        return json({ ok: true });

      case "rate": {
        const before = await buildList(db, chatId);
        const wasComplete = before.entries.some((e) => e.id === Number(body.id));
        const row = { restaurant_id: body.id, telegram_id: body.personId, updated_at: new Date().toISOString() };
        for (const c of CATS) {
          const v = body[c];
          row[c] = v === null || v === undefined || v === "" ? null : Number(v);
        }
        const { error } = await db.from("ratings").upsert(row);
        if (error) return json({ error: error.message }, 400);
        await pingBot();

        // Only shout when the place is finished, so the group isn't spammed
        // with a message per tap.
        const fresh = await buildList(db, chatId);
        const done = fresh.entries.find((e) => e.id === Number(body.id));
        if (done && !wasComplete) {
          const lines = [
            `\u{1F513} <b>${escapeHtml(done.name)}</b> is in.`,
            `Combined <b>${done.combined.toFixed(2)}</b> \u00b7 #${done.overallRank} overall, #${done.tierRank} in ${TIER_LABEL[done.tier].toLowerCase()}`,
          ];
          if (done.gap >= 1.5) lines.push(`\u26A1 You were ${done.gap.toFixed(2)} apart on this one.`);
          await announce(lines.join("\n"), openButton());
        }
        return json({ ok: true });
      }

      /* ---- repeat visits ---- */

      case "visitAdd": {
        const on_date = body.on_date || new Date(Date.now() + 8 * 3600_000)
          .toISOString().slice(0, 10);
        const { error } = await db.from("visits").insert({
          restaurant_id: body.id,
          on_date,
          by_id: tgUser?.id ?? null,
          amount: amountOf(body.amount),
          // null means split evenly.
          paid_by: body.paid_by ? Number(body.paid_by) : null,
        });
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      case "visitUpdate": {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.on_date ?? ""))) {
          return json({ error: "Needs a date" }, 400);
        }
        const { error } = await db.from("visits").update({
          on_date: body.on_date,
          amount: amountOf(body.amount),
          paid_by: body.paid_by ? Number(body.paid_by) : null,
        }).eq("id", body.visitId);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      case "visitDrop":
        await db.from("visits").delete().eq("id", body.visitId);
        return json({ ok: true });

      case "orderNote": {
        const { error } = await db.from("restaurants")
          .update({ order_note: body.order_note || null })
          .eq("id", body.id).eq("chat_id", chatId());
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      /* ---- upcoming ---- */

      case "planAdd": {
        const title = String(body.title ?? "").trim();
        if (!title) return json({ error: "Needs a title" }, 400);
        const { data, error } = await db.from("plans").insert({
          chat_id: chatId(),
          title,
          kind: ["booking","tickets","trip","plan"].includes(body.kind) ? body.kind : "plan",
          on_date: body.on_date || null,
          at_time: body.at_time || null,
          when_text: body.on_date ? null : (body.when_text || null),
          note: body.note || null,
          is_food: Boolean(body.is_food),
        }).select().single();
        if (error) return json({ error: error.message }, 400);
        return json({ id: Number(data.id) });
      }

      case "planUpdate": {
        const patch = {};
        for (const k of ["title","kind","on_date","at_time","when_text","note","is_food","archived"]) {
          if (body[k] !== undefined) patch[k] = body[k] === "" ? null : body[k];
        }
        if (patch.on_date) patch.when_text = null;
        const { error } = await db.from("plans").update(patch).eq("id", body.id).eq("chat_id", chatId());
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      case "planDrop":
        await db.from("plans").delete().eq("id", body.id).eq("chat_id", chatId());
        return json({ ok: true });

      case "planPhoto": {
        const m = String(body.dataUrl ?? "").match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
        if (!m) return json({ error: "That file isn't an image" }, 400);
        const bytes = Buffer.from(m[2], "base64");
        if (bytes.length > 4_000_000) return json({ error: "That image is too large" }, 413);

        const ext = m[1].split("/")[1].replace("jpeg", "jpg");
        const path = `plan-${body.id}-${Date.now()}.${ext}`;
        const up = await db.storage.from("photos").upload(path, bytes, { contentType: m[1], upsert: true });
        if (up.error) return json({ error: up.error.message }, 400);
        const url = db.storage.from("photos").getPublicUrl(path).data.publicUrl;

        const { data: plan } = await db.from("plans").select("photos").eq("id", body.id).maybeSingle();
        const photos = [...((plan?.photos) ?? []), url];
        await db.from("plans").update({ photos }).eq("id", body.id).eq("chat_id", chatId());
        return json({ url, photos });
      }

      case "planPhotoDrop": {
        const { data: plan } = await db.from("plans").select("photos").eq("id", body.id).maybeSingle();
        const photos = ((plan?.photos) ?? []).filter((u) => u !== body.url);
        await db.from("plans").update({ photos }).eq("id", body.id).eq("chat_id", chatId());
        return json({ photos });
      }

      /* ---- want to eat ---- */

      case "wantAdd": {
        const name = String(body.name ?? "").trim();
        if (!name) return json({ error: "Needs a name" }, 400);
        const tier = TIERS.includes(body.tier) ? body.tier : null;
        const { data, error } = await db
          .from("wishlist")
          .insert({ chat_id: chatId(), name, tier, note: body.note || null })
          .select()
          .single();
        if (error) {
          return json(
            { error: error.code === "23505" ? "Already on the want list" : error.message },
            400
          );
        }
        return json({ id: data.id });
      }

      case "wantBulk": {
        // Accepts a pasted list: bullets, numbering, "| tier", (notes).
        const lines = String(body.text ?? "").split("\n");
        const parsed = [];
        for (const line of lines) {
          let t = line.replace(/^\s*[-*\u2022\u2013\u2014]\s*/, "").replace(/^\s*\d+[.)]\s*/, "").trim();
          if (!t) continue;
          let tier = null;
          if (t.includes("|")) {
            const parts = t.split("|");
            const last = parts[parts.length - 1].trim().toLowerCase();
            if (TIERS.includes(last)) { tier = last; parts.pop(); t = parts.join("|").trim(); }
          }
          let note = null;
          const paren = t.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
          if (paren && paren[1].trim()) { t = paren[1].trim(); note = paren[2].trim() || null; }
          if (t) parsed.push({ chat_id: chatId(), name: t, tier, note });
        }
        if (!parsed.length) return json({ error: "Nothing to add there" }, 400);

        let added = 0;
        const skipped = [];
        for (const row of parsed) {
          const { error } = await db.from("wishlist").insert(row);
          if (error) skipped.push(row.name);
          else added++;
        }
        return json({ added, skipped });
      }

      case "wantUpdate": {
        const patch = {};
        if (body.name !== undefined) patch.name = String(body.name).trim();
        if (body.tier !== undefined) patch.tier = TIERS.includes(body.tier) ? body.tier : null;
        await db.from("wishlist").update(patch).eq("id", body.id).eq("chat_id", chatId());
        return json({ ok: true });
      }

      case "wantDrop":
        await db.from("wishlist").delete().eq("id", body.id).eq("chat_id", chatId());
        return json({ ok: true });

      case "wantWent": {
        // Moves it off the want list and onto the rated list in one step.
        const { data: w } = await db
          .from("wishlist")
          .select("*")
          .eq("id", body.id)
          .eq("chat_id", chatId())
          .maybeSingle();
        if (!w) return json({ error: "That one's already gone" }, 404);

        const { data, error } = await db
          .from("restaurants")
          .insert({
            chat_id: chatId(),
            name: w.name,
            tier: w.tier ?? "normal",
            visited_on: body.visited_on || null,
          })
          .select()
          .single();
        if (error) {
          return json(
            { error: error.code === "23505" ? "Already on the rated list" : error.message },
            400
          );
        }
        await db.from("wishlist").delete().eq("id", w.id);
        await pingBot();
        await announce(
          `\u{1F4CD} <b>${escapeHtml(w.name)}</b> \u2014 off the want list, onto the real one.`,
          openButton()
        );
        return json({ id: data.id });
      }

      case "photo": {
        // slot decides which of the two images this is.
        const slot = body.slot === "logo" ? "logo" : "food";
        // dataUrl comes from a FileReader in the browser.
        const m = String(body.dataUrl ?? "").match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
        if (!m) return json({ error: "That file isn't an image" }, 400);
        const bytes = Buffer.from(m[2], "base64");
        // The browser downscales before sending; this is just a backstop.
        if (bytes.length > 4_000_000) {
          return json({ error: "That photo is too large. Try a smaller one." }, 413);
        }

        const ext = m[1].split("/")[1].replace("jpeg", "jpg");
        const path = `${slot}-${body.id}-${Date.now()}.${ext}`;
        const { error } = await db.storage
          .from("photos")
          .upload(path, bytes, { contentType: m[1], upsert: true });
        if (error) return json({ error: error.message }, 400);

        const { data } = db.storage.from("photos").getPublicUrl(path);
        const column = slot === "logo" ? "logo_url" : "photo_url";
        await db.from("restaurants").update({ [column]: data.publicUrl })
          .eq("id", body.id).eq("chat_id", chatId());
        return json({ url: data.publicUrl, slot });
      }

      case "unphoto": {
        const patch = body.slot === "logo"
          ? { logo_url: null, logo_file_id: null }
          : { photo_url: null, photo_file_id: null };
        await db.from("restaurants").update(patch).eq("id", body.id).eq("chat_id", chatId());
        await pingBot();
        return json({ ok: true });
      }

      default:
        return json({ error: "Unknown action" }, 400);
    }
  } catch (e) {
    return json({ error: e?.message ?? "Something went wrong" }, 500);
  }
};

async function buildList(db, chatId) {
  const [{ data: places }, { data: people }] = await Promise.all([
    db
      .from("restaurants")
      .select("id, name, tier, visited_on, photo_url, logo_url, order_note, ratings(telegram_id, food, ambiance, aesthetics, service), visits(id, on_date, amount, paid_by)")
      .eq("chat_id", chatId),
    // Scoped to this pair. The `people` table is global and would leak names
    // from every other pair.
    db.from("members").select("person_id, display_name").eq("chat_id", chatId),
  ]);

  let roster = (people ?? [])
    .filter((p) => p.person_id !== null)
    .map((p) => ({ id: Number(p.person_id), name: p.display_name }));

  // Fallback for the original pair: if `members` is empty or the table doesn't
  // exist yet, read the old global `people` table so the app keeps working
  // whatever state the migrations are in. Scoped to the legacy chat so a new
  // pair can never pick up someone else's names.
  if (!roster.length && chatId === legacyChatId()) {
    const { data: legacy } = await db.from("people").select("telegram_id, display_name");
    roster = (legacy ?? []).map((p) => ({ id: Number(p.telegram_id), name: p.display_name }));
  }
  const needed = Math.max(2, roster.length);

  const { data: planRows } = await db
    .from("plans")
    .select("*")
    .eq("chat_id", chatId)
    .eq("archived", false)
    .order("on_date", { ascending: true, nullsFirst: false });
  const upcoming = (planRows ?? []).map((p) => ({
    ...p, id: Number(p.id), photos: p.photos ?? [],
  }));

  const { data: wishRows } = await db
    .from("wishlist")
    .select("id, name, tier, note")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false });
  const wishlist = (wishRows ?? []).map((w) => ({ ...w, id: Number(w.id) }));

  const entries = [];
  const pending = [];

  for (const r of places ?? []) {
    const ratings = (r.ratings ?? []).map((x) => {
      const out = { personId: Number(x.telegram_id) };
      for (const c of CATS) out[c] = x[c] === null ? null : Number(x[c]);
      return out;
    });
    const done = ratings.filter(complete);

    const visits = (r.visits ?? [])
      .map((v) => ({
        id: Number(v.id),
        on_date: v.on_date,
        amount: v.amount === null || v.amount === undefined ? null : Number(v.amount),
        paid_by: v.paid_by === null || v.paid_by === undefined ? null : Number(v.paid_by),
      }))
      .sort((a, b) => b.on_date.localeCompare(a.on_date));
    const priced = visits.filter((v) => v.amount !== null);

    const base = {
      id: Number(r.id),
      name: r.name,
      tier: r.tier,
      visited_on: r.visited_on,
      photo_url: r.photo_url,
      logo_url: r.logo_url ?? null,
      order_note: r.order_note ?? null,
      ratings,
      visits,
      visitCount: visits.length,
      lastVisit: visits[0]?.on_date ?? r.visited_on ?? null,
      avgSpend: priced.length
        ? priced.reduce((a, v) => a + v.amount, 0) / priced.length
        : null,
    };

    if (done.length < needed) {
      pending.push({
        ...base,
        progress: roster
          .map((p) => {
            const mine = ratings.find((x) => x.personId === p.id);
            return `${p.name} ${mine ? CATS.filter((c) => mine[c] !== null).length : 0}/4`;
          })
          .join(" · "),
      });
      continue;
    }

    const totals = done.map((x) => ({ personId: x.personId, total: personalScore(x, r.tier), ...x }));
    const combined = totals.reduce((s, x) => s + x.total, 0) / totals.length;
    const sorted = [...totals].sort((a, b) => a.total - b.total);

    entries.push({
      ...base,
      scores: totals,
      combined,
      gap: sorted.length > 1 ? sorted[sorted.length - 1].total - sorted[0].total : 0,
    });
  }

  entries.sort((a, b) => b.combined - a.combined);
  entries.forEach((e, i) => (e.overallRank = i + 1));
  for (const tier of TIERS) {
    entries.filter((e) => e.tier === tier).forEach((e, i) => (e.tierRank = i + 1));
  }

  const counts = { all: entries.length };
  for (const tier of TIERS) counts[tier] = entries.filter((e) => e.tier === tier).length;

  counts.want = wishlist.length;
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  counts.upcoming = upcoming.filter((p) => !p.on_date || p.on_date >= today).length;
  return { people: roster, entries, pending, wishlist, upcoming, counts };
}
