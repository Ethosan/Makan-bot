import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

/**
 * Goals API. Same Supabase project as the food app, different tables and a
 * separate password — goals and restaurants shouldn't share a URL.
 */

const KINDS = ["outcome", "process", "stop"];
const STATUSES = ["on_track", "slipping", "stalled", "done"];
const OUTCOMES = ["done", "partial", "dropped", "missed"];
const GOAL_CAP = 3;
const TZ = 8;

const chatId = () => Number(process.env.CHAT_ID ?? 0);

const sb = () =>
  createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const localNow = () => new Date(Date.now() + TZ * 3600_000);
const monthKey = (d = localNow()) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;

function cycleWindow(start) {
  const s = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const e = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 4, 0));
  const mon = d => ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()];
  return {
    starts_on: s.toISOString().slice(0, 10),
    ends_on: e.toISOString().slice(0, 10),
    name: `${mon(s)}\u2013${mon(e)} ${e.getUTCFullYear()}`,
  };
}

/** Telegram Mini App sign-in: verifies the signed blob against the bot token. */
function verifyInitData(initData) {
  if (!initData || !process.env.BOT_TOKEN) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(process.env.BOT_TOKEN).digest();
  const expected = crypto.createHmac("sha256", secret).update(check).digest("hex");

  const a = Buffer.from(expected, "hex"), b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const authDate = Number(params.get("auth_date") ?? 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null;

  try {
    const user = JSON.parse(params.get("user") ?? "null");
    return user?.id ? { id: Number(user.id), name: user.first_name ?? "Someone" } : null;
  } catch { return null; }
}

export default async (request) => {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Bad request" }, 400); }

  const tgUser = verifyInitData(body.initData);
  if (!tgUser && body.password !== process.env.SITE_PASSWORD) {
    return json({ error: "Wrong password" }, 401);
  }

  const db = sb();
  if (body.action === "whoami") {
    return json({ verified: Boolean(tgUser), me: tgUser?.id ?? null });
  }

  try {
    switch (body.action) {
      case "state":
        return json(await buildState(db));

      case "newCycle": {
        const { data: open } = await db.from("cycles").select("id")
          .eq("chat_id", chatId()).eq("closed", false).maybeSingle();
        if (open) return json({ error: "A cycle is already running" }, 400);
        const { data, error } = await db.from("cycles")
          .insert({ chat_id: chatId(), ...cycleWindow(localNow()) }).select().single();
        if (error) return json({ error: error.message }, 400);
        return json({ id: Number(data.id) });
      }

      case "goalAdd": {
        const title = String(body.title ?? "").trim();
        if (!title) return json({ error: "Needs a title" }, 400);
        const { data: cycle } = await db.from("cycles").select("id")
          .eq("chat_id", chatId()).eq("closed", false).maybeSingle();
        if (!cycle) return json({ error: "No cycle running" }, 400);

        const ownerId = body.owner_id === null || body.owner_id === undefined
          ? null : Number(body.owner_id);
        const { data: mine } = await db.from("goals").select("id")
          .eq("cycle_id", cycle.id)
          [ownerId === null ? "is" : "eq"]("owner_id", ownerId === null ? null : ownerId);
        if ((mine ?? []).length >= GOAL_CAP) {
          return json({ error: `That's already ${GOAL_CAP} for this cycle. The cap is the point.` }, 400);
        }

        const { data, error } = await db.from("goals").insert({
          cycle_id: cycle.id,
          chat_id: chatId(),
          owner_id: ownerId,
          title,
          kind: KINDS.includes(body.kind) ? body.kind : "outcome",
          measure: body.measure || null,
          risk: body.risk || null,
        }).select().single();
        if (error) return json({ error: error.message }, 400);
        return json({ id: Number(data.id) });
      }

      case "goalUpdate": {
        const patch = {};
        for (const k of ["title", "kind", "measure", "risk", "owner_id"]) {
          if (body[k] !== undefined) patch[k] = body[k] === "" ? null : body[k];
        }
        if (body.outcome !== undefined) {
          patch.outcome = OUTCOMES.includes(body.outcome) ? body.outcome : null;
        }
        if (body.outcome_note !== undefined) patch.outcome_note = body.outcome_note || null;
        const { error } = await db.from("goals").update(patch)
          .eq("id", body.id).eq("chat_id", chatId());
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      case "goalDrop":
        await db.from("goals").delete().eq("id", body.id).eq("chat_id", chatId());
        return json({ ok: true });

      case "checkin": {
        if (!STATUSES.includes(body.status)) return json({ error: "Bad status" }, 400);
        const { error } = await db.from("checkins").upsert({
          goal_id: body.id,
          month: body.month || monthKey(),
          status: body.status,
          note: body.note || null,
          by_id: tgUser?.id ?? null,
          updated_at: new Date().toISOString(),
        }, { onConflict: "goal_id,month" });
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      case "closeCycle": {
        const { data: cycle } = await db.from("cycles").select("id")
          .eq("chat_id", chatId()).eq("closed", false).maybeSingle();
        if (!cycle) return json({ error: "No cycle running" }, 400);
        const { data: goals } = await db.from("goals").select("id, title, outcome")
          .eq("cycle_id", cycle.id);
        const ungraded = (goals ?? []).filter(g => !g.outcome);
        if (ungraded.length) {
          return json({ error: "Grade every goal first — that's the point of the review." }, 400);
        }
        await db.from("cycles").update({ closed: true }).eq("id", cycle.id);
        const { data: next } = await db.from("cycles")
          .insert({ chat_id: chatId(), ...cycleWindow(localNow()) }).select().single();
        return json({ id: Number(next.id) });
      }

      default:
        return json({ error: "Unknown action" }, 400);
    }
  } catch (e) {
    return json({ error: e?.message ?? "Something went wrong" }, 500);
  }
};

async function buildState(db) {
  const [{ data: people }, { data: cycle }] = await Promise.all([
    db.from("people").select("telegram_id, display_name"),
    db.from("cycles").select("*").eq("chat_id", chatId()).eq("closed", false)
      .order("starts_on", { ascending: false }).limit(1).maybeSingle(),
  ]);

  const roster = (people ?? []).map(p => ({ id: Number(p.telegram_id), name: p.display_name }));
  if (!cycle) return { people: roster, cycle: null, goals: [], past: [] };

  const { data: goalRows } = await db
    .from("goals")
    .select("*, checkins(month, status, note)")
    .eq("cycle_id", cycle.id)
    .order("created_at", { ascending: true });

  const goals = (goalRows ?? []).map(g => ({
    ...g,
    id: Number(g.id),
    owner_id: g.owner_id === null ? null : Number(g.owner_id),
    checkins: (g.checkins ?? []).sort((a, b) => a.month.localeCompare(b.month)),
  }));

  const { data: pastRows } = await db.from("cycles").select("id, name, ends_on")
    .eq("chat_id", chatId()).eq("closed", true).order("ends_on", { ascending: false }).limit(6);

  return {
    people: roster,
    cycle: { ...cycle, id: Number(cycle.id) },
    goals,
    past: pastRows ?? [],
    month: monthKey(),
  };
}
