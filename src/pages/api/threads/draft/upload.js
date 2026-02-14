// pages/api/threads/draft/upload.js
import formidable from "formidable";
import fs from "fs";
import crypto from "crypto";
import { pool } from "../../../../server/crdb";
import { requireOwner } from "../../../../server/owner";
import { bytesLimitForOwner, getUsedBytes } from "../../../../server/quota";
import { b2PutFile, sanitizeFilename } from "../../../../server/b2";

export const config = {
  api: { bodyParser: false },
};

function isUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(v || "")
  );
}

function nowIso() {
  return new Date().toISOString();
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
  // formidable often returns arrays even when multiples:false
  if (Array.isArray(v)) return v[0] || null;
  return v;
}

function safeUnlink(p) {
  if (!p) return;
  try {
    fs.unlinkSync(p);
  } catch {}
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ message: "Method not allowed" });

  let owner;
  try {
    owner = await requireOwner(req, res);
  } catch (e) {
    return res.status(e.statusCode || 401).json({ message: e.message || "Unauthorized" });
  }

  const form = formidable({
    multiples: false,
    keepExtensions: true,
    maxFileSize: 50 * 1024 * 1024,
  });

  // ✅ IMPORTANT: await the parse so Next doesn't warn
  await new Promise((resolve) => {
    form.parse(req, async (err, fields, files) => {
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

        // helpful while debugging
        // console.log("[draft/upload] file keys", Object.keys(files || {}));
        // console.log("[draft/upload] uploaded raw", uploaded);

        if (uploaded) {
          // support both formidable shapes (filepath vs path, originalFilename vs name)
          const filepath = uploaded.filepath || uploaded.path;
          const filename =
            uploaded.originalFilename || uploaded.name || uploaded.newFilename || "audio.mp3";
          const mimeRaw = uploaded.mimetype || uploaded.type || "";
          const bytes = Number(uploaded.size || 0);

          console.log("[draft/upload] file meta", {
            filename,
            mimetype: uploaded.mimetype,
            type: uploaded.type,
            bytes,
          });

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

          // quota check
          const used = await getUsedBytes(owner.ownerId);
          const limit = bytesLimitForOwner({ isGuest: owner.isGuest, user: owner.user });

          if (used + bytes > limit) {
            safeUnlink(filepath);
            res.status(413).json({
              message: `Storage limit exceeded. Used ${used} bytes, trying to add ${bytes} bytes, limit ${limit} bytes.`,
              code: "STORAGE_LIMIT_EXCEEDED",
              usedBytes: used,
              limitBytes: limit,
            });
            return resolve();
          }

          const objectId = crypto.randomUUID();
          const b2Key = makeB2Key({
            ownerId: owner.ownerId,
            threadId,
            itemId,
            objectId,
            filename,
          });

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
        }

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

        const usedAfter = await getUsedBytes(owner.ownerId);
        const limitAfter = bytesLimitForOwner({ isGuest: owner.isGuest, user: owner.user });

        res.status(200).json({
          ok: true,
          threadId,
          itemId,
          draftRev: nextRev,
          draftUpdatedAt: nowIso(),
          draftFile: baseEntry,
          storage: { usedBytes: usedAfter, limitBytes: limitAfter },
        });
        return resolve();
      } catch (e) {
        console.error("[draft/upload] error", e);
        if (!res.headersSent) {
          res.status(500).json({ message: e.message || "Server error" });
        }
        return resolve();
      }
    });
  });
}
