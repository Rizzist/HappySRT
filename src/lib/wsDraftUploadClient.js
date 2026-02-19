// lib/wsDraftUploadClient.js

function nowIso() {
  return new Date().toISOString();
}

function safeStr(x) {
  const s = String(x == null ? "" : x).trim();
  return s || "";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeWsError(message, code, payload) {
  const e = new Error(message || "WebSocket request failed");
  if (code) e.code = code;
  if (payload != null) e.payload = payload;
  return e;
}

function matchesAnyType(msgType, list) {
  const t = String(msgType || "");
  for (const x of Array.isArray(list) ? list : []) {
    if (t === String(x)) return true;
  }
  return false;
}

async function waitForMessage(wsClient, predicate, timeoutMs) {
  const timeout = Math.max(500, Number(timeoutMs || 0) || 0);

  return new Promise((resolve, reject) => {
    const start = Date.now();

    const off = wsClient.onMessage((msg) => {
      try {
        if (!predicate(msg)) return;
        cleanup();
        resolve(msg);
      } catch (e) {
        cleanup();
        reject(e);
      }
    });

    const timer = setInterval(() => {
      if (Date.now() - start > timeout) {
        cleanup();
        reject(makeWsError("Timed out waiting for server response", "WS_TIMEOUT"));
      }
    }, 60);

    function cleanup() {
      try {
        off && off();
      } catch {}
      try {
        clearInterval(timer);
      } catch {}
    }
  });
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function sha256HexOfFile(file) {
  if (!(globalThis.crypto && crypto.subtle)) return "";
  const buf = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buf);
  const b = new Uint8Array(hash);
  let hex = "";
  for (let i = 0; i < b.length; i++) hex += b[i].toString(16).padStart(2, "0");
  return hex;
}

function clampPct(p) {
  const n = Number(p);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export async function uploadDraftFileViaWs({
  wsClient,
  threadId,
  itemId,
  clientFileId,
  file,
  localMeta,
  chunkSize,

  // ✅ NEW
  onProgress, // ({ stage, pct, sentBytes, receivedBytes, bytesTotal, uploadId, itemId })
} = {}) {
  const tid = safeStr(threadId);
  const cfi = safeStr(clientFileId);

  if (!wsClient) throw makeWsError("Missing wsClient", "WS_NO_CLIENT");
  if (!tid || !cfi) throw makeWsError("Missing threadId/clientFileId", "WS_BAD_ARGS");
  if (!(file instanceof File)) throw makeWsError("Missing file", "WS_NO_FILE");

  const ready = await wsClient.waitForReady(12000);
  if (!ready) throw makeWsError("WebSocket not ready yet (no HELLO_OK)", "WS_NOT_READY");
  if (!wsClient.isConnected()) throw makeWsError("WebSocket not connected", "WS_NOT_CONNECTED");

  const reqId = wsClient.uuid ? wsClient.uuid() : `${Date.now()}-${Math.random()}`;

  const filename = file?.name || "upload.mp3";
  const mime = String(file?.type || "application/octet-stream");
  const bytesTotal = Number(file?.size || 0) || 0;

  const beginPayload = {
    filename,
    mime,
    bytesTotal,
    clientFileId: cfi,
    localMeta: localMeta && typeof localMeta === "object" ? localMeta : {},
    clientItemId: safeStr(itemId) || null,
    ts: nowIso(),
  };

  const okBegin = wsClient.send("UPLOAD_BEGIN", beginPayload, reqId);
  if (!okBegin) throw makeWsError("Failed to send UPLOAD_BEGIN", "WS_SEND_FAILED");

  const acceptedMsg = await waitForMessage(
    wsClient,
    (msg) => {
      const t = String(msg?.type || "");
      const p = msg?.payload || {};

      // only treat ERROR as ours if requestId matches
      if (t === "ERROR" && String(msg?.requestId || "") === reqId) {
        throw makeWsError(p?.message || "Upload begin failed", p?.code || "WS_ERROR", p);
      }

      if (t !== "UPLOAD_ACCEPTED") return false;
      if (String(msg?.requestId || "") === reqId) return true;
      return !!p.uploadId;
    },
    20000
  );

  const ap = acceptedMsg?.payload || {};
  const uploadId = safeStr(ap.uploadId);
  if (!uploadId) throw makeWsError("Server did not return uploadId", "WS_NO_UPLOAD_ID", ap);

  const serverItemId = safeStr(ap.itemId) || null;

  const capB64 = Number(ap.chunkBase64MaxLen || 0) || 1024 * 1024;
  const safeRawFromCap = Math.floor((capB64 * 3) / 4);
  const RAW_CHUNK = Math.max(
    64 * 1024,
    Math.min(
      Number(chunkSize || 0) || 256 * 1024,
      Math.max(64 * 1024, Math.floor(safeRawFromCap * 0.9))
    )
  );

  const notify = (payload) => {
    if (typeof onProgress === "function") {
      try {
        onProgress({
          uploadId,
          itemId: serverItemId || safeStr(itemId) || null,
          bytesTotal,
          ...payload,
        });
      } catch {}
    }
  };

  // initial
  notify({ stage: "verifying", pct: 0, sentBytes: 0, receivedBytes: 0 });

  // ✅ listen for server progress + B2 progress
  const off = wsClient.onMessage((msg) => {
    try {
      const t = String(msg?.type || "");
      const p = msg?.payload || {};
      if (safeStr(p.uploadId) !== uploadId) return;

      if (t === "UPLOAD_PROGRESS") {
        notify({
          stage: String(p.stage || "verifying"),
          pct: clampPct(p.pct),
          receivedBytes: Number(p.receivedBytes || 0) || 0,
          sentBytes: null,
        });
      }

      if (t === "UPLOAD_STAGE") {
        notify({
          stage: String(p.stage || ""),
          pct: clampPct(p.pct),
          receivedBytes: null,
          sentBytes: null,
        });
      }

      if (t === "UPLOAD_B2_PROGRESS") {
        notify({
          stage: "uploading",
          pct: clampPct(p.pct),
          sentBytes: Number(p.sentBytes || 0) || 0,
          receivedBytes: null,
        });
      }
    } catch {}
  });

  try {
    // 2) CHUNKS (client-side “verifying” progress)
    let offset = 0;
    let seq = 0;

    let lastClientPct = -1;

    while (offset < bytesTotal) {
      if (!wsClient.isConnected()) throw makeWsError("WebSocket disconnected during upload", "WS_DROPPED");
      await wsClient.waitForBufferedBelow(8 * 1024 * 1024, 15000);

      const end = Math.min(bytesTotal, offset + RAW_CHUNK);
      const buf = await file.slice(offset, end).arrayBuffer();
      const dataBase64 = arrayBufferToBase64(buf);

      const ok = wsClient.send("UPLOAD_CHUNK", { uploadId, seq, dataBase64 }, reqId);
      if (!ok) throw makeWsError("Failed to send upload chunk", "WS_CHUNK_SEND_FAILED", { uploadId, seq });

      offset = end;
      seq += 1;

      // local pct update (smooth UI)
      const pct = bytesTotal > 0 ? clampPct((offset / bytesTotal) * 100) : null;
      if (pct != null && pct !== lastClientPct) {
        lastClientPct = pct;
        notify({ stage: "verifying", pct, sentBytes: offset, receivedBytes: null });
      }

      await sleep(0);
    }

    // 3) END + wait COMPLETE
    const sha256 = await sha256HexOfFile(file).catch(() => "");
    const okEnd = wsClient.send("UPLOAD_END", { uploadId, sha256 }, reqId);
    if (!okEnd) throw makeWsError("Failed to send UPLOAD_END", "WS_SEND_FAILED");

    const doneMsg = await waitForMessage(
      wsClient,
      (msg) => {
        const t = String(msg?.type || "");
        const p = msg?.payload || {};

        if (t === "ERROR" && (String(msg?.requestId || "") === reqId || safeStr(p.uploadId) === uploadId)) {
          throw makeWsError(p?.message || "Upload failed", p?.code || "WS_ERROR", p);
        }

        if (t === "UPLOAD_FAILED" && safeStr(p.uploadId) === uploadId) {
          throw makeWsError(String(p.reason || "Upload failed"), "UPLOAD_FAILED", p);
        }

        if (!matchesAnyType(t, ["UPLOAD_COMPLETE"])) return false;
        if (String(msg?.requestId || "") === reqId) return true;
        return safeStr(p.uploadId) === uploadId;
      },
      180000
    );

    return {
      ...(doneMsg?.payload || {}),
      uploadId,
      itemId: safeStr(doneMsg?.payload?.itemId) || serverItemId,
    };
  } finally {
    try {
      off && off();
    } catch {}
  }
}
