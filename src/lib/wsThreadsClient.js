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

function uuid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
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

  // HELLO_OK tracking (important for uploads / privileged actions)
  let helloOk = false;

  // Keep the latest client state (optional)
  let latestClientState = clientState || null;

  // Message subscribers (lets upload helper wait for specific server replies)
  const msgListeners = new Set();

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

    const base = Math.min(1000 * Math.pow(2, reconnectAttempt - 1), 15000);
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

  function sendBinary(data) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(data);
      return true;
    } catch (e) {
      if (typeof onError === "function") onError(e);
      return false;
    }
  }

  function getBufferedAmount() {
    try {
      return ws ? Number(ws.bufferedAmount || 0) : 0;
    } catch {
      return 0;
    }
  }

  async function waitForBufferedBelow(maxBytes, timeoutMs) {
    const max = Math.max(0, Number(maxBytes || 0) || 0);
    const timeout = Math.max(200, Number(timeoutMs || 0) || 0);

    if (!max) return true;
    const start = Date.now();

    while (true) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      const b = getBufferedAmount();
      if (b <= max) return true;
      if (Date.now() - start > timeout) return false;
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  // Ensure payload is an object, shallow cloned, with a correct threadId.
  function normalizePayload(payload) {
    const p = payload && typeof payload === "object" ? { ...payload } : {};
    p.threadId = TID;
    return p;
  }

  function onMessage(fn) {
    if (typeof fn !== "function") return () => {};
    msgListeners.add(fn);
    return () => {
      try {
        msgListeners.delete(fn);
      } catch {}
    };
  }

  async function waitForReady(timeoutMs) {
    const timeout = Math.max(500, Number(timeoutMs || 0) || 0);

    // already ready
    if (ws && ws.readyState === WebSocket.OPEN && helloOk) return true;

    const start = Date.now();
    return new Promise((resolve) => {
      const t = setInterval(() => {
        const ok = ws && ws.readyState === WebSocket.OPEN && helloOk;
        if (ok) {
          clearInterval(t);
          resolve(true);
          return;
        }
        if (Date.now() - start > timeout) {
          clearInterval(t);
          resolve(false);
        }
      }, 50);
    });
  }

  async function connect() {
    if (typeof window === "undefined") return;
    if (!TID) {
      emitStatus("error", { message: "Missing threadId for WS client" });
      return;
    }

    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    closedByUser = false;
    clearReconnect();
    clearHelloTimeout();

    helloOk = false;

    emitStatus("connecting");

    ws = new WebSocket(WS_URL);

    ws.onopen = async () => {
      reconnectAttempt = 0;
      emitStatus("socket_open");

      let jwt = null;
      try {
        jwt = typeof getJwt === "function" ? await getJwt() : null;
      } catch (e) {
        emitStatus("error", { message: "Failed to get JWT" });
        safeClose(ws, 4001, "jwt_failed");
        return;
      }

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
        helloOk = true;
        clearHelloTimeout();
        emitStatus("ready", { serverTime: msg?.payload?.serverTime || null });
      } else if (type === "ERROR" || type === "HELLO_ERROR" || type === "HELLO_FAIL") {
        clearHelloTimeout();
      }

      // notify subscribers FIRST (upload helper waits here)
      try {
        for (const fn of Array.from(msgListeners)) {
          try {
            fn(msg);
          } catch {}
        }
      } catch {}

      // then pass to ThreadsContext
      if (typeof onEvent === "function") onEvent(msg);
    };

    ws.onerror = (evt) => {
      if (typeof onError === "function") onError(evt);
    };

    ws.onclose = (evt) => {
      const code = Number(evt?.code || 0) || 0;
      const reason = String(evt?.reason || "");
      const wasClean = !!evt?.wasClean;

      clearHelloTimeout();
      helloOk = false;

      if (!closedByUser) {
        if (!wasClean && code && code !== 1000 && code !== 1001) {
          emitStatus("error", { message: `WS closed (${code}) ${reason || ""}`.trim() });
        } else {
          emitStatus("disconnected", { code, reason: reason || null });
        }

        ws = null;
        scheduleReconnect({ code, reason: reason || null });
        return;
      }

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
    helloOk = false;

    safeClose(cur, code || 1000, reason || "client_disconnect");
    emitStatus("disconnected", { code: code || 1000, reason: reason || "client_disconnect" });
  }

  function isConnected() {
    return !!ws && ws.readyState === WebSocket.OPEN;
  }

function send(type, payload, requestId) {
  const t = safeStr(type);
  if (!t) return false;

  const p = normalizePayload(payload);

  const msg = {
    type: t,
    threadId: TID,
    ts: nowIso(),
    payload: p,
  };

  if (requestId) msg.requestId = String(requestId);

  return sendRaw(msg);
}


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
    sendBinary,
    getBufferedAmount,
    waitForBufferedBelow,
    waitForReady,
    onMessage,
    setClientState,
    getThreadId,
    // handy for correlation ids in helpers
    uuid,
  };
}
