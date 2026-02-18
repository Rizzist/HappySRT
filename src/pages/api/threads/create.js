// pages/api/threads/create.js
import Stripe from "stripe";
import { pool } from "../../../server/crdb";
import { requireAppwriteUser } from "../../../server/appwriteAuth";

import PlansImport from "../../../shared/plans";
const Plans = (PlansImport && (PlansImport.default || PlansImport)) || {};
const { PLANS, PLAN_KEYS, getPlanByKey } = Plans;

const stripeSecret = process.env.STRIPE_SECRET_KEY || "";
const stripe = stripeSecret ? new Stripe(stripeSecret) : null;

function safeStripeQueryValue(v) {
  return String(v || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function isKnownPlanKey(k) {
  const s = String(k || "").trim();
  return (
    s === PLAN_KEYS?.free ||
    s === PLAN_KEYS?.hobby ||
    s === PLAN_KEYS?.business ||
    s === PLAN_KEYS?.agency
  );
}

function findPlanKeyFromPriceId(priceId) {
  const list = Array.isArray(PLANS) ? PLANS : [];
  const pid = String(priceId || "").trim();
  if (!pid) return "";
  for (const p of list) {
    const planPid = p?.stripe?.priceIdMonthly ? String(p.stripe.priceIdMonthly) : "";
    if (planPid && planPid === pid) return String(p?.key || "");
  }
  return "";
}

async function searchBestSubscriptionForUser(uid) {
  if (!stripe) return null;

  const u = safeStripeQueryValue(uid);
  const statuses = ["active", "trialing", "past_due", "unpaid"];

  let best = null;

  for (const st of statuses) {
    const query = `metadata["userId"]:"${u}" AND status:"${st}"`;
    const r = await stripe.subscriptions.search({ query, limit: 10 });

    const subs = (r && Array.isArray(r.data) ? r.data : []).filter(Boolean);
    for (const s of subs) {
      const end = Number(s.current_period_end || 0) || 0;
      const bestEnd = Number(best?.current_period_end || 0) || 0;
      if (!best || end > bestEnd) best = s;
    }

    if (best) break;
  }

  return best;
}

async function resolvePlanKeyForUser(uid) {
  // Stripe disabled => treat as free
  if (!stripe) return PLAN_KEYS?.free || "free";

  const sub = await searchBestSubscriptionForUser(uid);
  if (!sub) return PLAN_KEYS?.free || "free";

  // Prefer explicit metadata.planKey
  const metaKey = String(sub?.metadata?.planKey || "").trim();
  if (isKnownPlanKey(metaKey)) return metaKey;

  // Else infer from subscription item price id
  const priceId =
    String(sub?.items?.data?.[0]?.price?.id || "").trim() ||
    String(sub?.items?.data?.[0]?.plan?.id || "").trim();

  const inferred = findPlanKeyFromPriceId(priceId);
  if (isKnownPlanKey(inferred)) return inferred;

  return PLAN_KEYS?.free || "free";
}

function getThreadLimitForPlanKey(planKey) {
  const key = isKnownPlanKey(planKey) ? planKey : (PLAN_KEYS?.free || "free");
  const plan = typeof getPlanByKey === "function" ? getPlanByKey(key) : null;
  const limit = Number(plan?.entitlements?.threadLimit || 0) || 0;

  // Final fallback (should not hit if plans.js is correct)
  if (limit > 0) return limit;
  if (key === "free") return 2;
  if (key === "hobby") return 20;
  if (key === "business") return 200;
  if (key === "agency") return 2000;
  return 2;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ message: "Method not allowed" });

  try {
    const { userId } = await requireAppwriteUser(req);

    const { threadId, title } = req.body || {};
    if (!threadId || typeof threadId !== "string") {
      return res.status(400).json({ message: "threadId is required" });
    }
    if (threadId === "default") {
      return res.status(400).json({ message: "default thread is local-only" });
    }

    // ✅ Stripe hit per request (your requirement)
    const planKey = await resolvePlanKeyForUser(userId);
    const limit = getThreadLimitForPlanKey(planKey);

    // ✅ enforce plan limit (counts only non-deleted threads)
    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS c FROM threads WHERE user_id = $1 AND deleted_at IS NULL`,
      [userId]
    );

    const currentCount = Number(countRes.rows?.[0]?.c || 0);
    if (currentCount >= limit) {
      return res.status(403).json({
        message: `Thread limit reached (${currentCount}/${limit}). Upgrade to create more threads.`,
        code: "THREAD_LIMIT_REACHED",
        limit,
        planKey,
      });
    }

    const cleanTitle = typeof title === "string" && title.trim() ? title.trim() : "New Thread";

    const exists = await pool.query(
      `SELECT thread_id FROM threads WHERE user_id = $1 AND thread_id = $2 LIMIT 1`,
      [userId, threadId]
    );

    if (exists.rowCount > 0) {
      return res.status(409).json({ message: "Thread already exists" });
    }

    const data = { kind: "thread", items: [] };

    const created = await pool.query(
      `
      INSERT INTO threads (user_id, thread_id, title, data, version)
      VALUES ($1, $2, $3, $4::jsonb, 1)
      RETURNING thread_id, title, data, version, created_at, updated_at, deleted_at
      `,
      [userId, threadId, cleanTitle, JSON.stringify(data)]
    );

    const row = created.rows[0];

    return res.status(200).json({
      ok: true,
      thread: {
        id: row.thread_id,
        title: row.title,
        kind: row.data?.kind || "thread",
        items: row.data?.items || [],
        version: Number(row.version || 1),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    });
  } catch (e) {
    const code = e.statusCode || 500;
    return res.status(code).json({ message: e.message || "Server error" });
  }
}
