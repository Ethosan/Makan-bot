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
const chatId = () => Number(process.env.CHAT_ID ?? 0);

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

export default async (request) => {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Bad request" }, 400);
  }

  // Two ways in. Inside Telegram we know exactly who this is; in a plain
  // browser the shared password gets you in and you say who you are.
  const tgUser = verifyInitData(body.initData);
  if (!tgUser && body.password !== process.env.SITE_PASSWORD) {
    return json({ error: "Wrong password" }, 401);
  }

  const db = sb();

  if (body.action === "whoami") {
    return json({ verified: Boolean(tgUser), me: tgUser?.id ?? null });
  }

  // A verified Telegram user can only ever write their own scores.
  if (tgUser && body.personId && Number(body.personId) !== tgUser.id) {
    return json({ error: "You can only set your own scores" }, 403);
  }

  try {
    switch (body.action) {
      case "list":
        return json(await buildList(db));

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
        const before = await buildList(db);
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
        const fresh = await buildList(db);
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
        const { error } = await db.from("visits")
          .insert({ restaurant_id: body.id, on_date, by_id: tgUser?.id ?? null });
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      case "visitUpdate": {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.on_date ?? ""))) {
          return json({ error: "Needs a date" }, 400);
        }
        const { error } = await db.from("visits")
          .update({ on_date: body.on_date }).eq("id", body.visitId);
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
        // dataUrl comes from a FileReader in the browser.
        const m = String(body.dataUrl ?? "").match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
        if (!m) return json({ error: "That file isn't an image" }, 400);
        const bytes = Buffer.from(m[2], "base64");
        // The browser downscales before sending; this is just a backstop.
        if (bytes.length > 4_000_000) {
          return json({ error: "That photo is too large. Try a smaller one." }, 413);
        }

        const ext = m[1].split("/")[1].replace("jpeg", "jpg");
        const path = `${body.id}-${Date.now()}.${ext}`;
        const { error } = await db.storage
          .from("photos")
          .upload(path, bytes, { contentType: m[1], upsert: true });
        if (error) return json({ error: error.message }, 400);

        const { data } = db.storage.from("photos").getPublicUrl(path);
        await db.from("restaurants").update({ photo_url: data.publicUrl }).eq("id", body.id);
        return json({ photo_url: data.publicUrl });
      }

      case "unphoto":
        await db.from("restaurants").update({ photo_url: null, photo_file_id: null }).eq("id", body.id);
        await pingBot();
        return json({ ok: true });

      default:
        return json({ error: "Unknown action" }, 400);
    }
  } catch (e) {
    return json({ error: e?.message ?? "Something went wrong" }, 500);
  }
};

async function buildList(db) {
  const [{ data: places }, { data: people }] = await Promise.all([
    db
      .from("restaurants")
      .select("id, name, tier, visited_on, photo_url, order_note, ratings(telegram_id, food, ambiance, aesthetics, service), visits(id, on_date)")
      .eq("chat_id", chatId()),
    db.from("people").select("telegram_id, display_name"),
  ]);

  const roster = (people ?? []).map((p) => ({ id: Number(p.telegram_id), name: p.display_name }));
  const needed = Math.max(2, roster.length);

  const { data: planRows } = await db
    .from("plans")
    .select("*")
    .eq("chat_id", chatId())
    .eq("archived", false)
    .order("on_date", { ascending: true, nullsFirst: false });
  const upcoming = (planRows ?? []).map((p) => ({
    ...p, id: Number(p.id), photos: p.photos ?? [],
  }));

  const { data: wishRows } = await db
    .from("wishlist")
    .select("id, name, tier, note")
    .eq("chat_id", chatId())
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
      .map((v) => ({ id: Number(v.id), on_date: v.on_date }))
      .sort((a, b) => b.on_date.localeCompare(a.on_date));

    const base = {
      id: Number(r.id),
      name: r.name,
      tier: r.tier,
      visited_on: r.visited_on,
      photo_url: r.photo_url,
      order_note: r.order_note ?? null,
      ratings,
      visits,
      visitCount: visits.length,
      lastVisit: visits[0]?.on_date ?? r.visited_on ?? null,
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
