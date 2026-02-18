// pages/api/billing/sync.js
import Stripe from "stripe";
import { pool } from "../../../server/crdb";
import { requireAppwriteUser } from "../../../server/appwriteAuth";

import PlansImport from "../../../shared/plans";
const Plans = (PlansImport && (PlansImport.default || PlansImport)) || {};
const { PLANS, PLAN_KEYS, getPlanByKey, PRICING_VERSION } = Plans;

const stripeSecret = process.env.STRIPE_SECRET_KEY || "";
const stripe = stripeSecret ? new Stripe(stripeSecret) : null;

function jsonBody(req) {
  const b = req && req.body;
  return b && typeof b === "object" ? b : {};
}

function pickSessionId(req) {
  const b = jsonBody(req);
  const q = req?.query || {};
  return String(b.sessionId || b.session_id || q.session_id || q.sessionId || "").trim() || "";
}

function safeStripeQueryValue(v) {
  return String(v || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function findPlanKeyFromPriceId(priceId) {
  const list = Array.isArray(PLANS) ? PLANS : [];
  for (const p of list) {
    const pid = p?.stripe?.priceIdMonthly ? String(p.stripe.priceIdMonthly) : "";
    if (pid && priceId && pid === priceId) return String(p?.key || "");
  }
  return "";
}

function planInfoFromPlan(plan, fallbackKey) {
  const key = String(plan?.key || fallbackKey || "").trim() || "free";
  const name =
    String(plan?.name || plan?.title || plan?.label || "").trim() ||
    key;

  const monthlyFloor = Math.max(
    0,
    Number(plan?.entitlements?.monthlyFloorMediaTokens || 0) || 0
  );

  return {
    planKey: key,
    planName: name,
    monthlyFloor,
    pricingVersion: String(PRICING_VERSION || "v1"),
  };
}

async function loadSubscriptionFromCheckoutSession(sessionId) {
  if (!sessionId) return null;

  const sess = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ["subscription", "line_items"],
  });

  if (!sess) return null;

  if (sess.subscription && typeof sess.subscription === "object") return sess.subscription;

  if (typeof sess.subscription === "string" && sess.subscription) {
    const sub = await stripe.subscriptions.retrieve(sess.subscription);
    return sub || null;
  }

  return null;
}

