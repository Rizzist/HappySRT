// pages/api/threads/draft/delete.js
import Stripe from "stripe";
import { pool } from "../../../../server/crdb";
import { requireOwner } from "../../../../server/owner";
import { b2DeleteKey } from "../../../../server/b2";

import PlansImport from "../../../../shared/plans";
const Plans = (PlansImport && (PlansImport.default || PlansImport)) || {};
const { PLANS, PLAN_KEYS, getPlanByKey } = Plans;

const stripeSecret = process.env.STRIPE_SECRET_KEY || "";
const stripe = stripeSecret ? new Stripe(stripeSecret) : null;

function isUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(v || "")
  );
}

function ensureDraftShape(d) {
  const out = d && typeof d === "object" ? { ...d } : {};
  if (!Array.isArray(out.files)) out.files = [];
  if (!out.shared || typeof out.shared !== "object") out.shared = {};
  if (!out.mode) out.mode = "batch";
  if (!out.status) out.status = "staging";
  return out;
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
  // Guests: always free
  if (!owner || owner.isGuest) return (PLAN_KEYS && PLAN_KEYS.free) || "free";

  // No Stripe configured -> treat as free
  if (!stripe) return (PLAN_KEYS && PLAN_KEYS.free) || "free";

  const uid = String(owner.ownerId || "").trim();
  if (!uid) return (PLAN_KEYS && PLAN_KEYS.free) || "free";

  const sub = await searchBestSubscriptionForUser(uid);

  // No subscription -> free
  if (!sub) return (PLAN_KEYS && PLAN_KEYS.free) || "free";

  // Prefer metadata planKey
  let planKey = (sub?.metadata?.planKey ? String(sub.metadata.planKey) : "").trim();

  // Otherwise infer from price id
  if (!planKey) {
    const priceId =
      String(sub?.items?.data?.[0]?.price?.id || "").trim() ||
      String(sub?.items?.data?.[0]?.plan?.id || "").trim();
    planKey = findPlanKeyFromPriceId(priceId);
  }

  // If unknown -> free
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

    // only need these for delete responses
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
        // treat not-found as success (idempotent deletes)
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

function removeDraftFileByItemId(draft, itemId) {
  const d = ensureDraftShape(draft);
  const files = Array.isArray(d.files) ? [...d.files] : [];
  const idx = files.findIndex((f) => String(f?.itemId) === String(itemId));
  if (idx >= 0) files.splice(idx, 1);
  return { nextDraft: { ...d, files }, removed: idx >= 0 };
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
    const { threadId, itemId } = req.body || {};
    if (!isUuid(threadId)) return res.status(400).json({ message: "threadId must be a UUID" });
    if (!isUuid(itemId)) return res.status(400).json({ message: "itemId must be a UUID" });

    // 1) load thread (must exist & not deleted)
    const tRes = await pool.query(
      `
      SELECT draft, draft_rev
      FROM threads
      WHERE user_id = $1 AND thread_id = $2 AND deleted_at IS NULL
      LIMIT 1
      `,
      [owner.ownerId, threadId]
    );

    if (tRes.rowCount === 0) return res.status(404).json({ message: "Thread not found" });

    const row = tRes.rows[0];
    const draft = ensureDraftShape(row.draft);

    // 2) use media_objects as source of truth for what to delete
    const mRes = await pool.query(
      `
      SELECT object_id, b2_key, bytes, status
      FROM media_objects
      WHERE owner_id = $1
        AND thread_id = $2
        AND item_id = $3
        AND deleted_at IS NULL
        AND status IN ('active','pending')
      `,
      [owner.ownerId, threadId, itemId]
    );

    // If DB has nothing, we can still try draft b2 key as fallback
    const dbRows = Array.isArray(mRes.rows) ? mRes.rows : [];

    let fallbackKey = null;
    {
      const files = Array.isArray(draft.files) ? draft.files : [];
      const entry = files.find((f) => String(f?.itemId) === String(itemId));
      fallbackKey = entry?.audio?.b2?.key ? String(entry.audio.b2.key) : null;
    }

    const keysToDelete = dbRows.map((r) => String(r.b2_key || "")).filter(Boolean);
    if (keysToDelete.length === 0 && !fallbackKey) {
      return res.status(404).json({ message: "Media not found for this item" });
    }

    const bucket = process.env.B2_BUCKET;
    if (!bucket) return res.status(500).json({ message: "Missing B2_BUCKET env var" });

    // 3) delete from B2 first (idempotent: not-found treated as success)
    const uniqKeys = Array.from(new Set([...(keysToDelete || []), ...(fallbackKey ? [fallbackKey] : [])]));
    const del = await deleteB2KeysWithLimit({ bucket, keys: uniqKeys, concurrency: 4 });

    // If ANY hard failure -> don’t change DB (so storage accounting stays consistent)
    if (del.failed.length > 0) {
      return res.status(502).json({
        message: "Failed to delete one or more files from storage (B2). No DB changes applied.",
        code: "B2_DELETE_FAILED",
        failed: del.failed,
      });
    }

    // 4) DB updates (draft + media_objects + chat_items) in a transaction
    const client = await pool.connect();
    let nextRev = Number(row.draft_rev || 0) + 1;
    let freedBytes = 0;

    try {
      await client.query("BEGIN");

      // lock thread row and re-read draft_rev to avoid clobber
      const lockT = await client.query(
        `
        SELECT draft, draft_rev
        FROM threads
        WHERE user_id = $1 AND thread_id = $2 AND deleted_at IS NULL
        FOR UPDATE
        `,
        [owner.ownerId, threadId]
      );
      if (lockT.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Thread not found" });
      }

      const curDraft = ensureDraftShape(lockT.rows[0].draft);
      const curRev = Number(lockT.rows[0].draft_rev || 0) || 0;
      nextRev = curRev + 1;

      const { nextDraft } = removeDraftFileByItemId(curDraft, itemId);

      await client.query(
        `
        UPDATE threads
        SET draft = $3::jsonb,
            draft_rev = $4,
            draft_updated_at = now(),
            updated_at = now()
        WHERE user_id = $1 AND thread_id = $2
        `,
        [owner.ownerId, threadId, JSON.stringify(nextDraft), nextRev]
      );

      // mark chat_items for that item deleted (best for UI/consistency)
      await client.query(
        `
        UPDATE chat_items
        SET deleted_at = now(), updated_at = now()
        WHERE owner_id = $1 AND thread_id = $2 AND item_id = $3 AND deleted_at IS NULL
        `,
        [owner.ownerId, threadId, itemId]
      );

      if (dbRows.length > 0) {
        freedBytes = dbRows.reduce((acc, r) => acc + (Number(r.bytes || 0) || 0), 0);

        // delete all matching objects for this item
        await client.query(
          `
          UPDATE media_objects
          SET status = 'deleted',
              deleted_at = now(),
              updated_at = now(),
              expires_at = NULL
          WHERE owner_id = $1
            AND thread_id = $2
            AND item_id = $3
            AND deleted_at IS NULL
            AND status IN ('active','pending')
          `,
          [owner.ownerId, threadId, itemId]
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

    // 5) return updated storage info
    const usedAfter = await getActiveStorageUsedBytes(owner.ownerId);
    const planKey = await resolvePlanKeyForOwner(owner);
    const ent = getEntitlementsForPlanKey(planKey);

    return res.status(200).json({
      ok: true,
      threadId,
      itemId,
      draftRev: nextRev,
      b2: { deletedKeys: del.deleted.length },
      freedBytes,
      storage: {
        usedBytes: usedAfter,
        limitBytes: ent.activeStorageBytesCap,
      },
      planKey: ent.planKey,
    });
  } catch (e) {
    console.error("[threads/draft/delete] error", e);
    return res.status(e?.statusCode || 500).json({ message: e?.message || "Server error" });
  }
}
