// pages/api/threads/draft/upload.js
import formidable from "formidable";
import fs from "fs";
import crypto from "crypto";
import Stripe from "stripe";
import { pool } from "../../../../server/crdb";
import { requireOwner } from "../../../../server/owner";
import { b2PutFile, sanitizeFilename } from "../../../../server/b2";

import PlansImport from "../../../../shared/plans";
const Plans = (PlansImport && (PlansImport.default || PlansImport)) || {};
const { PLANS, PLAN_KEYS, getPlanByKey } = Plans;

export const config = {
  api: { bodyParser: false },
};

const stripeSecret = process.env.STRIPE_SECRET_KEY || "";
const stripe = stripeSecret ? new Stripe(stripeSecret) : null;

// NOTE: formidable maxFileSize is a pre-parse guard.
// Your plan-level maxFileBytes is enforced AFTER parse.
// If you actually intend to allow multi-GB uploads, ensure your infra supports it.
const ABSOLUTE_MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 12 * 1024 * 1024 * 1024); // 12GB

function isUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(v || "")
  );
}

function nowIso() {
  return new Date().toISOString();
}

function ymKeyUTC() {
  // e.g. "2026-02" in UTC
  return new Date().toISOString().slice(0, 7);
}

function ensureDraftShape(d) {
  const out = d && typeof d === "object" ? { ...d } : {};
  if (!Array.isArray(out.files)) out.files = [];
  if (!out.shared || typeof out.shared !== "object") out.shared = {};
  if (!out.mode) out.mode = "batch";
  if (!out.status) out.status = "staging";
  return out;
}

function findFileIndex(files, itemId) {
  return files.findIndex((f) => f && String(f.itemId) === String(itemId));
}

function parseJsonField(s) {
  if (!s) return null;
  try {
    return JSON.parse(String(s));
  } catch {
    return null;
  }
}

function makeB2Key({ ownerId, threadId, itemId, objectId, filename }) {
  const safe = sanitizeFilename(filename);
  return `owners/${ownerId}/threads/${threadId}/items/${itemId}/${objectId}/${safe}`;
}

function normalizeUploaded(files, fieldName) {
  const v = files ? files[fieldName] : null;
  if (!v) return null;
  if (Array.isArray(v)) return v[0] || null;
  return v;
}

function safeUnlink(p) {
  if (!p) return;
  try {
    fs.unlinkSync(p);
  } catch {}
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

  // No Stripe configured: safest is to treat as free
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
  const plan = (typeof getPlanByKey === "function" ? getPlanByKey(planKey) : null) || getPlanByKey?.(freeKey) || null;

  const e = (plan && plan.entitlements) || {};
  const out = {
    planKey: String(plan?.key || planKey || freeKey),
    planLabel: String(plan?.label || plan?.name || out?.planKey || freeKey),

    maxFileBytes: Math.max(0, Number(e.maxFileBytes || 0) || 0),
    monthlyUploadBytesCap: Math.max(0, Number(e.monthlyUploadBytesCap || 0) || 0),
    activeStorageBytesCap: Math.max(0, Number(e.activeStorageBytesCap || 0) || 0),
  };

  return out;
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

async function getMonthlyUsage(ownerId, ym) {
  const r = await pool.query(
    `
    SELECT upload_bytes, upload_count
    FROM monthly_upload_usage
    WHERE owner_id = $1 AND ym = $2
    `,
    [ownerId, ym]
  );
  return {
    usedBytes: Number(r.rows?.[0]?.upload_bytes || 0) || 0,
    usedCount: Number(r.rows?.[0]?.upload_count || 0) || 0,
  };
}

// Reserve bytes/count for this month in a transaction (row locked).
// Returns { ok, usedBytes, usedCount }.
// If not ok, reservation is NOT applied.
async function reserveMonthlyUpload({ ownerId, ym, bytesToAdd, capBytes }) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `
      INSERT INTO monthly_upload_usage (owner_id, ym, upload_bytes, upload_count)
      VALUES ($1, $2, 0, 0)
      ON CONFLICT (owner_id, ym) DO NOTHING
      `,
      [ownerId, ym]
    );

    const sel = await client.query(
      `
      SELECT upload_bytes, upload_count
      FROM monthly_upload_usage
      WHERE owner_id = $1 AND ym = $2
      FOR UPDATE
      `,
      [ownerId, ym]
    );

    const usedBytes = Number(sel.rows?.[0]?.upload_bytes || 0) || 0;
    const usedCount = Number(sel.rows?.[0]?.upload_count || 0) || 0;

    // Cap <= 0 means uploads disabled for this plan
    if (!(capBytes > 0)) {
      await client.query("ROLLBACK");
      return { ok: false, usedBytes, usedCount, reason: "cap_disabled" };
    }

    if (usedBytes + bytesToAdd > capBytes) {
      await client.query("ROLLBACK");
      return { ok: false, usedBytes, usedCount, reason: "cap_exceeded" };
    }

    const nextBytes = usedBytes + bytesToAdd;
    const nextCount = usedCount + 1;

    await client.query(
      `
      UPDATE monthly_upload_usage
      SET upload_bytes = $3,
          upload_count = $4,
          updated_at = now()
      WHERE owner_id = $1 AND ym = $2
      `,
      [ownerId, ym, nextBytes, nextCount]
    );

    await client.query("COMMIT");
    return { ok: true, usedBytes: nextBytes, usedCount: nextCount };
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw e;
  } finally {
    client.release();
  }
}

