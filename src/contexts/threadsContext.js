// contexts/threadsContext.js
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "./AuthContext";
import { useFfmpeg } from "./FfmpegContext";
import { ensureDefaultThread, loadThreadsState, saveThreadsState, makeNewThread } from "../lib/threadsStore";
import { apiCreateThread, apiRenameThread, apiDeleteThread } from "../lib/api/threads";
import { putLocalMedia, deleteLocalMedia } from "../lib/mediaStore";
import { createThreadWsClient } from "../lib/wsThreadsClient";
import { putMediaIndex, getMediaIndex } from "../lib/mediaIndexStore";
import { putLocalMediaMeta } from "../lib/mediaMetaStore";

const ThreadsContext = createContext(null);

function toArray(threadsById) {
  return Object.values(threadsById || {}).sort((a, b) => {
    const at = Date.parse(a.updatedAt || a.createdAt || 0) || 0;
    const bt = Date.parse(b.updatedAt || b.createdAt || 0) || 0;
    return bt - at;
  });
}

async function hydrateChatItemsWithMediaIndex(scope, threadId, chatItems) {
  if (!scope || !threadId) return chatItems;

  const items = Array.isArray(chatItems) ? chatItems : [];
  if (!items.length) return items;

  const out = [];
  for (const it of items) {
    const cid = String(it?.chatItemId || "");
    if (!cid) {
      out.push(it);
      continue;
    }

    const media = it?.media && typeof it.media === "object" ? it.media : {};
    if (media.clientFileId) {
      out.push(it);
      continue;
    }

    const idx = await getMediaIndex(scope, threadId, cid);
    if (idx?.clientFileId) {
      out.push({
        ...it,
        media: { ...media, clientFileId: String(idx.clientFileId) },
      });
      continue;
    }

    out.push(it);
  }

  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function uuid() {
  if (typeof crypto !== "undefined") {
    if (crypto.randomUUID) return crypto.randomUUID();

    if (crypto.getRandomValues) {
      const buf = new Uint8Array(16);
      crypto.getRandomValues(buf);
      buf[6] = (buf[6] & 0x0f) | 0x40;
      buf[8] = (buf[8] & 0x3f) | 0x80;

      const hex = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
  }

  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function ensureDraftShape(d) {
  const out = d && typeof d === "object" ? { ...d } : {};
  if (!Array.isArray(out.files)) out.files = [];
  if (!out.shared || typeof out.shared !== "object") out.shared = {};
  if (!out.mode) out.mode = "batch";
  if (!out.status) out.status = "staging";
  return out;
}

function ensureServerShape(s) {
  const out = s && typeof s === "object" ? { ...s } : {};
  if (typeof out.updatedAt !== "string") out.updatedAt = null;
  if (typeof out.draftUpdatedAt !== "string") out.draftUpdatedAt = null;
  out.version = Number.isFinite(Number(out.version)) ? Number(out.version) : null;
  out.draftRev = Number.isFinite(Number(out.draftRev)) ? Number(out.draftRev) : null;
  return out;
}

// --- Fix #2 helpers ---
function isBusyDraftFile(f) {
  const stage = String(f?.stage || "");
  return stage === "uploading" || stage === "converting" || stage === "linking";
}

function mergeDraft(serverDraft, localDraft) {
  const s = ensureDraftShape(serverDraft);
  const l = ensureDraftShape(localDraft);

  const serverIds = new Set((s.files || []).map((f) => String(f?.itemId || "")));

  const extras = (l.files || []).filter((f) => {
    const id = String(f?.itemId || "");
    if (!id) return false;
    if (serverIds.has(id)) return false;
    return isBusyDraftFile(f);
  });

  return { ...s, files: [...(s.files || []), ...extras] };
}

function ensureChatItemsArray(x) {
  return Array.isArray(x) ? x.filter(Boolean) : [];
}

function mergeChatItems(prev, incoming) {
  const a = ensureChatItemsArray(prev);
  const b = ensureChatItemsArray(incoming);

  const byId = new Map();
  for (const it of a) byId.set(String(it?.chatItemId || ""), it);
  for (const it of b)
    byId.set(String(it?.chatItemId || ""), {
      ...(byId.get(String(it?.chatItemId || "")) || {}),
      ...(it || {}),
    });

  const out = Array.from(byId.values()).filter((x) => x?.chatItemId);
  out.sort((x, y) => (Date.parse(y?.createdAt || 0) || 0) - (Date.parse(x?.createdAt || 0) || 0));
  return out;
}

function applyChatItemPatch(item, patch) {
  const p = patch && typeof patch === "object" ? patch : {};
  return {
    ...(item || {}),
    ...(p || {}),
    status: p.status ? { ...(item?.status || {}), ...(p.status || {}) } : item?.status || {},
    results: p.results ? { ...(item?.results || {}), ...(p.results || {}) } : item?.results || {},
    updatedAt: p.updatedAt || item?.updatedAt || nowIso(),
  };
}

// ---------- file helpers ----------
function isAudioOrVideoFile(file) {
  const t = String(file?.type || "");
  return t.startsWith("audio/") || t.startsWith("video/");
}

function isMp3(file) {
  const t = String(file?.type || "");
  const n = String(file?.name || "");
  return t === "audio/mpeg" || /\.mp3$/i.test(n);
}

function safeFinite(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : null;
}

function probeDurationSecondsFromSrc({ src, kind }) {
  if (typeof window === "undefined") return Promise.resolve(null);

  const tag = kind === "video" ? "video" : "audio";
  const el = document.createElement(tag);

  el.preload = "metadata";
  el.muted = true;
  el.playsInline = true;

  return new Promise((resolve) => {
    let done = false;

    const cleanup = () => {
      el.removeAttribute("src");
      try {
        el.load();
      } catch {}
      el.onloadedmetadata = null;
      el.onerror = null;
    };

    const finish = (v) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(v);
    };

    const timer = setTimeout(() => finish(null), 6000);

    el.onloadedmetadata = () => {
      clearTimeout(timer);
      const d = safeFinite(el.duration);
      if (!d || !Number.isFinite(d) || d <= 0 || d === Infinity) return finish(null);
      finish(Number(d.toFixed(3)));
    };

    el.onerror = () => {
      clearTimeout(timer);
      finish(null);
    };

    try {
      el.src = String(src || "");
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });
}

async function probeDurationSecondsFromFile(file) {
  if (!file || typeof window === "undefined") return null;
  const url = URL.createObjectURL(file);
  try {
    const isVideo = String(file.type || "").startsWith("video/");
    return await probeDurationSecondsFromSrc({ src: url, kind: isVideo ? "video" : "audio" });
  } finally {
    try {
      URL.revokeObjectURL(url);
    } catch {}
  }
}

async function probeDurationSecondsFromUrl(url) {
  const clean = String(url || "").trim();
  if (!clean) return null;
  return probeDurationSecondsFromSrc({ src: clean, kind: "audio" });
}

function baseName(name) {
  const n = String(name || "media");
  return n.replace(/\.[a-z0-9]+$/i, "") || "media";
}

async function convertToMp3OrPassThrough(file, { ensureFfmpeg, extractAudioToMp3 }) {
  if (isMp3(file)) return file;

  await ensureFfmpeg();

  const out = await extractAudioToMp3(file);
  const mp3File = out && out.file ? out.file : null;

  if (!(mp3File instanceof File)) throw new Error("FFmpeg conversion did not return an mp3 File");

  const wantedName = `${baseName(file?.name)}.mp3`;
  const renamed = mp3File.name === "output.mp3" ? new File([mp3File], wantedName, { type: "audio/mpeg" }) : mp3File;

  if (!String(renamed.type).startsWith("audio/")) {
    return new File([renamed], renamed.name || wantedName, { type: "audio/mpeg" });
  }

  return renamed;
}

// ---------- API helpers ----------
async function postJson(url, jwt, body) {
  const headers = { "content-type": "application/json" };
  if (jwt) headers.authorization = `Bearer ${jwt}`;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body || {}),
    credentials: "include",
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.message || "Request failed");
    err.statusCode = res.status;
    err.code = data?.code;
    throw err;
  }
  return data;
}

