// lib/wsThreadsClient.js
function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(s) {
  try {
    return JSON.parse(String(s || ""));
  } catch {
    return null;
  }
}

function safeStr(x) {
  const s = String(x == null ? "" : x).trim();
  return s || "";
}

function safeClose(ws, code, reason) {
  try {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close(code || 1000, reason || "client_close");
    }
  } catch {}
}

export function createThreadWsClient({
  url,
  threadId,
  getJwt,
  clientState,
  onStatus,
  onEvent,
  onError,
  reconnect = true,
}) {
  const WS_URL = url || process.env.NEXT_PUBLIC_HAPPYSRT_WS_URL || "ws://localhost:8080";
  const TID = safeStr(threadId);

  let ws = null;
  let closedByUser = false;

  let reconnectAttempt = 0;
  let reconnectTimer = null;

  let helloTimer = null;
  const HELLO_TIMEOUT_MS = 8000;

  // Keep the latest client state (optional)
  let latestClientState = clientState || null;

  function emitStatus(status, extra) {
    if (typeof onStatus === "function") {
      onStatus({ status, threadId: TID, ts: nowIso(), ...(extra || {}) });
    }
  }

  function clearReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function clearHelloTimeout() {
    if (helloTimer) clearTimeout(helloTimer);
    helloTimer = null;
  }

  function armHelloTimeout() {
    clearHelloTimeout();
    helloTimer = setTimeout(() => {
      emitStatus("error", { message: "HELLO timeout (no HELLO_OK)" });
      try {
        ws?.close(4008, "hello_timeout");
      } catch {}
    }, HELLO_TIMEOUT_MS);
  }

  function scheduleReconnect(extra) {
    if (!reconnect) return;
    if (closedByUser) return;

    clearReconnect();
    reconnectAttempt = Math.min(reconnectAttempt + 1, 8);

    // exp backoff (1s, 2s, 4s...) capped
    const base = Math.min(1000 * Math.pow(2, reconnectAttempt - 1), 15000);
    // small jitter
    const jitter = Math.floor(Math.random() * 350);
    const ms = base + jitter;

    emitStatus("connecting", { reconnecting: true, attempt: reconnectAttempt, waitMs: ms, ...(extra || {}) });

    reconnectTimer = setTimeout(() => {
      if (!closedByUser) connect().catch(() => {});
    }, ms);
  }

  function sendRaw(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch (e) {
      if (typeof onError === "function") onError(e);
      return false;
    }
  }

  // Ensure payload is an object, shallow cloned, with a correct threadId.
  // NOTE: We DO NOT strip legacy translation keys here anymore — we just send what we have.
  function normalizePayload(payload) {
    const p = payload && typeof payload === "object" ? { ...payload } : {};
    p.threadId = TID; // always enforce
    return p;
  }

  async function connect() {
    if (typeof window === "undefined") return;
    if (!TID) {
      emitStatus("error", { message: "Missing threadId for WS client" });
      return;
    }

    // already open/connecting
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    closedByUser = false;
    clearReconnect();
    clearHelloTimeout();

    emitStatus("connecting");

    ws = new WebSocket(WS_URL);

    ws.onopen = async () => {
      reconnectAttempt = 0;

      // socket is open, but not authed yet
      emitStatus("socket_open");

      let jwt = null;
      try {
        jwt = typeof getJwt === "function" ? await getJwt() : null;
      } catch (e) {
        emitStatus("error", { message: "Failed to get JWT" });
        safeClose(ws, 4001, "jwt_failed");
        return;
      }

      // HELLO handshake
      sendRaw({
        type: "HELLO",
        threadId: TID,
        ts: nowIso(),
        payload: {
          jwt,
          threadId: TID,
          client: latestClientState || null,
        },
      });

      armHelloTimeout();
    };

    ws.onmessage = (evt) => {
      const msg = safeJsonParse(evt?.data);
      if (!msg) return;

      const type = String(msg?.type || "");

      if (type === "HELLO_OK") {
        clearHelloTimeout();
        emitStatus("ready", { serverTime: msg?.payload?.serverTime || null });
      } else if (type === "ERROR" || type === "HELLO_ERROR" || type === "HELLO_FAIL") {
        // prevent a late timeout close after an error response
        clearHelloTimeout();
      }

      if (typeof onEvent === "function") onEvent(msg);
    };

    ws.onerror = (evt) => {
      if (typeof onError === "function") onError(evt);
      // don't force-close here; wait for onclose
    };

    ws.onclose = (evt) => {
      const code = Number(evt?.code || 0) || 0;
      const reason = String(evt?.reason || "");
      const wasClean = !!evt?.wasClean;

      clearHelloTimeout();

      // If we didn't explicitly disconnect, attempt reconnect.
      if (!closedByUser) {
        // "abnormal" closes can be treated as error-ish, but still reconnect.
        if (!wasClean && code && code !== 1000 && code !== 1001) {
          emitStatus("error", { message: `WS closed (${code}) ${reason || ""}`.trim() });
        } else {
          emitStatus("disconnected", { code, reason: reason || null });
        }

        // clear instance to allow new WebSocket
        ws = null;

        scheduleReconnect({ code, reason: reason || null });
        return;
      }

      // user initiated
      emitStatus("disconnected", { code, reason: reason || null });
      ws = null;
    };
  }

  function disconnect(code, reason) {
    closedByUser = true;
    clearReconnect();
    clearHelloTimeout();

    const cur = ws;
    ws = null;

    safeClose(cur, code || 1000, reason || "client_disconnect");
    emitStatus("disconnected", { code: code || 1000, reason: reason || "client_disconnect" });
  }

  function isConnected() {
    return !!ws && ws.readyState === WebSocket.OPEN;
  }

  // Generic send
  function send(type, payload) {
    const t = safeStr(type);
    if (!t) return false;

    // NOTE: no translation key stripping; whatever options/translation is present is sent as-is.
    const p = normalizePayload(payload);

    return sendRaw({
      type: t,
      threadId: TID,
      ts: nowIso(),
      payload: p,
    });
  }

  // optional: update the clientState we include in HELLO for future reconnects
  function setClientState(next) {
    latestClientState = next && typeof next === "object" ? { ...next } : null;
  }

  function getThreadId() {
    return TID;
  }

  return {
    connect,
    disconnect,
    isConnected,
    send,
    setClientState,
    getThreadId,
  };
}
