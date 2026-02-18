// pages/api/threads/delete.js
import Stripe from "stripe";
import { pool } from "../../../server/crdb";
import { requireOwner } from "../../../server/owner";
import { b2DeleteKey } from "../../../server/b2";

import PlansImport from "../../../shared/plans";
const Plans = (PlansImport && (PlansImport.default || PlansImport)) || {};
const { PLANS, PLAN_KEYS, getPlanByKey } = Plans;

const stripeSecret = process.env.STRIPE_SECRET_KEY || "";
const stripe = stripeSecret ? new Stripe(stripeSecret) : null;

function isUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(v || "")
  );
}

function safeStripeQueryValue(v) {
  return String(v || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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

async function resolvePlanKeyForOwner(owner) {
  if (!owner || owner.isGuest) return (PLAN_KEYS && PLAN_KEYS.free) || "free";
  if (!stripe) return (PLAN_KEYS && PLAN_KEYS.free) || "free";

  const uid = String(owner.ownerId || "").trim();
  if (!uid) return (PLAN_KEYS && PLAN_KEYS.free) || "free";

  const sub = await searchBestSubscriptionForUser(uid);
  if (!sub) return (PLAN_KEYS && PLAN_KEYS.free) || "free";

  let planKey = (sub?.metadata?.planKey ? String(sub.metadata.planKey) : "").trim();

  if (!planKey) {
    const priceId =
      String(sub?.items?.data?.[0]?.price?.id || "").trim() ||
      String(sub?.items?.data?.[0]?.plan?.id || "").trim();
    planKey = findPlanKeyFromPriceId(priceId);
  }

  if (!planKey || !getPlanByKey || !getPlanByKey(planKey)) {
    return (PLAN_KEYS && PLAN_KEYS.free) || "free";
  }

  return planKey;
}

function getEntitlementsForPlanKey(planKey) {
  const freeKey = (PLAN_KEYS && PLAN_KEYS.free) || "free";
  const plan =
    (typeof getPlanByKey === "function" ? getPlanByKey(planKey) : null) ||
    (typeof getPlanByKey === "function" ? getPlanByKey(freeKey) : null) ||
    null;

  const e = (plan && plan.entitlements) || {};
  const finalKey = String(plan?.key || planKey || freeKey);

  return {
    planKey: finalKey,
    planLabel: String(plan?.label || plan?.name || plan?.title || finalKey),
    activeStorageBytesCap: Math.max(0, Number(e.activeStorageBytesCap || 0) || 0),
  };
}

async function getActiveStorageUsedBytes(ownerId) {
  const r = await pool.query(
    `
    SELECT COALESCE(SUM(bytes), 0)::int8 AS used
    FROM media_objects
    WHERE owner_id = $1
      AND deleted_at IS NULL
      AND status IN ('active','pending')
      AND (expires_at IS NULL OR expires_at > now())
    `,
    [ownerId]
  );
  return Number(r.rows?.[0]?.used || 0) || 0;
}

function looksLikeNotFoundError(e) {
  const m = String(e?.message || e || "");
  return (
    m.toLowerCase().includes("not found") ||
    m.includes("404") ||
    m.toLowerCase().includes("nosuchkey") ||
    m.toLowerCase().includes("file does not exist")
  );
}

async function deleteB2KeysWithLimit({ bucket, keys, concurrency }) {
  const list = (Array.isArray(keys) ? keys : []).filter(Boolean);
  const limit = Math.max(1, Number(concurrency || 4) || 4);

  let i = 0;
  const deleted = [];
  const failed = [];

  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= list.length) return;

      const key = list[idx];

      try {
        await b2DeleteKey({ bucket, key });
        deleted.push(key);
      } catch (e) {
        if (looksLikeNotFoundError(e)) {
          deleted.push(key);
          continue;
        }
        failed.push({ key, message: String(e?.message || e || "delete failed") });
      }
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(limit, list.length); w++) workers.push(worker());
  await Promise.all(workers);

  return { deleted, failed };
}