async function postForm(url, jwt, formData) {
  const headers = {};
  if (jwt) headers.authorization = `Bearer ${jwt}`;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: formData,
    credentials: "include",
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.message || "Request failed");
    err.statusCode = res.status;
    err.code = data?.code;
    throw err;
  }
  return data;
}

async function apiThreadsIndex(jwt, { since }) {
  return postJson("/api/threads/indexer", jwt, { since: since || null });
}

async function apiGetThread(jwt, { threadId }) {
  return postJson("/api/threads/get", jwt, { threadId });
}

export function ThreadsProvider({ children }) {
  const { user, isAnonymous, getJwt, refreshTokens, applyTokensSnapshot } = useAuth();
   const { extractAudioToMp3, ensureFfmpeg } = useFfmpeg();

  const [threadsById, setThreadsById] = useState({});
  const [activeId, setActiveIdState] = useState("default");
  const [loadingThreads, setLoadingThreads] = useState(true);
  const [syncError, setSyncError] = useState(null);

  const [wsStatus, setWsStatus] = useState("disconnected");
  const [wsError, setWsError] = useState(null);
  const [wsThreadId, setWsThreadId] = useState(null);

  const [liveRunsByThread, setLiveRunsByThread] = useState({});

  const wsClientRef = useRef(null);
  const wsBoundThreadRef = useRef(null);

  const threadsRef = useRef({});
  const activeRef = useRef("default");
  const syncRef = useRef({ indexAt: null });

  useEffect(() => {
    threadsRef.current = threadsById;
  }, [threadsById]);

  useEffect(() => {
    activeRef.current = activeId;
  }, [activeId]);

  const scope = useMemo(() => {
    if (isAnonymous) return "guest";
    return user?.$id ? String(user.$id) : null;
  }, [user?.$id, isAnonymous]);

  const bootedRef = useRef(false);

  const persist = async (nextThreadsById, nextActiveId, nextSync) => {
    if (!scope) return;
    await saveThreadsState(scope, {
      threadsById: nextThreadsById,
      activeId: nextActiveId,
      sync: nextSync || syncRef.current,
    });
  };

  const commit = async (nextThreadsById, nextActiveId, nextSync) => {
    setThreadsById(nextThreadsById);
    setActiveIdState(nextActiveId);

    threadsRef.current = nextThreadsById;
    activeRef.current = nextActiveId;

    if (nextSync) syncRef.current = nextSync;

    await persist(nextThreadsById, nextActiveId, nextSync);
  };

  const getJwtIfAny = async () => {
    if (isAnonymous) return null;
    if (!getJwt) return null;
    const jwt = await getJwt();
    return jwt || null;
  };

  const lastWsToastRef = useRef({ key: null, at: 0 });
  const toastWs = (code, message) => {
    const key = `${String(code || "")}:${String(message || "")}`.slice(0, 180);
    const now = Date.now();
    if (lastWsToastRef.current.key === key && now - lastWsToastRef.current.at < 2500) return;
    lastWsToastRef.current = { key, at: now };
    toast.error(message ? `${code}: ${message}` : String(code || "WS error"));
  };

  // =========================
  // ✅ Token refresh throttling
  // =========================
  const tokenRefreshRef = useRef({ at: 0, inFlight: false });

  const refreshTokensThrottled = async () => {
    // only makes sense for authed users
    if (isAnonymous) return;
    if (typeof refreshTokens !== "function") return;

    const now = Date.now();
    const lastAt = Number(tokenRefreshRef.current?.at || 0) || 0;

    // throttle to avoid spamming /api/auth/tokens
    if (tokenRefreshRef.current?.inFlight) return;
    if (now - lastAt < 3500) return;

    tokenRefreshRef.current = { ...tokenRefreshRef.current, inFlight: true };
    try {
      await refreshTokens();
    } catch {}
    tokenRefreshRef.current = { at: Date.now(), inFlight: false };
  };

  const clearLiveThread = (threadId) => {
    setLiveRunsByThread((prev) => {
      const next = { ...(prev || {}) };
      delete next[String(threadId)];
      return next;
    });
  };

  const patchLiveThread = (threadId, patch) => {
    const tid = String(threadId || "");
    if (!tid) return;
    setLiveRunsByThread((prev) => {
      const cur = (prev && prev[tid]) || {};
      return { ...(prev || {}), [tid]: { ...cur, ...(patch || {}), updatedAt: nowIso() } };
    });
  };

  const disconnectWs = () => {
    try {
      if (wsClientRef.current) wsClientRef.current.disconnect(1000, "thread_switch");
    } catch {}
    wsClientRef.current = null;
    wsBoundThreadRef.current = null;
    setWsThreadId(null);
    setWsStatus("disconnected");
    setWsError(null);
  };

  const applyThreadSnapshot = async (thread, chatItems) => {
    const t = thread && typeof thread === "object" ? thread : null;
    if (!t || !t.id) return;

    const cur = threadsRef.current || {};
    const existing = cur[t.id] || null;

    const mergedDraft = mergeDraft(t.draft, existing?.draft);
    let nextChatItems = mergeChatItems(existing?.chatItems, chatItems || t.chatItems);

    if (scope) {
      try {
        nextChatItems = await hydrateChatItemsWithMediaIndex(scope, t.id, nextChatItems);
      } catch {}
    }

    const nextThread = {
      ...(existing || {}),
      ...t,
      id: String(t.id),
      draft: mergedDraft,
      chatItems: nextChatItems,
      server: ensureServerShape({
        updatedAt: t.updatedAt || null,
        draftUpdatedAt: t.draftUpdatedAt || null,
        version: t.version ?? null,
        draftRev: t.draftRev ?? null,
      }),
    };

    const nextThreads = { ...(cur || {}), [t.id]: nextThread };
    setThreadsById(nextThreads);
    threadsRef.current = nextThreads;

    if (String(activeRef.current) === String(t.id) && scope) {
      try {
        await persist(nextThreads, activeRef.current, syncRef.current);
      } catch {}
    }
  };

  const patchLiveChatItem = (threadId, chatItemId, patch) => {
    const tid = String(threadId || "");
    const cid = String(chatItemId || "");
    if (!tid || !cid) return;

    setLiveRunsByThread((prev) => {
      const cur = (prev && prev[tid]) || {};
      const chatItems = cur.chatItems && typeof cur.chatItems === "object" ? cur.chatItems : {};
      const existing = chatItems[cid] || {};
      const nextPatch = patch && typeof patch === "object" ? patch : {};

      return {
        ...(prev || {}),
        [tid]: {
          ...cur,
          chatItems: {
            ...chatItems,
            [cid]: { ...existing, ...nextPatch, updatedAt: nowIso() },
          },
          updatedAt: nowIso(),
        },
      };
    });
  };

  const handleWsEvent = async (msg) => {
    const type = String(msg?.type || "");
    const threadId = String(msg?.threadId || "");

    if (type === "HELLO_OK") {
      setWsError(null);
      setWsStatus("ready");

      // ✅ Server already sends the live token snapshot in HELLO_OK
      // payload: { mediaTokens, mediaTokensBalance, mediaTokensReserved, pricingVersion, serverTime, ... }
      try {
        const p = msg?.payload || {};
        if (typeof applyTokensSnapshot === "function") {
          applyTokensSnapshot({
            mediaTokens: p.mediaTokens,
            mediaTokensBalance: p.mediaTokensBalance,
            mediaTokensReserved: p.mediaTokensReserved,
            pricingVersion: p.pricingVersion || null,
            serverTime: p.serverTime || p.ts || null,
          });
        }
      } catch {}

      // also do a throttled API refresh to stay authoritative
      refreshTokensThrottled().catch(() => {});
      return;
    }

    if (type === "ERROR") {
      const code = msg?.payload?.code || "WS_ERROR";
      const message = msg?.payload?.message || "WebSocket error";
      setWsError({ code, message });
      toastWs(code, message);
      return;
    }

    if (type === "MEDIA_URL") {
      const chatItemId = String(msg?.payload?.chatItemId || "");
      const url = String(msg?.payload?.url || "");
      if (!chatItemId || !url) return;

      const cur = threadsRef.current || {};
      const t = cur[threadId];
      if (!t) return;

      const items = ensureChatItemsArray(t.chatItems);
      const idx = items.findIndex((x) => String(x?.chatItemId || "") === chatItemId);
      if (idx < 0) return;

      const it = items[idx] || {};
      const media = it.media && typeof it.media === "object" ? it.media : {};

      const nextItems = [...items];
      nextItems[idx] = {
        ...it,
        media: { ...media, playbackUrl: url },
        updatedAt: nowIso(),
      };

      const nextThread = { ...t, chatItems: nextItems, updatedAt: nowIso() };
      const nextThreads = { ...cur, [threadId]: nextThread };
      setThreadsById(nextThreads);
      threadsRef.current = nextThreads;

      return;
    }

    if (type === "THREAD_SNAPSHOT") {
      const thread = msg?.payload?.thread || null;
      const chatItems = msg?.payload?.chatItems || [];
      await applyThreadSnapshot(thread, chatItems);
      return;
    }

    if (type === "THREAD_INVALIDATED") {
      try {
        const bound = wsBoundThreadRef.current;
        if (!bound) return;
        if (String(bound) !== String(threadId)) return;
        if (wsClientRef.current && wsClientRef.current.isConnected()) {
          wsClientRef.current.send("GET_THREAD_SNAPSHOT", { threadId: bound, includeChatItems: true });
        }
      } catch {}
      return;
    }

    if (type === "RUN_CREATED") {
      const runId = String(msg?.payload?.runId || "");
      patchLiveThread(threadId, { lastRunId: runId || null });

      // ✅ token reservations / charges often happen around run start
      refreshTokensThrottled().catch(() => {});
      return;
    }

    if (type === "CHAT_ITEMS_CREATED") {
      const items = Array.isArray(msg?.payload?.items) ? msg.payload.items : [];
      const runId = String(msg?.payload?.runId || "");

      const movedItemIds = items.map((it) => String(it?.itemId || "")).filter(Boolean);

      const cur = threadsRef.current || {};
      const t = cur[threadId];

      const draftMap = {};
      try {
        const cur2 = threadsRef.current || {};
        const tLocal = cur2[threadId];
        const d = tLocal?.draft && typeof tLocal.draft === "object" ? tLocal.draft : null;
        const files = Array.isArray(d?.files) ? d.files : [];
        for (const f of files) {
          const iid = String(f?.itemId || "");
          if (!iid) continue;
          draftMap[iid] = {
            clientFileId: f?.clientFileId || null,
            local: f?.local || null,
          };
        }
      } catch {}

      const patchedItems = items.map((it) => {
        const iid = String(it?.itemId || "");
        const m = it?.media && typeof it.media === "object" ? it.media : {};
        if (m.clientFileId) return it;

        const hit = draftMap[iid];
        if (!hit?.clientFileId) return it;

        return {
          ...it,
          media: {
            ...m,
            clientFileId: String(hit.clientFileId),
          },
        };
      });

      if (t) {
        const d = ensureDraftShape(t.draft);

        const nextDraftFiles = movedItemIds.length
          ? (d.files || []).filter((f) => !movedItemIds.includes(String(f?.itemId || "")))
          : d.files || [];

        const next = {
          ...t,
          draft: { ...d, files: nextDraftFiles },
          chatItems: mergeChatItems(t.chatItems, patchedItems),
        };

        const nextThreads = { ...cur, [threadId]: next };
        setThreadsById(nextThreads);
        threadsRef.current = nextThreads;
      }

      for (const it of items) {
        if (it?.chatItemId) {
          patchLiveChatItem(threadId, it.chatItemId, { status: it.status || {}, stream: {}, progress: {} });
        }
      }

      if (runId) patchLiveThread(threadId, { lastRunId: runId });
      // ✅ often tokens are reserved/charged when items are created
      refreshTokensThrottled().catch(() => {});

      if (scope) {
        try {
          for (const it of patchedItems) {
            const cid = String(it?.chatItemId || "");
            const cfi = it?.media?.clientFileId ? String(it.media.clientFileId) : "";
            if (!cid || !cfi) continue;

            await putMediaIndex(scope, threadId, cid, {
              clientFileId: cfi,
              filename: it?.media?.filename || it?.media?.name || null,
              mime: it?.media?.mime || null,
            });
          }
        } catch {}
      }

      try {
        const bound = wsBoundThreadRef.current;
        if (bound && String(bound) === String(threadId) && wsClientRef.current?.isConnected()) {
          wsClientRef.current.send("GET_THREAD_SNAPSHOT", { threadId: bound, includeChatItems: true });
        }
      } catch {}

      return;
    }

    if (type === "CHAT_ITEM_SEGMENTS") {
      const chatItemId = String(msg?.payload?.chatItemId || "");
      const step = String(msg?.payload?.step || "transcribe");
      const incoming = Array.isArray(msg?.payload?.segments) ? msg.payload.segments : [];
      const append = !!msg?.payload?.append;

      if (!chatItemId) return;

      setLiveRunsByThread((prev) => {
        const cur = (prev && prev[threadId]) || {};
        const chatItems = cur.chatItems && typeof cur.chatItems === "object" ? cur.chatItems : {};
        const existing = chatItems[chatItemId] || {};

        const segObj = existing.segments && typeof existing.segments === "object" ? existing.segments : {};
        const arr = Array.isArray(segObj[step]) ? segObj[step] : [];

        const nextArr = append ? [...arr, ...incoming] : [...incoming];

        return {
          ...(prev || {}),
          [threadId]: {
            ...cur,
            chatItems: {
              ...chatItems,
              [chatItemId]: {
                ...existing,
                segments: { ...segObj, [step]: nextArr },
                updatedAt: nowIso(),
              },
            },
            updatedAt: nowIso(),
          },
        };
      });

      return;
    }

    if (type === "CHAT_ITEM_PROGRESS") {
      const chatItemId = String(msg?.payload?.chatItemId || "");
      const step = String(msg?.payload?.step || "");
      const progress = Number(msg?.payload?.progress || 0);
      if (!chatItemId || !step) return;

      setLiveRunsByThread((prev) => {
        const cur = (prev && prev[threadId]) || {};
        const chatItems = cur.chatItems && typeof cur.chatItems === "object" ? cur.chatItems : {};
        const existing = chatItems[chatItemId] || {};
        const existingProgress = existing.progress && typeof existing.progress === "object" ? existing.progress : {};

        return {
          ...(prev || {}),
          [threadId]: {
            ...cur,
            chatItems: {
              ...chatItems,
              [chatItemId]: {
                ...existing,
                progress: { ...existingProgress, [step]: progress },
                lastProgressAt: nowIso(),
                updatedAt: nowIso(),
              },
            },
            updatedAt: nowIso(),
          },
        };
      });

      return;
    }

    if (type === "CHAT_ITEM_STREAM") {
      const chatItemId = String(msg?.payload?.chatItemId || "");
      const step = String(msg?.payload?.step || "");
      const text = String(msg?.payload?.text || "");
      if (!chatItemId || !step || !text) return;

      setLiveRunsByThread((prev) => {
        const cur = (prev && prev[threadId]) || {};
        const chatItems = cur.chatItems && typeof cur.chatItems === "object" ? cur.chatItems : {};
        const existing = chatItems[chatItemId] || {};
        const stream = existing.stream && typeof existing.stream === "object" ? existing.stream : {};
        const arr = Array.isArray(stream[step]) ? stream[step] : [];

        return {
          ...(prev || {}),
          [threadId]: {
            ...cur,
            chatItems: {
              ...chatItems,
              [chatItemId]: {
                ...existing,
                stream: { ...stream, [step]: [...arr, text] },
                updatedAt: nowIso(),
              },
            },
            updatedAt: nowIso(),
          },
        };
      });

      return;
    }

    if (type === "CHAT_ITEM_UPDATED") {
      const chatItemId = String(msg?.payload?.chatItemId || "");
      if (!chatItemId) return;

      const patch =
        (msg?.payload?.patch && typeof msg.payload.patch === "object" ? msg.payload.patch : null) || {
          status: msg?.payload?.status && typeof msg.payload.status === "object" ? msg.payload.status : null,
          results: msg?.payload?.results && typeof msg.payload.results === "object" ? msg.payload.results : null,
          updatedAt: nowIso(),
        };

     // ✅ when transcribe finishes/fails, refresh tokens (deductions typically finalize here)
      try {
        const st = String(patch?.status?.transcribe?.state || "");
        if (st === "done" || st === "failed") refreshTokensThrottled().catch(() => {});
      } catch {}

      const cur = threadsRef.current || {};
      const t = cur[threadId];
      if (!t) return;

      const items = ensureChatItemsArray(t.chatItems);
      const idx = items.findIndex((x) => String(x?.chatItemId) === chatItemId);
      if (idx < 0) return;

      const nextItems = [...items];
      nextItems[idx] = applyChatItemPatch(nextItems[idx], patch);

      const nextThread = { ...t, chatItems: nextItems };
      const nextThreads = { ...cur, [threadId]: nextThread };
      setThreadsById(nextThreads);
      threadsRef.current = nextThreads;

      return;
    }

    // (Optional) handle completion if you ever emit it server-side
    if (type === "RUN_COMPLETED") {
      refreshTokensThrottled().catch(() => {});
      return;
    }

    if (type === "RUN_FAILED") {
      const message = String(msg?.payload?.message || "Run failed");
      toast.error(message);

     // ✅ refresh in case reserved tokens were released or a charge was reverted
      refreshTokensThrottled().catch(() => {});

      try {
        const bound = wsBoundThreadRef.current;
        if (bound && String(bound) === String(threadId) && wsClientRef.current?.isConnected()) {
          wsClientRef.current.send("GET_THREAD_SNAPSHOT", { threadId: bound, includeChatItems: true });
        }
      } catch {}

      return;
    }
  };

  const connectWsForThread = async (threadId) => {
    const tid = String(threadId || "");
    if (!tid || tid === "default") return;

    if (wsBoundThreadRef.current && String(wsBoundThreadRef.current) !== tid) {
      disconnectWs();
    }

    if (wsClientRef.current && wsBoundThreadRef.current === tid) {
      try {
        if (!wsClientRef.current.isConnected()) {
          setWsStatus("connecting");
          await wsClientRef.current.connect();
        }
      } catch {}
      return;
    }

    setWsError(null);
    setWsThreadId(tid);

    const localThread = (threadsRef.current || {})[tid] || null;
    const clientState = {
      draftRev: localThread?.draftRev ?? null,
      draftUpdatedAt: localThread?.draftUpdatedAt ?? null,
      updatedAt: localThread?.updatedAt ?? null,
    };

    const client = createThreadWsClient({
      threadId: tid,
      getJwt,
      clientState,
      onStatus: (s) => {
        const st = String(s?.status || "");
        setWsStatus(st || "disconnected");
        // ws client emits "socket_open" and "ready"
        if (st === "ready" || st === "socket_open" || st === "connecting") setWsError(null);
       },
      onEvent: (msg) => {
        handleWsEvent(msg).catch(() => {});
      },
      onError: (e) => {
        const message = e?.message || "WebSocket error";
        setWsError({ code: "WS_ERROR", message });
        toastWs("WS_ERROR", message);
      },
      reconnect: true,
    });

    wsClientRef.current = client;
    wsBoundThreadRef.current = tid;

    try {
      setWsStatus("connecting");
      await client.connect();
    } catch (e) {
      setWsStatus("error");
      const message = e?.message || "Failed to connect";
      setWsError({ code: "WS_CONNECT_FAILED", message });
      toastWs("WS_CONNECT_FAILED", message);
    }
  };

  const requestMediaUrl = ({ threadId, chatItemId } = {}) => {
    const tid = String(threadId || wsBoundThreadRef.current || "");
    const cid = String(chatItemId || "");
    if (!tid || !cid) return false;
    if (!wsClientRef.current || !wsClientRef.current.isConnected()) return false;

    return wsClientRef.current.send("GET_MEDIA_URL", { threadId: tid, chatItemId: cid });
  };

  const requestThreadSnapshot = () => {
    const tid = wsBoundThreadRef.current;
    if (!tid || !wsClientRef.current || !wsClientRef.current.isConnected()) return false;
    return wsClientRef.current.send("GET_THREAD_SNAPSHOT", { threadId: tid, includeChatItems: true });
  };

  const clearTranscribeFieldsOnThread = (threadId, chatItemId) => {
    const tid = String(threadId || "");
    const cid = String(chatItemId || "");
    if (!tid || !cid) return;

    const cur = threadsRef.current || {};
    const t = cur[tid];
    if (!t) return;

    const items = ensureChatItemsArray(t.chatItems);
    const idx = items.findIndex((x) => String(x?.chatItemId || "") === cid);
    if (idx < 0) return;

    const it = items[idx] || {};
    const status = it.status || {};
    const results = it.results || {};

    const nextItems = [...items];
    nextItems[idx] = {
      ...it,
      status: {
        ...status,
        transcribe: {
          ...(status.transcribe || {}),
          state: "queued",
          stage: "queued",
          queuedAt: nowIso(),
          updatedAt: nowIso(),
          error: null,
        },
      },
      results: {
        ...results,
        transcript: "",
        transcriptText: "",
        transcriptSrt: "",
        transcriptSegments: [],
        transcriptMeta: { ...(results.transcriptMeta || {}), clearedAt: nowIso() },
      },
      updatedAt: nowIso(),
    };

    const nextThread = { ...t, chatItems: nextItems, updatedAt: nowIso() };
    const nextThreads = { ...cur, [tid]: nextThread };

    setThreadsById(nextThreads);
    threadsRef.current = nextThreads;

    if (String(activeRef.current) === tid) {
      persist(nextThreads, activeRef.current, syncRef.current).catch(() => {});
    }
  };

  const retryTranscribe = async ({ chatItemIds, chatItemId, options } = {}) => {
    const tid = wsBoundThreadRef.current || activeRef.current;
    if (!tid || tid === "default") {
      toast.error("No thread selected.");
      return false;
    }

    if (!wsClientRef.current || !wsClientRef.current.isConnected()) {
      toast.error("Not connected to the realtime server yet.");
      return false;
    }

    const ids =
      Array.isArray(chatItemIds) && chatItemIds.length
        ? chatItemIds.map((x) => String(x || "")).filter(Boolean)
        : chatItemId
        ? [String(chatItemId)]
        : [];

    if (!ids.length) {
      toast.error("No chatItemId(s) provided.");
      return false;
    }

    const payload = {
      threadId: String(tid),
      chatItemIds: ids,
      options: options && typeof options === "object" ? options : {},
    };

    const wantClear = !!(payload.options && payload.options.clear);

    if (wantClear) {
      for (const cid of ids) {
        patchLiveChatItem(tid, cid, {
          stream: { transcribe: [] },
          progress: { transcribe: 0 },
          segments: { transcribe: [] },
          updatedAt: nowIso(),
        });

        clearTranscribeFieldsOnThread(tid, cid);
      }
    }

    const ok = wsClientRef.current.send("RETRY_TRANSCRIBE", payload);
    if (!ok) toast.error("Failed to send RETRY_TRANSCRIBE");
    return ok;
  };

  const startRun = async ({ itemIds, itemId, options } = {}) => {
    const tid = wsBoundThreadRef.current || activeRef.current;
    if (!tid || tid === "default") {
      toast.error("No thread selected.");
      return false;
    }

    if (!wsClientRef.current || !wsClientRef.current.isConnected()) {
      toast.error("Not connected to the realtime server yet.");
      return false;
    }

    const ids =
      Array.isArray(itemIds) && itemIds.length
        ? itemIds.map((x) => String(x || "")).filter(Boolean)
        : itemId
        ? [String(itemId)]
        : [];

    if (!ids.length) {
      toast.error("No itemIds provided.");
      return false;
    }

    const payload = {
      threadId: String(tid),
      itemIds: ids,
      options: options && typeof options === "object" ? options : {},
    };

    const ok = wsClientRef.current.send("START_RUN", payload);
    if (!ok) toast.error("Failed to send START_RUN");
    return ok;
  };

  // --------- SYNC LOGIC ----------
  const syncFromServer = async ({ reason } = {}) => {
    if (isAnonymous) return;
    const jwt = await getJwtIfAny();
    if (!jwt) return;

    const since = syncRef.current?.indexAt || null;
    const index = await apiThreadsIndex(jwt, { since });

    const serverTime = index?.serverTime || nowIso();
    const rows = Array.isArray(index?.threads) ? index.threads : [];

    if (!rows.length) {
      syncRef.current = { ...(syncRef.current || {}), indexAt: serverTime };
      await persist(threadsRef.current, activeRef.current, syncRef.current);
      return;
    }

    let nextThreads = { ...(threadsRef.current || {}) };

    const needFetch = [];
    for (const r of rows) {
      const id = String(r.threadId || r.id || "");
      if (!id) continue;
      if (id === "default") continue;

      if (r.deletedAt) {
        delete nextThreads[id];
        continue;
      }

      const local = nextThreads[id];
      const localServer = ensureServerShape(local?.server);

      const same =
        local &&
        localServer.updatedAt === (r.updatedAt || null) &&
        localServer.draftUpdatedAt === (r.draftUpdatedAt || null) &&
        Number(localServer.version) === Number(r.version ?? null) &&
        Number(localServer.draftRev) === Number(r.draftRev ?? null);

      if (!same) needFetch.push(id);
    }

    if (needFetch.length !== rows.length) {
      await commit(nextThreads, activeRef.current, { ...(syncRef.current || {}), indexAt: serverTime });
    }

    for (const threadId of needFetch) {
      const full = await apiGetThread(jwt, { threadId });
      const t = full?.thread;
      if (!t || !t.id) continue;

      const existing = nextThreads[t.id];
      const mergedDraft = mergeDraft(t.draft, existing?.draft);

      nextThreads = {
        ...nextThreads,
        [t.id]: {
          ...existing,
          ...t,
          draft: mergedDraft,
          server: ensureServerShape(
            t.server || {
              updatedAt: t.updatedAt || null,
              draftUpdatedAt: t.draftUpdatedAt || null,
              version: t.version ?? null,
              draftRev: t.draftRev ?? null,
            }
          ),
        },
      };
    }

    const nextSync = { ...(syncRef.current || {}), indexAt: serverTime };
    await commit(nextThreads, activeRef.current, nextSync);
  };

  // --------- BOOT ---------
  useEffect(() => {
    if (!scope) return;
    if (bootedRef.current && bootedRef.current === scope) return;
    bootedRef.current = scope;

    (async () => {
      setLoadingThreads(true);
      setSyncError(null);

      try {
        const ensured = await ensureDefaultThread(scope);
        const loaded = await loadThreadsState(scope);

        const merged = { ...loaded.threadsById };
        if (!merged.default) merged.default = ensured.threadsById.default;

        setThreadsById(merged);
        setActiveIdState(loaded.activeId || "default");
        threadsRef.current = merged;
        activeRef.current = loaded.activeId || "default";

        syncRef.current = loaded.sync || { indexAt: null };

        await syncFromServer({ reason: "boot" });
      } catch (e) {
        setSyncError(e?.message || "Failed to sync threads");
      } finally {
        setLoadingThreads(false);
      }
    })();
  }, [scope]);

  useEffect(() => {
    const tid = String(activeId || "");
    if (!tid || tid === "default") {
      disconnectWs();
      return;
    }

    connectWsForThread(tid).catch(() => {});
    return () => {};
  }, [activeId]);

  const threads = useMemo(() => toArray(threadsById), [threadsById]);

  const activeThread = useMemo(() => {
    return threadsById[activeId] || threadsById.default || null;
  }, [threadsById, activeId]);

  const setActiveId = async (id) => {
    setActiveIdState(id);
    activeRef.current = id;
    await persist(threadsRef.current, id, syncRef.current);
  };

  // --------- CRUD ----------
  const createThread = async () => {
    const localThread = makeNewThread(`Thread ${new Date().toLocaleString()}`);

    return toast.promise(
      (async () => {
        if (!isAnonymous) {
          const jwt = await getJwtIfAny();
          if (!jwt) throw new Error("Unable to create JWT");

          const r = await apiCreateThread(jwt, { threadId: localThread.id, title: localThread.title });
          const serverThread = r?.thread;

          if (serverThread?.id) {
            localThread.createdAt = serverThread.createdAt || localThread.createdAt;
            localThread.updatedAt = serverThread.updatedAt || localThread.updatedAt;
            localThread.version = serverThread.version || localThread.version;
            localThread.server = ensureServerShape({
              updatedAt: serverThread.updatedAt || null,
              draftUpdatedAt: serverThread.draftUpdatedAt || null,
              version: serverThread.version ?? null,
              draftRev: serverThread.draftRev ?? null,
            });
          }
        }

        const cur = threadsRef.current || {};
        const next = { ...cur, [localThread.id]: localThread };
        await commit(next, localThread.id, syncRef.current);
        return localThread.id;
      })(),
      {
        loading: "Creating thread…",
        success: "Thread created",
        error: (e) => e?.message || "Failed to create thread",
      }
    );
  };

  const renameThread = async (threadId, title) => {
    if (!threadId || threadId === "default") return;
    const cleanTitle = String(title || "").trim();
    if (!cleanTitle) return;

    const cur = threadsRef.current || {};
    const t = cur[threadId];
    if (!t) return;

    return toast.promise(
      (async () => {
        if (!isAnonymous) {
          const jwt = await getJwtIfAny();
          if (!jwt) throw new Error("Unable to create JWT");
          await apiRenameThread(jwt, { threadId, title: cleanTitle });
        }

        const updated = { ...t, title: cleanTitle, updatedAt: nowIso() };
        const next = { ...cur, [threadId]: updated };
        await commit(next, activeRef.current, syncRef.current);
      })(),
      {
        loading: "Renaming…",
        success: "Renamed",
        error: (e) => e?.message || "Failed to rename",
      }
    );
  };

  const deleteThread = async (threadId) => {
    if (!threadId || threadId === "default") return;

    const cur = threadsRef.current || {};
    const t = cur[threadId];
    if (!t) return;

    return toast.promise(
      (async () => {
        if (!isAnonymous) {
          const jwt = await getJwtIfAny();
          if (!jwt) throw new Error("Unable to create JWT");
          await apiDeleteThread(jwt, { threadId });
        }

        const next = { ...cur };
        delete next[threadId];

        let nextActive = activeRef.current;
        if (nextActive === threadId) nextActive = "default";

        await commit(next, nextActive, syncRef.current);
      })(),
      {
        loading: "Deleting…",
        success: "Deleted",
        error: (e) => e?.message || "Failed to delete",
      }
    );
  };

  // ---------------- Draft Media (UPLOAD -> CONVERT -> UPLOAD MP3) ----------------
  const addDraftMediaFromFile = async (threadId, file) => {
    if (!threadId || threadId === "default") return;
    if (!file) return;

    if (!isAudioOrVideoFile(file)) {
      toast.error("Only audio/video files are allowed.");
      return;
    }

    const cur = threadsRef.current || {};
    const t = cur[threadId];
    if (!t) return;

    const itemId = uuid();
    const clientFileId = uuid();

    const originalMime = String(file?.type || "");
    const originalIsVideo = originalMime.startsWith("video/");

    const localMeta = {
      name: file?.name || "",
      size: file?.size || 0,
      mime: originalMime,
      lastModified: file?.lastModified || 0,
      isVideo: originalIsVideo,
      // durationSeconds will be filled later once mp3File exists (FIX)
    };

    if (scope) {
      await putLocalMedia(scope, threadId, clientFileId, file);

      await putLocalMediaMeta(scope, threadId, clientFileId, {
        origin: "upload",
        name: file?.name || "",
        mime: String(file?.type || ""),
        isVideo: String(file?.type || "").startsWith("video/"),
        bytes: Number(file?.size || 0) || 0,
        savedAt: nowIso(),
      });

    }

    const draft = ensureDraftShape(t.draft);
    const optimistic = {
      itemId,
      clientFileId,
      sourceType: "upload",
      local: localMeta,
      stage: isMp3(file) ? "uploading" : "converting",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    const nextDraft = ensureDraftShape({ ...draft, files: [optimistic, ...(draft.files || [])] });
    const nextThread = {
      ...t,
      draft: nextDraft,
      draftRev: (t.draftRev || 0) + 1,
      draftUpdatedAt: nowIso(),
      updatedAt: nowIso(),
    };

    await commit({ ...cur, [threadId]: nextThread }, activeRef.current, syncRef.current);

    return toast.promise(
      (async () => {
        const jwt = await getJwtIfAny();

        let mp3File = file;

        if (!isMp3(file)) {
          mp3File = await convertToMp3OrPassThrough(file, { ensureFfmpeg, extractAudioToMp3 });

          const curMid = threadsRef.current || {};
          const tMid = curMid[threadId];
          if (tMid) {
            const dMid = ensureDraftShape(tMid.draft);
            const filesMid = [...(dMid.files || [])];
            const idx = filesMid.findIndex((x) => String(x?.itemId) === String(itemId));
            if (idx >= 0) {
              filesMid[idx] = { ...filesMid[idx], stage: "uploading", updatedAt: nowIso() };
              const nextTMid = {
                ...tMid,
                draft: { ...dMid, files: filesMid },
                draftRev: (tMid.draftRev || 0) + 1,
                draftUpdatedAt: nowIso(),
                updatedAt: nowIso(),
              };
              await commit({ ...curMid, [threadId]: nextTMid }, activeRef.current, syncRef.current);
            }
          }
        }

        // ✅ FIX: probe duration only AFTER mp3File exists
        try {
          const dur = await probeDurationSecondsFromFile(mp3File);
          if (dur != null) localMeta.durationSeconds = dur;
        } catch {}

        const fd = new FormData();
        fd.append("threadId", threadId);
        fd.append("itemId", itemId);
        fd.append("clientFileId", clientFileId);
        fd.append("sourceType", "upload");
        fd.append("localMeta", JSON.stringify(localMeta));
        fd.append("file", mp3File, mp3File?.name || `${baseName(file?.name)}.mp3`);

        const r = await postForm("/api/threads/draft/upload", jwt, fd);

        const cur2 = threadsRef.current || {};
        const t2 = cur2[threadId];
        if (!t2) return itemId;

        const d2 = ensureDraftShape(t2.draft);
        const files2 = [...(d2.files || [])];
        const idx2 = files2.findIndex((x) => String(x?.itemId) === String(itemId));
        if (idx2 >= 0) {
          const prev = files2[idx2] || {};
          const srv = (r && r.draftFile) ? r.draftFile : {};

          // IMPORTANT: never overwrite these (they point to original local file)
          const keepClientFileId = prev.clientFileId;
          const keepLocal = prev.local;

          files2[idx2] = {
            ...prev,
            ...srv,

            // preserve original upload identity/meta
            clientFileId: keepClientFileId,
            local: keepLocal,

            // if server has extra audio/mp3 fields, merge them separately (optional)
            audio: { ...(prev.audio || {}), ...(srv.audio || {}) },

            stage: (srv && srv.stage) ? srv.stage : "uploaded",
            updatedAt: nowIso(),
          };

        }

        const nextT2 = {
          ...t2,
          draft: { ...d2, files: files2 },
          draftRev: typeof r.draftRev === "number" ? r.draftRev : (t2.draftRev || 0) + 1,
          draftUpdatedAt: r.draftUpdatedAt || nowIso(),
          updatedAt: nowIso(),
        };

        await commit({ ...cur2, [threadId]: nextT2 }, activeRef.current, syncRef.current);
        return itemId;
      })(),
      {
        loading: isMp3(file) ? "Uploading mp3…" : "Converting to mp3…",
        success: "Uploaded",
        error: async (e) => {
          try {
            if (scope) await deleteLocalMedia(scope, threadId, clientFileId);
          } catch {}

          try {
            const cur2 = threadsRef.current || {};
            const t2 = cur2[threadId];
            if (t2) {
              const d2 = ensureDraftShape(t2.draft);
              const files2 = (d2.files || []).filter((x) => String(x?.itemId) !== String(itemId));
              const nextT2 = {
                ...t2,
                draft: { ...d2, files: files2 },
                draftRev: (t2.draftRev || 0) + 1,
                draftUpdatedAt: nowIso(),
                updatedAt: nowIso(),
              };
              await commit({ ...cur2, [threadId]: nextT2 }, activeRef.current, syncRef.current);
            }
          } catch {}

          return e?.message || "Upload failed";
        },
      }
    );
  };

  const addDraftMediaFromUrl = async (threadId, url) => {
    if (!threadId || threadId === "default") return;

    const clean = String(url || "").trim();
    if (!clean) return;

    const cur = threadsRef.current || {};
    const t = cur[threadId];
    if (!t) return;

    const itemId = uuid();
    const clientFileId = uuid();

    const draft = ensureDraftShape(t.draft);

    // ✅ FIX: don't reference "dur" before it's declared; keep optimistic urlMeta empty
    const optimistic = {
      itemId,
      clientFileId,
      sourceType: "url",
      url: clean,
      urlMeta: {},
      stage: "linking",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    const nextDraft = ensureDraftShape({ ...draft, files: [optimistic, ...(draft.files || [])] });
    const nextThread = {
      ...t,
      draft: nextDraft,
      draftRev: (t.draftRev || 0) + 1,
      draftUpdatedAt: nowIso(),
      updatedAt: nowIso(),
    };

    await commit({ ...cur, [threadId]: nextThread }, activeRef.current, syncRef.current);

    return toast.promise(
      (async () => {
        const jwt = await getJwtIfAny();

        // ✅ FIX: probe inside the promise, then build urlMeta safely
        let dur = null;
        try {
          dur = await probeDurationSecondsFromUrl(clean);
        } catch {}

        const urlMeta = dur != null ? { durationSeconds: dur } : {};

        const fd = new FormData();
        fd.append("threadId", threadId);
        fd.append("itemId", itemId);
        fd.append("clientFileId", clientFileId);
        fd.append("sourceType", "url");
        fd.append("url", clean);
        fd.append("title", t.title || "New Thread");
        fd.append("urlMeta", JSON.stringify(urlMeta));

        const r = await postForm("/api/threads/draft/upload", jwt, fd);

        const cur2 = threadsRef.current || {};
        const t2 = cur2[threadId];
        if (!t2) return itemId;

        const d2 = ensureDraftShape(t2.draft);
        const files2 = [...(d2.files || [])];
        const idx = files2.findIndex((x) => String(x?.itemId) === String(itemId));
        if (idx >= 0) {
          files2[idx] = {
            ...files2[idx],
            ...(r.draftFile || {}),
            stage: r?.draftFile?.stage || "linked",
            updatedAt: nowIso(),
          };
        }

        const nextT2 = {
          ...t2,
          draft: { ...d2, files: files2 },
          draftRev: typeof r.draftRev === "number" ? r.draftRev : (t2.draftRev || 0) + 1,
          draftUpdatedAt: r.draftUpdatedAt || nowIso(),
          updatedAt: nowIso(),
        };

        await commit({ ...cur2, [threadId]: nextT2 }, activeRef.current, syncRef.current);
        return itemId;
      })(),
      {
        loading: "Saving link…",
        success: "Linked",
        error: async (e) => {
          try {
            const cur2 = threadsRef.current || {};
            const t2 = cur2[threadId];
            if (t2) {
              const d2 = ensureDraftShape(t2.draft);
              const files2 = (d2.files || []).filter((x) => String(x?.itemId) !== String(itemId));
              const nextT2 = {
                ...t2,
                draft: { ...d2, files: files2 },
                draftRev: (t2.draftRev || 0) + 1,
                draftUpdatedAt: nowIso(),
                updatedAt: nowIso(),
              };
              await commit({ ...cur2, [threadId]: nextT2 }, activeRef.current, syncRef.current);
            }
          } catch {}
          return e?.message || "Failed to add link";
        },
      }
    );
  };

  const deleteDraftMedia = async (threadId, itemId) => {
    if (!threadId || threadId === "default" || !itemId) return;

    const cur = threadsRef.current || {};
    const t = cur[threadId];
    if (!t) return;

    const d = ensureDraftShape(t.draft);
    const entry = (d.files || []).find((x) => String(x?.itemId) === String(itemId));
    const clientFileId = entry?.clientFileId;

    return toast.promise(
      (async () => {
        if (scope && clientFileId) {
          try {
            await deleteLocalMedia(scope, threadId, clientFileId);
          } catch {}
        }

        const jwt = await getJwtIfAny();
        await postJson("/api/threads/draft/delete", jwt, { threadId, itemId });

        const cur2 = threadsRef.current || {};
        const t2 = cur2[threadId];
        if (!t2) return;

        const d2 = ensureDraftShape(t2.draft);
        const files2 = (d2.files || []).filter((x) => String(x?.itemId) !== String(itemId));

        const nextT2 = {
          ...t2,
          draft: { ...d2, files: files2 },
          draftRev: (t2.draftRev || 0) + 1,
          draftUpdatedAt: nowIso(),
          updatedAt: nowIso(),
        };

        await commit({ ...cur2, [threadId]: nextT2 }, activeRef.current, syncRef.current);
      })(),
      {
        loading: "Deleting…",
        success: "Deleted",
        error: (e) => e?.message || "Delete failed",
      }
    );
  };

  const saveSrt = async ({ chatItemId, transcriptSrt, transcriptText }) => {
    const tid = wsBoundThreadRef.current || activeRef.current;
    if (!tid || tid === "default") {
      toast.error("No thread selected.");
      return false;
    }
    if (!wsClientRef.current || !wsClientRef.current.isConnected()) {
      toast.error("Not connected to the realtime server yet.");
      return false;
    }
    const payload = {
      threadId: String(tid),
      chatItemId: String(chatItemId),
      transcriptSrt: String(transcriptSrt || ""),
      transcriptText: String(transcriptText || ""),
    };
    const ok = wsClientRef.current.send("SAVE_SRT", payload);
    if (!ok) toast.error("Failed to send SAVE_SRT");
    return ok;
  };

  const value = {
    loadingThreads,
    syncError,
    threads,
    activeId,
    setActiveId,
    activeThread,

    syncFromServer,

    createThread,
    renameThread,
    deleteThread,

    addDraftMediaFromFile,
    addDraftMediaFromUrl,
    deleteDraftMedia,

    wsStatus,
    wsError,
    wsThreadId,
    liveRunsByThread,
    startRun,
    retryTranscribe,
    requestThreadSnapshot,
    requestMediaUrl,

    saveSrt,
  };

  return <ThreadsContext.Provider value={value}>{children}</ThreadsContext.Provider>;
}

export function useThreads() {
  const ctx = useContext(ThreadsContext);
  if (!ctx) throw new Error("useThreads must be used inside <ThreadsProvider />");
  return ctx;
}