async function searchBestSubscriptionForUser(uid) {
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

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ message: "Method not allowed" });
  }

  if (!stripe) {
    return res.status(500).json({
      message: "Stripe not configured (missing STRIPE_SECRET_KEY).",
    });
  }

  try {
    const auth = await requireAppwriteUser(req);
    const uid = String(auth?.userId || "").trim();
    if (!uid) return res.status(401).json({ message: "Unauthorized" });

    const sessionId = pickSessionId(req);

    // 1) Find subscription (prefer checkout session)
    let sub = null;
    if (sessionId) sub = await loadSubscriptionFromCheckoutSession(sessionId);
    if (!sub) sub = await searchBestSubscriptionForUser(uid);

    // 2) Determine planKey
    let planKey = (sub?.metadata?.planKey ? String(sub.metadata.planKey) : "").trim() || "";

    if (!planKey) {
      const priceId =
        String(sub?.items?.data?.[0]?.price?.id || "").trim() ||
        String(sub?.items?.data?.[0]?.plan?.id || "").trim();
      if (priceId) planKey = findPlanKeyFromPriceId(priceId);
    }

    // If no subscription / no planKey -> free
    if (!sub || !planKey) {
      const freeKey = (PLAN_KEYS && (PLAN_KEYS.free || PLAN_KEYS.hobby)) || "free";
      const freePlan = typeof getPlanByKey === "function" ? getPlanByKey(freeKey) : null;
      const planInfo = planInfoFromPlan(freePlan, freeKey);

      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({
        ok: true,
        tokensHydrated: true,

        userId: uid,
        hasSubscription: false,
        subscriptionId: null,
        subscriptionStatus: null,

        ...planInfo,

        appliedTopup: 0,
        periodStart: null,
        periodEnd: null,

        // No token changes here (webhooks later). But we still return 0s if you want:
        // (If you prefer: omit token fields entirely in the no-sub path.)
        mediaTokensBalance: 0,
        mediaTokensReserved: 0,
        mediaTokens: 0,

        note: "No active subscription found for this user (or planKey missing).",
        serverTime: new Date().toISOString(),
      });
    }

    const plan =
      (typeof getPlanByKey === "function" ? getPlanByKey(planKey) : null) || null;

    const planInfo = planInfoFromPlan(plan, planKey);
    const monthlyFloor = planInfo.monthlyFloor;

    const subId = String(sub.id || "").trim();
    const periodStart = Number(sub.current_period_start || 0) || 0;
    const periodEnd = Number(sub.current_period_end || 0) || 0;

    // 3) Apply top-up ONCE per period
    const idemKey = `billing_topup:${subId}:${periodStart || 0}`;
    const requestHash = `${planInfo.planKey}|${monthlyFloor}|${subId}|${periodStart || 0}|${periodEnd || 0}`;

    const client = await pool.connect();
    let appliedTopup = 0;
    let balance = 0;
    let reserved = 0;

    try {
      await client.query("BEGIN");

      await client.query(
        `INSERT INTO account_tokens (user_id, pricing_version, bootstrap_min)
         VALUES ($1, $2, 0)
         ON CONFLICT (user_id) DO NOTHING`,
        [uid, String(PRICING_VERSION || "v1")]
      );

      const r = await client.query(
        `SELECT media_balance, media_reserved
         FROM account_tokens
         WHERE user_id = $1
         FOR UPDATE`,
        [uid]
      );

      const row = r.rows[0] || {};
      balance = Number(row.media_balance || 0) || 0;
      reserved = Number(row.media_reserved || 0) || 0;

      if (!Number.isFinite(reserved) || reserved < 0 || reserved > balance) {
        reserved = 0;
        await client.query(
          `UPDATE account_tokens
           SET media_reserved = 0, updated_at = now()
           WHERE user_id = $1`,
          [uid]
        );
      }

      await client.query(
        `INSERT INTO idempotency_keys (user_id, idem_key, kind, request_hash, status)
         VALUES ($1, $2, 'billing_topup', $3, 'started')
         ON CONFLICT (user_id, idem_key) DO NOTHING`,
        [uid, idemKey, requestHash]
      );

      const idemRes = await client.query(
        `SELECT status
         FROM idempotency_keys
         WHERE user_id = $1 AND idem_key = $2
         FOR UPDATE`,
        [uid, idemKey]
      );

      const status = String(idemRes.rows[0]?.status || "");

      if (status !== "committed") {
        const desired = Math.max(0, monthlyFloor);
        const delta = desired > 0 ? Math.max(0, desired - balance) : 0;

        if (delta > 0) {
          appliedTopup = delta;

          await client.query(
            `UPDATE account_tokens
             SET media_balance = media_balance + $2,
                 pricing_version = $3,
                 updated_at = now()
             WHERE user_id = $1`,
            [uid, delta, String(PRICING_VERSION || "v1")]
          );

          await client.query(
            `INSERT INTO token_ledger (user_id, delta, kind, ref_type, ref_id, meta)
             VALUES ($1, $2, 'grant', 'stripe_period_topup', $3, $4::jsonb)`,
            [
              uid,
              delta,
              idemKey,
              JSON.stringify({
                planKey: planInfo.planKey,
                subscriptionId: subId,
                periodStart,
                periodEnd,
                monthlyFloor,
                reason: "monthly_floor_topup",
              }),
            ]
          );

          balance = balance + delta;
        }

        await client.query(
          `UPDATE idempotency_keys
           SET status = 'committed',
               request_hash = $3,
               result = $4::jsonb,
               updated_at = now()
           WHERE user_id = $1 AND idem_key = $2`,
          [
            uid,
            idemKey,
            requestHash,
            JSON.stringify({
              ok: true,
              appliedTopup,
              planKey: planInfo.planKey,
              subscriptionId: subId,
              periodStart,
              periodEnd,
              monthlyFloor,
              balanceAfter: balance,
            }),
          ]
        );
      }

      await client.query("COMMIT");
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {}
      throw e;
    } finally {
      client.release();
    }

    const available = Math.max(0, balance - reserved);

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      tokensHydrated: true,

      userId: uid,

      hasSubscription: true,
      subscriptionId: subId,
      subscriptionStatus: String(sub.status || ""),

      ...planInfo,

      periodStart: periodStart || null,
      periodEnd: periodEnd || null,
      appliedTopup,

      mediaTokensBalance: balance,
      mediaTokensReserved: reserved,
      mediaTokens: available,

      serverTime: new Date().toISOString(),
    });
  } catch (e) {
    const status = e?.statusCode || 500;
    return res.status(status).json({ message: e?.message || "Server error" });
  }
}