function buildInPlaceholders(n, startIndex) {
  // returns "$2,$3,..."
  const out = [];
  for (let i = 0; i < n; i++) out.push(`$${startIndex + i}`);
  return out.join(", ");
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ message: "Method not allowed" });

  let owner;
  try {
    owner = await requireOwner(req, res);
  } catch (e) {
    return res.status(e.statusCode || 401).json({ message: e.message || "Unauthorized" });
  }

  try {
    const { threadId } = req.body || {};

    if (!threadId || typeof threadId !== "string") {
      return res.status(400).json({ message: "threadId is required" });
    }
    if (threadId === "default") {
      return res.status(400).json({ message: "default thread is local-only" });
    }
    if (!isUuid(threadId)) {
      return res.status(400).json({ message: "threadId must be a UUID" });
    }

    const bucket = process.env.B2_BUCKET;
    if (!bucket) return res.status(500).json({ message: "Missing B2_BUCKET env var" });

    // STEP A) Soft-delete thread FIRST (prevents new uploads because upload checks deleted_at IS NULL)
    // Idempotent: if already deleted, we keep going to attempt cleanup.
    const clientA = await pool.connect();
    let alreadyDeleted = false;

    try {
      await clientA.query("BEGIN");

      const t = await clientA.query(
        `
        SELECT deleted_at
        FROM threads
        WHERE user_id = $1 AND thread_id = $2
        FOR UPDATE
        `,
        [owner.ownerId, threadId]
      );

      if (t.rowCount === 0) {
        await clientA.query("ROLLBACK");
        return res.status(404).json({ message: "Thread not found" });
      }

      alreadyDeleted = !!t.rows[0]?.deleted_at;

      await clientA.query(
        `
        UPDATE threads
        SET deleted_at = COALESCE(deleted_at, now()),
            updated_at = now(),
            version = version + 1
        WHERE user_id = $1 AND thread_id = $2
        `,
        [owner.ownerId, threadId]
      );

      await clientA.query("COMMIT");
    } catch (e) {
      try {
        await clientA.query("ROLLBACK");
      } catch {}
      throw e;
    } finally {
      clientA.release();
    }

    // STEP B) Fetch all live objects still present for this thread
    const mRes = await pool.query(
      `
      SELECT object_id, b2_key, bytes, status
      FROM media_objects
      WHERE owner_id = $1
        AND thread_id = $2
        AND deleted_at IS NULL
        AND status IN ('active','pending')
        AND (expires_at IS NULL OR expires_at > now())
      `,
      [owner.ownerId, threadId]
    );

    const rows = Array.isArray(mRes.rows) ? mRes.rows : [];
    const keys = rows.map((r) => String(r.b2_key || "")).filter(Boolean);

    // Nothing to delete from B2 (maybe already cleaned)
    if (keys.length === 0) {
      // still mark chat_items deleted for this thread (best for consistency)
      await pool.query(
        `
        UPDATE chat_items
        SET deleted_at = COALESCE(deleted_at, now()),
            updated_at = now()
        WHERE owner_id = $1 AND thread_id = $2
        `,
        [owner.ownerId, threadId]
      );

      const usedAfter = await getActiveStorageUsedBytes(owner.ownerId);
      const planKey = await resolvePlanKeyForOwner(owner);
      const ent = getEntitlementsForPlanKey(planKey);

      return res.status(200).json({
        ok: true,
        threadId,
        alreadyDeleted,
        deletedObjects: 0,
        freedBytes: 0,
        cleanupOk: true,
        storage: { usedBytes: usedAfter, limitBytes: ent.activeStorageBytesCap },
        planKey: ent.planKey,
      });
    }

    // STEP C) Delete from B2
    const uniqKeys = Array.from(new Set(keys));
    const del = await deleteB2KeysWithLimit({ bucket, keys: uniqKeys, concurrency: 4 });

    // If anything failed, we DO NOT mark those DB rows deleted (so storage accounting stays correct).
    // We still proceed to mark what succeeded, and return failed keys so you can retry cleanup.
    const deletedKeySet = new Set(del.deleted);

    const succeededRows = rows.filter((r) => deletedKeySet.has(String(r.b2_key || "")));
    const succeededObjectIds = succeededRows.map((r) => String(r.object_id || "")).filter(Boolean);

    const freedBytes = succeededRows.reduce((acc, r) => acc + (Number(r.bytes || 0) || 0), 0);

    // STEP D) Mark succeeded objects + chat_items deleted (transaction)
    const clientD = await pool.connect();
    try {
      await clientD.query("BEGIN");

      // mark chat_items deleted for this thread (even if some B2 keys failed, thread is deleted anyway)
      await clientD.query(
        `
        UPDATE chat_items
        SET deleted_at = COALESCE(deleted_at, now()),
            updated_at = now()
        WHERE owner_id = $1 AND thread_id = $2
        `,
        [owner.ownerId, threadId]
      );

      if (succeededObjectIds.length > 0) {
        const placeholders = buildInPlaceholders(succeededObjectIds.length, 3);
        const params = [owner.ownerId, threadId, ...succeededObjectIds];

        await clientD.query(
          `
          UPDATE media_objects
          SET status = 'deleted',
              deleted_at = now(),
              updated_at = now(),
              expires_at = NULL
          WHERE owner_id = $1
            AND thread_id = $2
            AND object_id IN (${placeholders})
            AND deleted_at IS NULL
            AND status IN ('active','pending')
          `,
          params
        );
      }

      await clientD.query("COMMIT");
    } catch (e) {
      try {
        await clientD.query("ROLLBACK");
      } catch {}
      throw e;
    } finally {
      clientD.release();
    }

    const usedAfter = await getActiveStorageUsedBytes(owner.ownerId);
    const planKey = await resolvePlanKeyForOwner(owner);
    const ent = getEntitlementsForPlanKey(planKey);

    return res.status(200).json({
      ok: true,
      threadId,
      alreadyDeleted,
      deletedObjects: succeededObjectIds.length,
      freedBytes,
      cleanupOk: del.failed.length === 0,
      failed: del.failed, // retry these keys by calling delete again (idempotent)
      storage: {
        usedBytes: usedAfter,
        limitBytes: ent.activeStorageBytesCap,
      },
      planKey: ent.planKey,
    });
  } catch (e) {
    console.error("[threads/delete] error", e);
    return res.status(e?.statusCode || 500).json({ message: e?.message || "Server error" });
  }
}