// Best-effort compensation if we reserved monthly bytes but later failed.
async function undoMonthlyReservation({ ownerId, ym, bytesToSubtract }) {
  try {
    await pool.query(
      `
      UPDATE monthly_upload_usage
      SET upload_bytes = GREATEST(upload_bytes - $3, 0),
          upload_count = GREATEST(upload_count - 1, 0),
          updated_at = now()
      WHERE owner_id = $1 AND ym = $2
      `,
      [ownerId, ym, bytesToSubtract]
    );
  } catch {
    // swallow; this is best-effort
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ message: "Method not allowed" });
  return res.status(405).json({ message: "Method not allowed" });
  // deprecated endpoint
  
  let owner;
  try {
    owner = await requireOwner(req, res);
  } catch (e) {
    return res.status(e.statusCode || 401).json({ message: e.message || "Unauthorized" });
  }

  const form = formidable({
    multiples: false,
    keepExtensions: true,
    maxFileSize: ABSOLUTE_MAX_UPLOAD_BYTES,
  });

  await new Promise((resolve) => {
    form.parse(req, async (err, fields, files) => {
      let reservedMonthly = null; // { ym, bytes }
      let filepathToCleanup = null;
      let insertedObject = null; // { ownerId, objectId } for cleanup if needed

      try {
        if (err) {
          res.status(400).json({ message: err.message || "Invalid upload" });
          return resolve();
        }

        const threadId = String(fields.threadId || "");
        const itemId = String(fields.itemId || "");
        const clientFileId = String(fields.clientFileId || "");
        const sourceType = String(fields.sourceType || "upload"); // "upload" | "url"
        const url = String(fields.url || "");
        const title = String(fields.title || "New Thread");
        const localMeta = parseJsonField(fields.localMeta);

        if (!isUuid(threadId)) {
          res.status(400).json({ message: "threadId must be a UUID" });
          return resolve();
        }
        if (!isUuid(itemId)) {
          res.status(400).json({ message: "itemId must be a UUID" });
          return resolve();
        }
        if (!clientFileId) {
          res.status(400).json({ message: "clientFileId is required" });
          return resolve();
        }

        // thread must exist (for signed-in); for guest allow auto-create
        const tRes = await pool.query(
          `SELECT user_id, thread_id
           FROM threads
           WHERE user_id = $1 AND thread_id = $2 AND deleted_at IS NULL
           LIMIT 1`,
          [owner.ownerId, threadId]
        );

        if (tRes.rowCount === 0) {
          if (!owner.isGuest) {
            res.status(404).json({ message: "Thread not found" });
            return resolve();
          }

          await pool.query(
            `
            INSERT INTO threads (user_id, thread_id, title, data, version, draft, draft_rev)
            VALUES ($1, $2, $3, $4::jsonb, 1, $5::jsonb, 0)
            ON CONFLICT (user_id, thread_id) DO NOTHING
            `,
            [
              owner.ownerId,
              threadId,
              title || "New Thread",
              JSON.stringify({ kind: "thread", items: [] }),
              JSON.stringify({ status: "staging", mode: "batch", shared: {}, files: [] }),
            ]
          );
        }

        const t2 = await pool.query(
          `SELECT title, draft, draft_rev
           FROM threads
           WHERE user_id = $1 AND thread_id = $2 AND deleted_at IS NULL
           LIMIT 1`,
          [owner.ownerId, threadId]
        );

        if (t2.rowCount === 0) {
          res.status(404).json({ message: "Thread not found" });
          return resolve();
        }

        const row = t2.rows[0];
        const currentDraft = ensureDraftShape(row.draft);
        const currentRev = Number(row.draft_rev || 0);
        const filesArr = Array.isArray(currentDraft.files) ? [...currentDraft.files] : [];

        const baseEntry = {
          itemId,
          clientFileId,
          sourceType,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };

        if (localMeta && typeof localMeta === "object") baseEntry.local = localMeta;

        if (sourceType === "url") {
          if (!url || !/^https?:\/\//i.test(url)) {
            res.status(400).json({ message: "Valid url is required for sourceType=url" });
            return resolve();
          }
          baseEntry.url = url;
          baseEntry.stage = "linked";
        }

        // ✅ normalize file
        const uploaded = normalizeUploaded(files, "file");

        // Only enforce upload quotas if an actual file is being uploaded
        let ent = null;
        let planKey = null;

        if (uploaded) {
          // support both formidable shapes (filepath vs path, originalFilename vs name)
          const filepath = uploaded.filepath || uploaded.path;
          filepathToCleanup = filepath;

          const filename =
            uploaded.originalFilename || uploaded.name || uploaded.newFilename || "audio.mp3";
          const mimeRaw = uploaded.mimetype || uploaded.type || "";
          const bytes = Number(uploaded.size || 0) || 0;

          const mimeLower = String(mimeRaw).toLowerCase();
          const filenameLower = String(filename).toLowerCase();

          const isAudio = mimeLower.startsWith("audio/");
          const isMp3Name = filenameLower.endsWith(".mp3");

          // allow mp3 even if it comes through as octet-stream (very common)
          const allowOctetStreamMp3 =
            (mimeLower === "application/octet-stream" || mimeLower === "") && isMp3Name;

          if (!isAudio && !allowOctetStreamMp3) {
            safeUnlink(filepath);
            res.status(415).json({
              message: "Only audio uploads are accepted (convert to mp3 client-side first).",
              code: "UNSUPPORTED_MEDIA_TYPE",
              mime: mimeRaw || null,
              filename,
            });
            return resolve();
          }

          // Resolve Stripe plan -> entitlements
          planKey = await resolvePlanKeyForOwner(owner);
          ent = getEntitlementsForPlanKey(planKey);

          // 1) Per-file limit
          if (ent.maxFileBytes > 0 && bytes > ent.maxFileBytes) {
            safeUnlink(filepath);
            res.status(413).json({
              message: `File too large for your plan.`,
              code: "MAX_FILE_SIZE_EXCEEDED",
              planKey: ent.planKey,
              fileBytes: bytes,
              maxFileBytes: ent.maxFileBytes,
            });
            return resolve();
          }

          // 2) Active storage cap (total stored)
          const usedStorage = await getActiveStorageUsedBytes(owner.ownerId);
          const storageCap = ent.activeStorageBytesCap;

          if (storageCap > 0 && usedStorage + bytes > storageCap) {
            safeUnlink(filepath);
            res.status(413).json({
              message: `Storage limit exceeded. Upgrade to upload more.`,
              code: "STORAGE_LIMIT_EXCEEDED",
              planKey: ent.planKey,
              storage: {
                usedBytes: usedStorage,
                limitBytes: storageCap,
                tryingToAddBytes: bytes,
              },
            });
            return resolve();
          }

          // 3) Monthly upload bytes cap (reserve first, row-locked)
          const ym = ymKeyUTC();
          const monthlyCap = ent.monthlyUploadBytesCap;

          const reserve = await reserveMonthlyUpload({
            ownerId: owner.ownerId,
            ym,
            bytesToAdd: bytes,
            capBytes: monthlyCap,
          });

          if (!reserve.ok) {
            safeUnlink(filepath);

            // read current month usage to return consistent info
            const current = await getMonthlyUsage(owner.ownerId, ym);

            res.status(403).json({
              message: `Monthly upload quota reached. Upgrade to upload more this month.`,
              code: "MONTHLY_UPLOAD_LIMIT_EXCEEDED",
              planKey: ent.planKey,
              month: ym,
              monthly: {
                usedBytes: current.usedBytes,
                limitBytes: monthlyCap,
                remainingBytes: Math.max(0, (monthlyCap || 0) - current.usedBytes),
                usedCount: current.usedCount,
              },
            });
            return resolve();
          }

          reservedMonthly = { ym, bytes };

          // ---- Proceed with upload ----
          const objectId = crypto.randomUUID();
          const b2Key = makeB2Key({
            ownerId: owner.ownerId,
            threadId,
            itemId,
            objectId,
            filename,
          });

          // Insert pending media row (expires if something goes wrong)
          await pool.query(
            `
            INSERT INTO media_objects (
              owner_id, object_id, thread_id, item_id,
              b2_key, filename, mime, bytes,
              status, expires_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', now() + interval '10 minutes')
            `,
            [owner.ownerId, objectId, threadId, itemId, b2Key, filename, mimeRaw || "audio/mpeg", bytes]
          );

          insertedObject = { ownerId: owner.ownerId, objectId };

          await b2PutFile({
            bucket: process.env.B2_BUCKET,
            key: b2Key,
            filepath,
            contentType: mimeRaw || "audio/mpeg",
          });

          await pool.query(
            `
            UPDATE media_objects
            SET status='active', expires_at=NULL, updated_at=now()
            WHERE owner_id=$1 AND object_id=$2
            `,
            [owner.ownerId, objectId]
          );

          baseEntry.audio = {
            b2: {
              key: b2Key,
              bytes,
              mime: mimeRaw || "audio/mpeg",
              filename,
              objectId,
            },
          };
          baseEntry.stage = "uploaded";

          safeUnlink(filepath);
          filepathToCleanup = null;
        }

        // Update draft
        const idx = findFileIndex(filesArr, itemId);
        if (idx >= 0) filesArr[idx] = { ...filesArr[idx], ...baseEntry, updatedAt: nowIso() };
        else filesArr.unshift(baseEntry);

        const nextDraft = { ...currentDraft, files: filesArr, updatedAt: nowIso() };
        const nextRev = currentRev + 1;

        await pool.query(
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

        // Return updated usage info
        const usedStorageAfter = await getActiveStorageUsedBytes(owner.ownerId);

        const out = {
          ok: true,
          threadId,
          itemId,
          draftRev: nextRev,
          draftUpdatedAt: nowIso(),
          draftFile: baseEntry,
        };

        if (reservedMonthly) {
          const ym = reservedMonthly.ym;

          // resolve plan again only if needed for limits in response
          const finalPlanKey = planKey || (await resolvePlanKeyForOwner(owner));
          const ent2 = ent || getEntitlementsForPlanKey(finalPlanKey);

          const monthly = await getMonthlyUsage(owner.ownerId, ym);

          out.planKey = ent2.planKey;
          out.storage = {
            usedBytes: usedStorageAfter,
            limitBytes: ent2.activeStorageBytesCap,
          };
          out.monthly = {
            month: ym,
            usedBytes: monthly.usedBytes,
            limitBytes: ent2.monthlyUploadBytesCap,
            remainingBytes: Math.max(0, (ent2.monthlyUploadBytesCap || 0) - monthly.usedBytes),
            usedCount: monthly.usedCount,
          };
        }

        res.status(200).json(out);
        return resolve();
      } catch (e) {
        console.error("[draft/upload] error", e);

        // Best-effort cleanup: unlink temp file
        if (filepathToCleanup) safeUnlink(filepathToCleanup);

        // Best-effort cleanup: mark pending media object failed so it won't hang around
        if (insertedObject?.ownerId && insertedObject?.objectId) {
          try {
            await pool.query(
              `
              UPDATE media_objects
              SET status='failed', expires_at = now() + interval '10 minutes', updated_at=now()
              WHERE owner_id=$1 AND object_id=$2 AND status='pending'
              `,
              [insertedObject.ownerId, insertedObject.objectId]
            );
          } catch {}
        }

        // Best-effort compensation: undo monthly reservation if we had one
        if (reservedMonthly?.ym && reservedMonthly?.bytes) {
          await undoMonthlyReservation({
            ownerId: owner.ownerId,
            ym: reservedMonthly.ym,
            bytesToSubtract: reservedMonthly.bytes,
          });
        }

        if (!res.headersSent) {
          res.status(e?.statusCode || 500).json({
            message: e?.message || "Server error",
          });
        }
        return resolve();
      }
    });
  });
}
