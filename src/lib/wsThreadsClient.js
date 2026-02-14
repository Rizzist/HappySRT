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

  let ws = null;
  let closedByUser = false;

  let reconnectAttempt = 0;
  let reconnectTimer = null;

  let helloTimer = null;
  const HELLO_TIMEOUT_MS = 8000;

  function emitStatus(status, extra) {
    if (typeof onStatus === "function") {
      onStatus({ status, threadId, ts: nowIso(), ...(extra || {}) });
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

  function scheduleReconnect() {
    if (!reconnect) return;
    clearReconnect();

    reconnectAttempt = Math.min(reconnectAttempt + 1, 8);
    const ms = Math.min(1000 * Math.pow(2, reconnectAttempt - 1), 15000);

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

  async function connect() {
    if (typeof window === "undefined") return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    closedByUser = false;
    emitStatus("connecting");

    ws = new WebSocket(WS_URL);

    ws.onopen = async () => {
      reconnectAttempt = 0;

      // socket is open, but NOT authed yet
      emitStatus("socket_open");

      let jwt = null;
      try {
        jwt = typeof getJwt === "function" ? await getJwt() : null;
      } catch (e) {
        emitStatus("error", { message: "Failed to get Appwrite JWT" });
        try {
          ws.close(4001, "jwt_failed");
        } catch {}
        return;
      }

      sendRaw({
        type: "HELLO",
        threadId,
        ts: nowIso(),
        payload: { jwt, threadId, client: clientState || null },
      });

      armHelloTimeout();
    };

    ws.onmessage = (evt) => {
      const msg = safeJsonParse(evt?.data);
      if (!msg) return;

      if (String(msg?.type || "") === "HELLO_OK") {
        clearHelloTimeout();
        emitStatus("ready", { serverTime: msg?.payload?.serverTime || null });
      }

      if (typeof onEvent === "function") onEvent(msg);
    };

    ws.onerror = (evt) => {
      if (typeof onError === "function") onError(evt);
      emitStatus("error", { message: "WebSocket error" });
    };

    ws.onclose = (evt) => {
      clearHelloTimeout();
      emitStatus("disconnected", { code: evt?.code, reason: evt?.reason });
      if (!closedByUser) scheduleReconnect();
    };
  }

  function disconnect(code, reason) {
    closedByUser = true;
    clearReconnect();
    clearHelloTimeout();

    if (ws) {
      try {
        ws.close(code || 1000, reason || "client_close");
      } catch {}
    }
    ws = null;
    emitStatus("disconnected");
  }

  function isConnected() {
    return Boolean(ws && ws.readyState === WebSocket.OPEN);
  }

  function send(type, payload) {
    return sendRaw({ type, threadId, ts: nowIso(), payload: payload || {} });
  }

  return { connect, disconnect, isConnected, send };
}
