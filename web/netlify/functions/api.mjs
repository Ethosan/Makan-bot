import { createClient } from "@supabase/supabase-js";

/**
 * Everything the site does goes through here, so the Supabase key never
 * reaches the browser. The password is checked server-side on every call.
 */

const TIERS = ["cheap", "normal", "fancy"];
const CATS = ["food", "ambiance", "aesthetics", "service"];

const WEIGHTS = {
  cheap:  { food: 0.65, ambiance: 0.15, aesthetics: 0.10, service: 0.10 },
  normal: { food: 0.50, ambiance: 0.20, aesthetics: 0.10, service: 0.20 },
  fancy:  { food: 0.40, ambiance: 0.20, aesthetics: 0.15, service: 0.25 },
};

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

  if (body.password !== process.env.SITE_PASSWORD) {
    return json({ error: "Wrong password" }, 401);
  }

  const db = sb();

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
            chat_id: Number(process.env.CHAT_ID ?? 0),
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
        return json({ id: data.id });
      }

      case "update": {
        const patch = {};
        if (body.name !== undefined) patch.name = String(body.name).trim();
        if (body.tier !== undefined) patch.tier = body.tier;
        if (body.visited_on !== undefined) patch.visited_on = body.visited_on || null;
        const { error } = await db.from("restaurants").update(patch).eq("id", body.id);
        if (error) return json({ error: error.message }, 400);
        await pingBot();
        return json({ ok: true });
      }

      case "delete":
        await db.from("restaurants").delete().eq("id", body.id);
        await pingBot();
        return json({ ok: true });

      case "rate": {
        const row = { restaurant_id: body.id, telegram_id: body.personId, updated_at: new Date().toISOString() };
        for (const c of CATS) {
          const v = body[c];
          row[c] = v === null || v === undefined || v === "" ? null : Number(v);
        }
        const { error } = await db.from("ratings").upsert(row);
        if (error) return json({ error: error.message }, 400);
        await pingBot();
        return json({ ok: true });
      }

      case "photo": {
        // dataUrl comes from a FileReader in the browser.
        const m = String(body.dataUrl ?? "").match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
        if (!m) return json({ error: "That file isn't an image" }, 400);
        const bytes = Buffer.from(m[2], "base64");
        if (bytes.length > 8_000_000) return json({ error: "Image is over 8MB" }, 400);

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
      .select("id, name, tier, visited_on, photo_url, ratings(telegram_id, food, ambiance, aesthetics, service)"),
    db.from("people").select("telegram_id, display_name"),
  ]);

  const roster = (people ?? []).map((p) => ({ id: Number(p.telegram_id), name: p.display_name }));
  const needed = Math.max(2, roster.length);

  const entries = [];
  const pending = [];

  for (const r of places ?? []) {
    const ratings = (r.ratings ?? []).map((x) => {
      const out = { personId: Number(x.telegram_id) };
      for (const c of CATS) out[c] = x[c] === null ? null : Number(x[c]);
      return out;
    });
    const done = ratings.filter(complete);

    const base = {
      id: Number(r.id),
      name: r.name,
      tier: r.tier,
      visited_on: r.visited_on,
      photo_url: r.photo_url,
      ratings,
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

  return { people: roster, entries, pending, counts };
}
