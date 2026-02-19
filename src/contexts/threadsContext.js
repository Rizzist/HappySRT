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
import { safeLangKey, deleteLangKey } from "../lib/langKey";
import { makeScope } from "../lib/scopeKey";
import { uploadDraftFileViaWs, uploadDraftUrlViaWs } from "../lib/wsDraftUploadClient";


import * as BillingImport from "../shared/billingCatalog";
import * as TranslationImport from "../shared/translationCatalog";
import * as TranslationBillingImport from "../shared/translationBillingCatalog";
import * as SummarizationBillingImport from "../shared/summarizationBillingCatalog";

import { requestUpgrade } from "../lib/upgradeBus";

import PlansImport from "../shared/plans";
const Plans = (PlansImport && (PlansImport.default || PlansImport)) || {};
const { formatBytes } = Plans;

const TranslationCatalog = (TranslationImport && (TranslationImport.default || TranslationImport)) || {};
const TR_DEFAULTS = TranslationCatalog?.DEFAULTS || {};

const Billing = (BillingImport && (BillingImport.default || BillingImport)) || {};
const TranslationBilling =
  (TranslationBillingImport && (TranslationBillingImport.default || TranslationBillingImport)) || {};
const SummarizationBilling =
  (SummarizationBillingImport && (SummarizationBillingImport.default || SummarizationBillingImport)) || {};

const ThreadsContext = createContext(null);


const UPGRADE_CODES = new Set([
  "MAX_FILE_SIZE_EXCEEDED",
  "STORAGE_LIMIT_EXCEEDED",
  "MONTHLY_UPLOAD_LIMIT_EXCEEDED",
]);

function isUpgradeLimitError(e) {
  const c = String(e?.code || "");
  return UPGRADE_CODES.has(c);
}

function fmtBytes(n) {
  const x = Number(n || 0) || 0;
  return typeof formatBytes === "function" ? formatBytes(x) : `${x} bytes`;
}

function formatUpgradeMessage(e) {
  const code = String(e?.code || "");
  const p = e?.payload || {};

  if (code === "MAX_FILE_SIZE_EXCEEDED") {
    return `File too large (${fmtBytes(p.fileBytes)}). Your plan allows up to ${fmtBytes(p.maxFileBytes)}. Upgrade to upload bigger files.`;
  }

  if (code === "STORAGE_LIMIT_EXCEEDED") {
    const s = p.storage || {};
    return `Storage limit reached (${fmtBytes(s.usedBytes)} / ${fmtBytes(s.limitBytes)}). Upgrade to upload more.`;
  }

  if (code === "MONTHLY_UPLOAD_LIMIT_EXCEEDED") {
    const m = p.monthly || {};
    const month = p.month || m.month || "";
    return `Monthly upload limit reached${month ? ` (${month})` : ""}: ${fmtBytes(m.usedBytes)} / ${fmtBytes(m.limitBytes)}. Upgrade to keep uploading.`;
  }

  return e?.message || "Upgrade required.";
}

function openUpgradeFromError(e) {
  requestUpgrade({
    code: e?.code || null,
    payload: e?.payload || null,
    at: Date.now(),
  });
}


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

function summarizePrefix(threadId, chatItemId) {
  return `${String(threadId)}:chat:${String(chatItemId)}:sum:`;
}

function summarizeKey(threadId, chatItemId, modelId, targetLang) {
   const mid = String(modelId || "").trim();
  const lang = safeLangKey(targetLang) || String(targetLang || "auto").toLowerCase().trim() || "auto";
   return `${summarizePrefix(threadId, chatItemId)}${mid || "model"}:${lang}`;
 }

function getTranscriptTextAny(chatItem) {
  const r = chatItem?.results && typeof chatItem.results === "object" ? chatItem.results : {};
  const t = String(r?.transcript || "").trim();
  if (t) return t;

  const segs = getTranscriptSegmentsAny(chatItem);
  if (!segs.length) return "";
  return segs.map((s) => String(s?.text || "").trim()).filter(Boolean).join(" ").trim();
}

function estimateSummaryMediaTokensDeterministic({ text, modelId, targetLang } = {}) {
  const s = String(text || "").trim();
  if (!s) return 0;
  if (typeof SummarizationBilling?.estimateSummarizationRun !== "function") return 0;

  try {
    const opts = {};
    if (modelId) opts.modelId = String(modelId);
    if (targetLang) {
      // estimator currently expects "language" (client-side), server expects "targetLang"
      opts.language = String(targetLang);
      opts.targetLang = String(targetLang);
    }
    const run = SummarizationBilling.estimateSummarizationRun({ text: s }, opts);
    return Math.max(0, Math.round(Number(run?.mediaTokens || 0) || 0));
  } catch {
    try {
      const run = SummarizationBilling.estimateSummarizationRun({ text: s }, null);
      return Math.max(0, Math.round(Number(run?.mediaTokens || 0) || 0));
    } catch {
      return 0;
    }
  }
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

function mergeObj(a, b) {
  const A = a && typeof a === "object" && !Array.isArray(a) ? a : null;
  const B = b && typeof b === "object" && !Array.isArray(b) ? b : null;
  if (A && B) return { ...A, ...B };
  return b != null ? b : a;
}

function mergeLangMap(prevMap, patchMap) {
  const A = prevMap && typeof prevMap === "object" && !Array.isArray(prevMap) ? prevMap : {};
  const B = patchMap && typeof patchMap === "object" && !Array.isArray(patchMap) ? patchMap : null;
  if (!B) return prevMap || null;
  return { ...A, ...B };
}

function applyChatItemPatch(item, patch) {
  const p = patch && typeof patch === "object" ? patch : {};

  const prevStatus = item?.status && typeof item.status === "object" ? item.status : {};
  const prevResults = item?.results && typeof item.results === "object" ? item.results : {};

  // base shallow merge
  let nextStatus = p.status ? { ...prevStatus, ...(p.status || {}) } : prevStatus;
  let nextResults = p.results ? { ...prevResults, ...(p.results || {}) } : prevResults;

  // deep merge known step objects to avoid clobbering fields
  if (p.status && typeof p.status === "object") {
    for (const k of ["transcribe", "translate", "summarize"]) {
      if (p.status[k] && typeof p.status[k] === "object") {
        nextStatus[k] = mergeObj(prevStatus[k], p.status[k]);
      }
    }

    // translate.byLang (per target)
    if (p.status.translate && typeof p.status.translate === "object") {
      const prevByLang = prevStatus?.translate?.byLang;
      const patchByLang = p.status?.translate?.byLang;
      const mergedByLang = mergeLangMap(prevByLang, patchByLang);
      if (mergedByLang) {
        nextStatus.translate = nextStatus.translate || {};
        nextStatus.translate.byLang = mergedByLang;
      }
    }
  }

  // deep merge translations map (results.translations[lang])
  if (p.results && typeof p.results === "object") {
    const prevTranslations = prevResults?.translations;
    const patchTranslations = p.results?.translations;
    const mergedTranslations = mergeLangMap(prevTranslations, patchTranslations);
    if (mergedTranslations) nextResults.translations = mergedTranslations;
  }

  return {
    ...(item || {}),
    ...(p || {}),
    status: nextStatus || {},
    results: nextResults || {},
    updatedAt: p.updatedAt || item?.updatedAt || nowIso(),
  };
}


function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

// prevents the “flash to 0” by ONLY passing fields that actually exist
function pickTokenPatch(raw) {
  const p = raw && typeof raw === "object" ? raw : null;
  if (!p) return null;

  const out = {};
  if (hasOwn(p, "mediaTokens")) out.mediaTokens = p.mediaTokens;
  if (hasOwn(p, "mediaTokensBalance")) out.mediaTokensBalance = p.mediaTokensBalance;
  if (hasOwn(p, "mediaTokensReserved")) out.mediaTokensReserved = p.mediaTokensReserved;
  if (hasOwn(p, "pricingVersion")) out.pricingVersion = p.pricingVersion || null;
  if (hasOwn(p, "serverTime")) out.serverTime = p.serverTime || p.ts || null;

  return Object.keys(out).length ? out : null;
}

// extract both byChatItemId and byItemId
function extractBillingMaps(billing) {
  const b = billing && typeof billing === "object" ? billing : null;
  if (!b) return { byChatItemId: null, byItemId: null };

  const byChatItemId = {};
  const byItemId = {};

  const arr =
    (Array.isArray(b.items) && b.items) ||
    (Array.isArray(b.charges) && b.charges) ||
    (Array.isArray(b.chatItems) && b.chatItems) ||
    null;

  if (arr) {
    for (const row of arr) {
      const tok = row?.tokens ?? row?.mediaTokens ?? row?.costTokens ?? row?.chargeTokens;
      const n = Number(tok);
      if (!Number.isFinite(n) || n <= 0) continue;

      const cid = row?.chatItemId || row?.chat_item_id || row?.cid;
      const iid = row?.itemId || row?.item_id;

      if (cid) byChatItemId[String(cid)] = n;
      if (iid) byItemId[String(iid)] = n;
    }
  }

  return {
    byChatItemId: Object.keys(byChatItemId).length ? byChatItemId : null,
    byItemId: Object.keys(byItemId).length ? byItemId : null,
  };
}

function applyBillingMapToThreadItems(threadId, map, setThreadsById, threadsRef) {
  const tid = String(threadId || "");
  if (!tid || !map) return;

  setThreadsById((prev) => {
    const cur = prev || {};
    const t = cur[tid];
    if (!t) return prev;

    const items = Array.isArray(t.chatItems) ? t.chatItems : [];
    if (!items.length) return prev;

    let changed = false;

    const nextItems = items.map((it) => {
      const cid = String(it?.chatItemId || "");
      const tok = map[cid];
      const n = Number(tok);

      if (!cid || !Number.isFinite(n) || n <= 0) return it;

      changed = true;
      const billing = it?.billing && typeof it.billing === "object" ? it.billing : {};

      return {
        ...it,
        billing: { ...billing, transcribeTokens: n, mediaTokens: n },
        transcribeTokens: n,
        mediaTokens: n,
        updatedAt: nowIso(),
      };
    });

    if (!changed) return prev;

    const nextThread = { ...t, chatItems: nextItems, updatedAt: nowIso() };
    const next = { ...cur, [tid]: nextThread };
    threadsRef.current = next;
    return next;
  });
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
    err.payload = data; // ✅ ADD THIS
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
    err.payload = data; // ✅ ADD THIS
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

// ---------- deterministic optimistic estimation ----------
function estimateTokensForSecondsDeterministic(seconds, modelId) {
  const s = Number(seconds || 0);
  if (!Number.isFinite(s) || s <= 0) return 0;

  if (typeof Billing?.estimateTokensForSeconds === "function") {
    try {
      const opts = {
        quantumSeconds: Billing?.BILLING_QUANTUM_SECONDS,
        minBillableSeconds: Billing?.MIN_BILLABLE_SECONDS,
        tokensOverheadPerItem: Billing?.TOKENS_OVERHEAD_PER_ITEM,
        tokensOverheadPerRun: Billing?.TOKENS_OVERHEAD_PER_RUN,
      };
      const n = Billing.estimateTokensForSeconds(s, String(modelId || ""), opts);
      return Math.max(0, Math.round(Number(n || 0) || 0));
    } catch {
      return 0;
    }
  }

  return Math.max(0, Math.ceil(s));
}

function uniqStrings(arr) {
  const out = [];
  const seen = new Set();
  for (const x of Array.isArray(arr) ? arr : []) {
    const s = String(x || "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function normalizeRunOptions(raw) {
  const o = raw && typeof raw === "object" ? { ...raw } : {};

  // strip any legacy translation fields (no backwards compatibility)
  delete o.trProvider;
  delete o.trModel;
  delete o.trSourceLang;
  delete o.trLang;
  delete o.trTargetLangs;
  delete o.trLangs;

    // ✅ normalize summarize (array-free, simple)
  if (o.summarize && typeof o.summarize === "object") {
    const s = o.summarize || {};

    const modelId = String(s.modelId || TR_DEFAULTS?.modelId || "gpt-4o-mini");
    const targetLangRaw =
      s.targetLang ||
      s.language || // legacy
      s.lang || // legacy
      o.summarizeTargetLang || // legacy
      o.sumLang || // legacy
      "auto";
    const targetLang = safeLangKey(targetLangRaw) || String(targetLangRaw || "auto").toLowerCase().trim() || "auto";
 
     o.summarize = {
       enabled: !!s.enabled,
       modelId,
      targetLang,
     };

    return o;
  }

  // ✅ if caller set doSummarize but forgot summarize block, enforce defaults
  if (o.doSummarize) {
    const modelId = String(TR_DEFAULTS?.modelId || "gpt-4o-mini");
    o.summarize = {
      enabled: true,
      modelId,
      targetLang: "auto",
    };
  }

  // If translation block exists, normalize it (array-only)
  if (o.translation && typeof o.translation === "object") {
    const t = o.translation || {};

    const modelId = String(t.modelId || TR_DEFAULTS?.modelId || "gpt-4o-mini");
    const modelObj = typeof TranslationCatalog?.getModelById === "function" ? TranslationCatalog.getModelById(modelId) : null;

    const sourceLang = String(t.sourceLang || TR_DEFAULTS?.sourceLang || "auto");

    const fallbackTargets =
      (Array.isArray(TR_DEFAULTS?.targetLangs) && TR_DEFAULTS.targetLangs.length ? TR_DEFAULTS.targetLangs : ["en"]);

const targetLangs = uniqStrings(
  (Array.isArray(t.targetLangs) && t.targetLangs.length ? t.targetLangs : fallbackTargets)
    .map((x) => safeLangKey(x))
    .filter(Boolean)
);

    o.translation = {
      enabled: !!t.enabled,
      provider: t.provider != null ? String(t.provider) : (modelObj?.provider || "openai"),
      modelId: String(modelObj?.id || modelId),
      sourceLang,
      targetLangs, // ✅ always array
    };

    return o;
  }

  // If caller set doTranslate but forgot translation block, enforce catalog defaults.
  if (o.doTranslate) {
    const fallbackTargets =
      (Array.isArray(TR_DEFAULTS?.targetLangs) && TR_DEFAULTS.targetLangs.length ? TR_DEFAULTS.targetLangs : ["en"]);

    const modelId = String(TR_DEFAULTS?.modelId || "gpt-4o-mini");
    const modelObj = typeof TranslationCatalog?.getModelById === "function" ? TranslationCatalog.getModelById(modelId) : null;

    o.translation = {
      enabled: true,
      provider: modelObj?.provider || "openai",
      modelId: String(modelObj?.id || modelId),
      sourceLang: String(TR_DEFAULTS?.sourceLang || "auto"),
      targetLangs: uniqStrings(fallbackTargets),
    };
  }

  return o;
}


// =========================
// ✅ Translation optimistic reserve helpers
// =========================
function getTranscriptSegmentsAny(chatItem) {
  const r = chatItem?.results && typeof chatItem.results === "object" ? chatItem.results : {};
  const a = Array.isArray(r.transcriptSegments) ? r.transcriptSegments : [];
  if (a.length) return a;
  const b = Array.isArray(r.transcriptSegmentsOriginal) ? r.transcriptSegmentsOriginal : [];
  if (b.length) return b;
  return [];
}

function estimateTranslationUnitTokensDeterministic({ segments, seconds, modelId, estimateOpts } = {}) {
  const segs = Array.isArray(segments) ? segments : [];
  const dur = Number(seconds || 0) || 0;

  // Prefer shared estimator if present (matches server logic closely)
  if (typeof TranslationBilling?.estimateTranslationRunWithDurationFallback === "function") {
    try {
      const opts = estimateOpts && typeof estimateOpts === "object" ? { ...estimateOpts } : {};
      if (modelId && !opts.modelId) opts.modelId = String(modelId);

      // ✅ unit estimate: pass ONE lang so output is "per-lang"
      const est = TranslationBilling.estimateTranslationRunWithDurationFallback(
        segs.length ? { segments: segs } : null,
        dur,
        ["en"],
        opts
      );

      const n = Number(est?.mediaTokens || 0) || 0;
      return Math.max(1, Math.round(n));
    } catch {}
  }

  // Fallback heuristic: chars/4 + small overhead, duration fallback if no segs
  const charCount = segs.reduce((a, s) => a + String(s?.text || "").length, 0);
  if (charCount > 0) return Math.max(1, Math.ceil(charCount / 4) + 25);
  if (dur > 0) return Math.max(1, Math.ceil(dur)); // very rough
  return 0;
}

function translateKey(threadId, chatItemId, lang) {
  return `${String(threadId)}:chat:${String(chatItemId)}:tr:${safeLangKey(lang)}`;
}

function unionLangs(a, b) {
  const out = [];
  const seen = new Set();
  for (const x of Array.isArray(a) ? a : []) {
    const k = safeLangKey(x);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  for (const x of Array.isArray(b) ? b : []) {
    const k = safeLangKey(x);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

function langsToQueueFromStatus(chatItem, targetLangs, force) {
  const langs = Array.isArray(targetLangs) ? targetLangs.map(safeLangKey).filter(Boolean) : [];
  if (!langs.length) return [];
  if (force) return langs;

  const st = chatItem?.status && typeof chatItem.status === "object" ? chatItem.status : {};
  const tr = st?.translate && typeof st.translate === "object" ? st.translate : {};
  const byLang = tr?.byLang && typeof tr.byLang === "object" ? tr.byLang : {};

  const out = [];
  for (const l of langs) {
    const cur = String(byLang?.[l]?.state || "");
    if (cur === "done") continue;
    if (cur === "queued" || cur === "running") continue;
    out.push(l);
  }
  return out;
}

function setSummarizeQueuedOnThread({
  threadId,
  chatItemId,
  modelId,
  language,
  tokens,
  clearSummary,
  setThreadsById,
  threadsRef,
  persist,
  activeRef,
  syncRef,
  scope,
} = {}) {
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
  const prevSum = status.summarize && typeof status.summarize === "object" ? status.summarize : {};

  const now = nowIso();

  const nextResults = clearSummary
    ? { ...results, summary: "", summaryText: "", summarySrt: "" }
    : results;

  const billing = it?.billing && typeof it.billing === "object" ? it.billing : {};
  const nTok = Math.max(0, Number(tokens || 0) || 0);

  const nextItems = [...items];
  nextItems[idx] = {
    ...it,
    billing: {
      ...billing,
      summarizePotentialTokens: nTok > 0 ? nTok : undefined,
      summaryPotentialTokens: nTok > 0 ? nTok : undefined,
    },
    status: {
      ...status,
      summarize: {
        ...prevSum,
        state: "queued",
        stage: "QUEUED",
        progress: 0,
        error: null,
        modelId: modelId || prevSum.modelId || null,
        // ✅ server contract: summarize.targetLang
        targetLang: language || prevSum.targetLang || prevSum.language || prevSum.lang || "auto",
        // ✅ keep legacy fields for UI/back-compat
        language: language || prevSum.language || prevSum.lang || prevSum.targetLang || "auto",
        lang: language || prevSum.lang || prevSum.targetLang || "auto",
        queuedAt: now,
        startedAt: null,
        finishedAt: null,
        potentialTokens: nTok > 0 ? nTok : undefined,
        estimatedTokens: nTok > 0 ? nTok : undefined,
      },
    },
    results: { ...nextResults },
    updatedAt: now,
  };

  const nextThread = { ...t, chatItems: nextItems, updatedAt: now };
  const nextThreads = { ...cur, [tid]: nextThread };

  setThreadsById(nextThreads);
  threadsRef.current = nextThreads;

  try {
    if (scope && String(activeRef.current) === String(tid)) {
      persist(nextThreads, activeRef.current, syncRef.current).catch(() => {});
    }
  } catch {}
}


function setTranslateQueuedOnThread({
  threadId,
  chatItemId,
  langsQueued,
  unitTokens,
  modelId,
  sourceLang,
  allTargetLangs,
  clearTranslate,
  setThreadsById,
  threadsRef,
  persist,
  activeRef,
  syncRef,
 scope,
} = {}) {
  const tid = String(threadId || "");
  const cid = String(chatItemId || "");
  const langs = Array.isArray(langsQueued) ? langsQueued.map(safeLangKey).filter(Boolean) : [];
  if (!tid || !cid || !langs.length) return;

  const cur = threadsRef.current || {};
  const t = cur[tid];
  if (!t) return;

  const items = ensureChatItemsArray(t.chatItems);
  const idx = items.findIndex((x) => String(x?.chatItemId || "") === cid);
  if (idx < 0) return;

  const it = items[idx] || {};
  const status = it.status || {};
  const results = it.results || {};

  const prevTr = status.translate && typeof status.translate === "object" ? status.translate : {};
  const prevByLang = prevTr.byLang && typeof prevTr.byLang === "object" ? prevTr.byLang : {};

  const now = nowIso();

  const nextByLang = { ...prevByLang };
  for (const l of langs) {
    const prev = nextByLang[l] && typeof nextByLang[l] === "object" ? nextByLang[l] : {};
    nextByLang[l] = {
      ...prev,
      state: "queued",
      progress: 0,
      targetLang: l,
      modelId: modelId || prev.modelId || null,
      sourceLang: sourceLang || prev.sourceLang || null,
      queuedAt: now,
      startedAt: null,
      finishedAt: null,
      error: null,
      // ✅ show "reserved" on the item (like transcribe potentialTokens)
      potentialTokens: unitTokens > 0 ? unitTokens : undefined,
      estimatedTokens: unitTokens > 0 ? unitTokens : undefined,
    };
  }

  const mergedTargets = unionLangs(allTargetLangs || prevTr.targetLangs, langs);

  let nextTranslations = results.translations && typeof results.translations === "object" ? results.translations : {};
  if (clearTranslate) {
    for (const l of langs) nextTranslations = deleteLangKey(nextTranslations, l);
  }

  const billing = it?.billing && typeof it.billing === "object" ? it.billing : {};
  const translateTotal = Math.max(0, Number(unitTokens || 0) || 0) * langs.length;

  const nextItems = [...items];
  nextItems[idx] = {
    ...it,
    billing: { ...billing, translatePotentialTokens: translateTotal > 0 ? translateTotal : undefined },
    status: {
      ...status,
      translate: {
        ...prevTr,
        state: "queued",
        queuedAt: now,
        error: null,
        modelId: modelId || prevTr.modelId || null,
        sourceLang: sourceLang || prevTr.sourceLang || null,
        targetLangs: mergedTargets,
        byLang: nextByLang,
      },
    },
    results: {
      ...results,
      translations: nextTranslations,
      updatedAt: now,
    },
    updatedAt: now,
  };

  const nextThread = { ...t, chatItems: nextItems, updatedAt: now };
  const nextThreads = { ...cur, [tid]: nextThread };

  setThreadsById(nextThreads);
  threadsRef.current = nextThreads;

  try {
    if (scope && String(activeRef.current) === String(tid)) {
      persist(nextThreads, activeRef.current, syncRef.current).catch(() => {});
    }
  } catch {}
}



export function ThreadsProvider({ children }) {
  const {
    user,
    isAnonymous,
    getJwt,
    refreshTokens,
    applyTokensSnapshot,
    tokenSnapshot,

    // ✅ from your AuthContext (already exists)
    reserveMediaTokens,
    releaseMediaTokens,
    clearAllMediaReservations,
  } = useAuth();

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

  const creatingThreadRef = useRef(false);
const [creatingThread, setCreatingThread] = useState(false);

// ✅ Add these helpers ONCE inside ThreadsProvider (near other refs/helpers)
const draftUploadUiRef = useRef({}); // itemId -> { at, pct, stage }

const clampPctInt = (p) => {
  const n = Number(p);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
};

// Patch draft file UI fields WITHOUT calling commit/persist (so we can update often)
const patchDraftFileUi = (threadId, itemId, patch) => {
  const tid = String(threadId || "");
  const iid = String(itemId || "");
  if (!tid || !iid) return;

  setThreadsById((prev) => {
    const cur = prev || {};
    const t = cur[tid];
    if (!t) return prev;

    const d = ensureDraftShape(t.draft);
    const files = Array.isArray(d.files) ? d.files : [];
    const idx = files.findIndex((x) => String(x?.itemId || "") === iid);
    if (idx < 0) return prev;

    const prevF = files[idx] || {};
    const nextF = { ...prevF, ...(patch || {}), updatedAt: nowIso() };

    const nextFiles = [...files];
    nextFiles[idx] = nextF;

    const nextThread = { ...t, draft: { ...d, files: nextFiles }, updatedAt: nowIso() };
    const next = { ...cur, [tid]: nextThread };
    threadsRef.current = next;
    return next;
  });
};

const forwardUploadProgressToDraft = (threadId, itemId, ev) => {
  const iid = String(itemId || "");
  if (!iid) return;

  const now = Date.now();
  const pct = clampPctInt(ev?.pct);
  const stage = String(ev?.stage || "").trim();
  const sentBytes = Number(ev?.sentBytes || 0) || null;
  const receivedBytes = Number(ev?.receivedBytes || 0) || null;

  const last = draftUploadUiRef.current[iid] || {};
  const changed =
    (pct != null && pct !== last.pct) ||
    (stage && stage !== last.stage) ||
    !last.at ||
    now - last.at > 200; // throttle

  if (!changed) return;

  draftUploadUiRef.current[iid] = { at: now, pct, stage };

  patchDraftFileUi(threadId, iid, {
    stage: "uploading",
    uploadPct: pct,
    uploadStage: stage || null,
    uploadSentBytes: sentBytes,
    uploadReceivedBytes: receivedBytes,
  });
};


  useEffect(() => {
    threadsRef.current = threadsById;
  }, [threadsById]);

  useEffect(() => {
    activeRef.current = activeId;
  }, [activeId]);

  const scope = useMemo(() => makeScope(user, isAnonymous), [user?.$id, isAnonymous]);


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
  // Token refresh throttling
  // =========================
  const tokenRefreshRef = useRef({ at: 0, inFlight: false });

  const refreshTokensThrottled = async () => {
    if (isAnonymous) return;
    if (typeof refreshTokens !== "function") return;

    const now = Date.now();
    const lastAt = Number(tokenRefreshRef.current?.at || 0) || 0;

    if (tokenRefreshRef.current?.inFlight) return;
    if (now - lastAt < 3500) return;

    tokenRefreshRef.current = { ...tokenRefreshRef.current, inFlight: true };
    try {
      await refreshTokens();
    } catch {}
    tokenRefreshRef.current = { at: Date.now(), inFlight: false };
  };

  const patchLiveThread = (threadId, patch) => {
    const tid = String(threadId || "");
    if (!tid) return;
    setLiveRunsByThread((prev) => {
      const cur = (prev && prev[tid]) || {};
      return { ...(prev || {}), [tid]: { ...cur, ...(patch || {}), updatedAt: nowIso() } };
    });
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

      const existingBilling = existing.billing && typeof existing.billing === "object" ? existing.billing : {};
      const patchBilling = nextPatch.billing && typeof nextPatch.billing === "object" ? nextPatch.billing : null;

      return {
        ...(prev || {}),
        [tid]: {
          ...cur,
          chatItems: {
            ...chatItems,
            [cid]: {
              ...existing,
              ...nextPatch,
              billing: patchBilling ? { ...existingBilling, ...patchBilling } : existing.billing,
              updatedAt: nowIso(),
            },
          },
          updatedAt: nowIso(),
        },
      };
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

  useEffect(() => {
  if (!scope) return;

  // kill any previous WS connection immediately
  disconnectWs();

  // reset in-memory state so we don’t try to connect to an old thread id
  setLiveRunsByThread({});
  setThreadsById({});
  setActiveIdState("default");

  threadsRef.current = {};
  activeRef.current = "default";
  syncRef.current = { indexAt: null };

  setWsError(null);
  setWsStatus("disconnected");
}, [scope]);


  // =========================
  // Optimistic reservation bookkeeping
  // =========================
  const canReserve =
    typeof reserveMediaTokens === "function" &&
    typeof releaseMediaTokens === "function" &&
    typeof clearAllMediaReservations === "function";

const releaseForSummarizeChatItem = (threadId, chatItemId) => {
  if (!canReserve) return;
  const tid = String(threadId || "");
  const cid = String(chatItemId || "");
  if (!tid || !cid) return;

  const prefix = summarizePrefix(tid, cid);
  const keys = Object.keys(reservedKeysRef.current || {});
  for (const k of keys) {
    if (k.startsWith(prefix)) releaseKey(k);
  }
};


  // key -> amount (mirror of AuthContext, but lets us transfer item->chat)
  const reservedKeysRef = useRef({});

  const clearAllOptimisticReservations = () => {
    if (!canReserve) return;
    clearAllMediaReservations();
    reservedKeysRef.current = {};
  };

  const reserveKey = (key, tokens) => {
    if (!canReserve) return;
    const k = String(key || "").trim();
    const n = Math.max(0, Number(tokens || 0) || 0);
    if (!k || n <= 0) return;

    reservedKeysRef.current[k] = n;
    reserveMediaTokens(k, n);
  };

  const releaseKey = (key) => {
    if (!canReserve) return;
    const k = String(key || "").trim();
    if (!k) return;

    releaseMediaTokens(k);
    const next = { ...(reservedKeysRef.current || {}) };
    delete next[k];
    reservedKeysRef.current = next;
  };

  const getThreadFallbackModelId = (thread) => {
    return (
      thread?.draft?.shared?.modelId ||
      thread?.draft?.shared?.transcribeModelId ||
      thread?.shared?.modelId ||
      thread?.runModelId ||
      null
    );
  };

  const estimateForChatItem = (thread, chatItem) => {
    const seconds = Number(
      chatItem?.media?.durationSeconds ??
        chatItem?.media?.duration ??
        chatItem?.media?.seconds ??
        chatItem?.local?.durationSeconds ??
        0
    );

    if (!Number.isFinite(seconds) || seconds <= 0) return 0;

    const fallbackModelId = getThreadFallbackModelId(thread);
    const modelId =
      chatItem?.modelId ||
      chatItem?.options?.modelId ||
      chatItem?.status?.transcribe?.modelId ||
      fallbackModelId ||
      "";

    // Optional strictness: only estimate if pricingVersion matches server
    // const clientV = Billing?.PRICING_VERSION ? String(Billing.PRICING_VERSION) : null;
    // const serverV = tokenSnapshot?.pricingVersion ? String(tokenSnapshot.pricingVersion) : null;
    // if (clientV && serverV && clientV !== serverV) return 0;

    return estimateTokensForSecondsDeterministic(seconds, modelId);
  };

  const estimateForDraftItem = (thread, draftFile) => {
    const seconds = Number(
      draftFile?.local?.durationSeconds ?? draftFile?.audio?.durationSeconds ?? draftFile?.durationSeconds ?? 0
    );
    if (!Number.isFinite(seconds) || seconds <= 0) return 0;

    const fallbackModelId = getThreadFallbackModelId(thread);
    const modelId = draftFile?.modelId || draftFile?.options?.modelId || fallbackModelId || "";
    return estimateTokensForSecondsDeterministic(seconds, modelId);
  };

  const reserveForChatItems = (threadId, chatItemIds) => {
    if (!canReserve) return;

    const tid = String(threadId || "");
    const ids = Array.isArray(chatItemIds) ? chatItemIds.map((x) => String(x || "")).filter(Boolean) : [];
    if (!tid || !ids.length) return;

    const t = (threadsRef.current || {})[tid];
    const items = ensureChatItemsArray(t?.chatItems);

    for (const cid of ids) {
      const it = items.find((x) => String(x?.chatItemId || "") === cid);
      if (!it) continue;

      const est = estimateForChatItem(t, it);
      if (est > 0) {
        const key = `${tid}:chat:${cid}`;
        reserveKey(key, est);
        patchLiveChatItem(tid, cid, { billing: { potentialTokens: est }, potentialTokens: est });
      }
    }
  };


  const reserveForSummarizeChatItems = (threadId, chatItemIds, normalizedOptions, { force, clearSummary } = {}) => {
  if (!canReserve) return;

  const tid = String(threadId || "");
  const ids = Array.isArray(chatItemIds) ? chatItemIds.map((x) => String(x || "")).filter(Boolean) : [];
  if (!tid || !ids.length) return;

  const t = (threadsRef.current || {})[tid];
  const items = ensureChatItemsArray(t?.chatItems);

  const s = normalizedOptions?.summarize && typeof normalizedOptions.summarize === "object" ? normalizedOptions.summarize : null;
  if (!s || !s.enabled) return;

  const modelId = String(s.modelId || TR_DEFAULTS?.modelId || "gpt-4o-mini");
  const targetLang = String(s.targetLang || "auto") || "auto";

  for (const cid of ids) {
    const it = items.find((x) => String(x?.chatItemId || "") === cid);
    if (!it) continue;

    // skip if already running unless force
    const curState = String(it?.status?.summarize?.state || "");
    if (!force && (curState === "queued" || curState === "running")) continue;

    const text = getTranscriptTextAny(it);
    if (!text) continue;

    const tok = estimateSummaryMediaTokensDeterministic({ text, modelId, targetLang });
    if (!(tok > 0)) continue;

    const key = summarizeKey(tid, cid, modelId, targetLang);

    // ✅ make reserveKey idempotent (optional, but recommended)
    const prev = Number(reservedKeysRef.current?.[key] || 0) || 0;
    if (prev !== tok) {
      if (prev > 0) releaseKey(key);
      reserveKey(key, tok);
    }

    setSummarizeQueuedOnThread({
      threadId: tid,
      chatItemId: cid,
      modelId,
      language: targetLang,
      tokens: tok,
      clearSummary: !!clearSummary,
      setThreadsById,
      threadsRef,
      persist,
      activeRef,
      syncRef,
      scope,
    });

    patchLiveChatItem(tid, cid, {
      billing: { summarizePotentialTokens: tok, summaryPotentialTokens: tok },
      updatedAt: nowIso(),
    });
  }
};



  const reserveForTranslateChatItems = (threadId, chatItemIds, normalizedOptions, { force, clearTranslate } = {}) => {
    if (!canReserve) return;

    const tid = String(threadId || "");
    const ids = Array.isArray(chatItemIds) ? chatItemIds.map((x) => String(x || "")).filter(Boolean) : [];
    if (!tid || !ids.length) return;

   const t = (threadsRef.current || {})[tid];
    const items = ensureChatItemsArray(t?.chatItems);

    const tr = normalizedOptions?.translation && typeof normalizedOptions.translation === "object" ? normalizedOptions.translation : null;
    const targetLangsAll = Array.isArray(tr?.targetLangs) ? tr.targetLangs.map(safeLangKey).filter(Boolean) : [];
    if (!targetLangsAll.length) return;

    const modelId = String(tr?.modelId || TR_DEFAULTS?.modelId || "gpt-4o-mini");
    const sourceLang = String(tr?.sourceLang || TR_DEFAULTS?.sourceLang || "auto");

    const estimateOpts =
      tr?.estimate && typeof tr.estimate === "object"
        ? tr.estimate
        : null;

    for (const cid of ids) {
      const it = items.find((x) => String(x?.chatItemId || "") === cid);
      if (!it) continue;

      const langsQueued = langsToQueueFromStatus(it, targetLangsAll, !!force);
      if (!langsQueued.length) continue;

      const segs = getTranscriptSegmentsAny(it);
      // translate retry should have transcript segments; if not, skip reserve
      if (!segs.length) continue;

      const seconds = Number(it?.media?.durationSeconds || it?.media?.duration || 0) || 0;
      const unit = estimateTranslationUnitTokensDeterministic({ segments: segs, seconds, modelId, estimateOpts });
      if (!(unit > 0)) continue;

      // ✅ reserve per lang so we can release per lang later
      for (const l of langsQueued) {
        reserveKey(translateKey(tid, cid, l), unit);
      }

      // ✅ reflect "queued + reserved" on the item immediately (like transcribe)
      setTranslateQueuedOnThread({
        threadId: tid,
        chatItemId: cid,
        langsQueued,
        unitTokens: unit,
        modelId,
        sourceLang,
        allTargetLangs: targetLangsAll,
        clearTranslate: !!clearTranslate,
        setThreadsById,
        threadsRef,
        persist,
        activeRef,
        syncRef,
        scope,
      });

      patchLiveChatItem(tid, cid, {
       billing: { translatePotentialTokens: unit * langsQueued.length },
        updatedAt: nowIso(),
      });
    }
  };

  const releaseForTranslateChatItem = (threadId, chatItemId, langs) => {
    if (!canReserve) return;
    const tid = String(threadId || "");
    const cid = String(chatItemId || "");
    if (!tid || !cid) return;

    const ls = Array.isArray(langs) ? langs.map(safeLangKey).filter(Boolean) : [];
    if (ls.length) {
      for (const l of ls) releaseKey(translateKey(tid, cid, l));
      return;
    }

    // release all translate keys for this chat item
    const prefix = `${tid}:chat:${cid}:tr:`;
    const keys = Object.keys(reservedKeysRef.current || {});
    for (const k of keys) {
      if (k.startsWith(prefix)) releaseKey(k);
    }
  };

  const releaseForTranslateChatItems = (threadId, chatItemIds) => {
    const tid = String(threadId || "");
    const ids = Array.isArray(chatItemIds) ? chatItemIds.map((x) => String(x || "")).filter(Boolean) : [];
    if (!tid || !ids.length) return;
    for (const cid of ids) releaseForTranslateChatItem(tid, cid);
  };
  

  const reserveForDraftItemIds = (threadId, itemIds) => {
    if (!canReserve) return;

    const tid = String(threadId || "");
    const ids = Array.isArray(itemIds) ? itemIds.map((x) => String(x || "")).filter(Boolean) : [];
    if (!tid || !ids.length) return;

    const t = (threadsRef.current || {})[tid];
    if (!t) return;

    const d = ensureDraftShape(t.draft);
    const files = Array.isArray(d.files) ? d.files : [];

    for (const iid of ids) {
      const f = files.find((x) => String(x?.itemId || "") === iid);
      if (!f) continue;

      const est = estimateForDraftItem(t, f);
      if (est > 0) {
        const key = `${tid}:item:${iid}`;
        reserveKey(key, est);
      }
    }
  };

  const transferReservationItemToChat = (threadId, itemId, chatItemId) => {
    if (!canReserve) return;

    const tid = String(threadId || "");
    const iid = String(itemId || "");
    const cid = String(chatItemId || "");
    if (!tid || !iid || !cid) return;

    const itemKey = `${tid}:item:${iid}`;
    const n = Number(reservedKeysRef.current?.[itemKey] || 0) || 0;
    if (n <= 0) return;

    releaseKey(itemKey);
    const chatKey = `${tid}:chat:${cid}`;
    reserveKey(chatKey, n);
    patchLiveChatItem(tid, cid, { billing: { potentialTokens: n }, potentialTokens: n });
  };

  const releaseForChatItems = (threadId, chatItemIds) => {
    if (!canReserve) return;

    const tid = String(threadId || "");
    const ids = Array.isArray(chatItemIds) ? chatItemIds.map((x) => String(x || "")).filter(Boolean) : [];
    if (!tid || !ids.length) return;

    for (const cid of ids) {
      releaseKey(`${tid}:chat:${cid}`);
      patchLiveChatItem(tid, cid, { billing: { potentialTokens: null }, potentialTokens: null });
    }
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

  // =========================
  // WS events
  // =========================
  const handleWsEvent = async (msg) => {
    const type = String(msg?.type || "");
    const threadId = String(msg?.threadId || "");

    if (type === "HELLO_OK") {
  setWsError(null);
  setWsStatus("ready");

  try {
    const p = msg?.payload || {};

    // ✅ prevent "flash to 0": only apply fields that actually exist
    const patch = pickTokenPatch(p);
    if (patch && typeof applyTokensSnapshot === "function") {
      applyTokensSnapshot(patch);
    }

    // ✅ don't nuke optimistic reservations just because a new WS connected
    // (creating/switching threads can otherwise drop the blue "pending" too early)
    const hasOptimistic = Object.keys(reservedKeysRef.current || {}).length > 0;
    if (!hasOptimistic) {
      clearAllOptimisticReservations();
    }
  } catch {}

  return;
}

    if (type === "TOKENS_UPDATED") {
      const payload = msg?.payload || {};
      const rawTok = payload.tokens || payload.tokenSnapshot || null;
      const billing = payload.billing || null;

      try {
        const patch = pickTokenPatch(rawTok);
        if (patch && typeof applyTokensSnapshot === "function") applyTokensSnapshot(patch);

        // authoritative => clear optimistic
        clearAllOptimisticReservations();
      } catch {}

      if (billing) {
        const maps = extractBillingMaps(billing);

        patchLiveThread(threadId, {
          billing,
          billingByChatItemId: maps.byChatItemId || null,
          billingByItemId: maps.byItemId || null,
        });

        if (maps.byChatItemId) {
          for (const [cid, tokens] of Object.entries(maps.byChatItemId)) {
            const n = Number(tokens || 0) || 0;
            patchLiveChatItem(threadId, cid, {
              billing: { transcribeTokens: n, mediaTokens: n },
              transcribeTokens: n,
              mediaTokens: n,
            });
          }
          applyBillingMapToThreadItems(threadId, maps.byChatItemId, setThreadsById, threadsRef);
        }
      }

      return;
    }

    if (type === "ERROR") {
      const code = msg?.payload?.code || "WS_ERROR";
      const message = msg?.payload?.message || "WebSocket error";
      setWsError({ code, message });
      toastWs(code, message);

      // apply authoritative snapshot if any
      try {
        const p = msg?.payload || {};
        const rawTok = p.tokens || p.tokenSnapshot || null;
        const patch = pickTokenPatch(rawTok);
        if (patch && typeof applyTokensSnapshot === "function") applyTokensSnapshot(patch);

        clearAllOptimisticReservations();

        if (p.billing) {
          const maps = extractBillingMaps(p.billing);
          patchLiveThread(threadId, {
            billing: p.billing,
            billingByChatItemId: maps.byChatItemId || null,
            billingByItemId: maps.byItemId || null,
          });

          if (maps.byChatItemId) {
            for (const [cid, tokens] of Object.entries(maps.byChatItemId)) {
              const n = Number(tokens || 0) || 0;
              patchLiveChatItem(threadId, cid, {
                billing: { transcribeTokens: n, mediaTokens: n },
                transcribeTokens: n,
                mediaTokens: n,
              });
            }
            applyBillingMapToThreadItems(threadId, maps.byChatItemId, setThreadsById, threadsRef);
          }
        }
      } catch {}

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
      nextItems[idx] = { ...it, media: { ...media, playbackUrl: url }, updatedAt: nowIso() };

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

      const billing = msg?.payload?.billing || null;
      if (billing) {
        const maps = extractBillingMaps(billing);
        patchLiveThread(threadId, {
          billing,
          billingByChatItemId: maps.byChatItemId || null,
          billingByItemId: maps.byItemId || null,
        });

        if (maps.byChatItemId) {
          for (const [cid, tokens] of Object.entries(maps.byChatItemId)) {
            const n = Number(tokens || 0) || 0;
            patchLiveChatItem(threadId, cid, {
              billing: { transcribeTokens: n, mediaTokens: n },
              transcribeTokens: n,
              mediaTokens: n,
            });
          }
          applyBillingMapToThreadItems(threadId, maps.byChatItemId, setThreadsById, threadsRef);
        }
      }

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
        const tLocal = (threadsRef.current || {})[threadId];
        const d = tLocal?.draft && typeof tLocal.draft === "object" ? tLocal.draft : null;
        const files = Array.isArray(d?.files) ? d.files : [];
        for (const f of files) {
          const iid = String(f?.itemId || "");
          if (!iid) continue;
          draftMap[iid] = { clientFileId: f?.clientFileId || null, local: f?.local || null };
        }
      } catch {}

      const patchedItems = items.map((it) => {
        const iid = String(it?.itemId || "");
        const m = it?.media && typeof it.media === "object" ? it.media : {};
        if (m.clientFileId) return it;

        const hit = draftMap[iid];
        if (!hit?.clientFileId) return it;

        return { ...it, media: { ...m, clientFileId: String(hit.clientFileId) } };
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
        if (it?.chatItemId) patchLiveChatItem(threadId, it.chatItemId, { status: it.status || {}, stream: {}, progress: {} });
      }
      if (runId) patchLiveThread(threadId, { lastRunId: runId });

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

      // ✅ move itemId reservation -> chatItemId reservation
      try {
        for (const it of patchedItems) {
          const iid = String(it?.itemId || "");
          const cid = String(it?.chatItemId || "");
          if (!iid || !cid) continue;
          transferReservationItemToChat(threadId, iid, cid);
        }
      } catch {}

      // ✅ if server billed by itemId first, attach once chatItemId exists
      try {
        const liveForThread = liveRunsByThread && liveRunsByThread[String(threadId)] ? liveRunsByThread[String(threadId)] : null;
        const byItemId = liveForThread?.billingByItemId || null;

        if (byItemId && patchedItems.length) {
          for (const it2 of patchedItems) {
            const iid = String(it2?.itemId || "");
            const cid = String(it2?.chatItemId || "");
            const n = Number((iid && byItemId[iid]) || 0) || 0;
            if (!iid || !cid || n <= 0) continue;

            patchLiveChatItem(threadId, cid, {
              billing: { transcribeTokens: n, mediaTokens: n },
              transcribeTokens: n,
              mediaTokens: n,
            });

            applyBillingMapToThreadItems(threadId, { [cid]: n }, setThreadsById, threadsRef);
          }
        }
      } catch {}

      return;
    }

    if (type === "CHAT_ITEM_SEGMENTS") {
  const chatItemId = String(msg?.payload?.chatItemId || "");
  const step = String(msg?.payload?.step || "transcribe");
  const lang = String(msg?.payload?.lang || msg?.payload?.targetLang || ""); // ✅ NEW
  const incoming = Array.isArray(msg?.payload?.segments) ? msg.payload.segments : [];
  const append = !!msg?.payload?.append;
  if (!chatItemId) return;

  setLiveRunsByThread((prev) => {
    const cur = (prev && prev[threadId]) || {};
    const chatItems = cur.chatItems && typeof cur.chatItems === "object" ? cur.chatItems : {};
    const existing = chatItems[chatItemId] || {};

    const segObj = existing.segments && typeof existing.segments === "object" ? existing.segments : {};
    const existingStep = segObj[step];

    let nextStepValue;

    const useLang = step === "translate" && lang;

    if (useLang) {
      const stepMap = existingStep && typeof existingStep === "object" && !Array.isArray(existingStep) ? existingStep : {};
      const arr = Array.isArray(stepMap[lang]) ? stepMap[lang] : [];
      const nextArr = append ? [...arr, ...incoming] : [...incoming];
      nextStepValue = { ...stepMap, [lang]: nextArr };
    } else {
      const arr = Array.isArray(existingStep) ? existingStep : [];
      nextStepValue = append ? [...arr, ...incoming] : [...incoming];
    }


    return {
      ...(prev || {}),
      [threadId]: {
        ...cur,
        chatItems: {
          ...chatItems,
          [chatItemId]: {
            ...existing,
            segments: { ...segObj, [step]: nextStepValue },
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
  const lang = String(msg?.payload?.lang || msg?.payload?.targetLang || ""); // ✅ NEW
  const progress = Number(msg?.payload?.progress || 0);
  if (!chatItemId || !step) return;

  setLiveRunsByThread((prev) => {
    const cur = (prev && prev[threadId]) || {};
    const chatItems = cur.chatItems && typeof cur.chatItems === "object" ? cur.chatItems : {};
    const existing = chatItems[chatItemId] || {};
    const existingProgress = existing.progress && typeof existing.progress === "object" ? existing.progress : {};
    const existingStep = existingProgress[step];

    let nextStepValue;

      const useLang = step === "translate" && lang;

      if (useLang) {
        const stepMap = existingStep && typeof existingStep === "object" && !Array.isArray(existingStep) ? existingStep : {};
        nextStepValue = { ...stepMap, [lang]: progress };
      } else {
        nextStepValue = progress;
      }


    return {
      ...(prev || {}),
      [threadId]: {
        ...cur,
        chatItems: {
          ...chatItems,
          [chatItemId]: {
            ...existing,
            progress: { ...existingProgress, [step]: nextStepValue },
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
  const lang = String(msg?.payload?.lang || msg?.payload?.targetLang || ""); // ✅ NEW
  const text = String(msg?.payload?.text || "");
  if (!chatItemId || !step || !text) return;

  setLiveRunsByThread((prev) => {
    const cur = (prev && prev[threadId]) || {};
    const chatItems = cur.chatItems && typeof cur.chatItems === "object" ? cur.chatItems : {};
    const existing = chatItems[chatItemId] || {};
    const stream = existing.stream && typeof existing.stream === "object" ? existing.stream : {};
    const existingStep = stream[step];

    let nextStepValue;

    const useLang = step === "translate" && lang;

    if (useLang) {
      const stepMap = existingStep && typeof existingStep === "object" && !Array.isArray(existingStep) ? existingStep : {};
      const arr = Array.isArray(stepMap[lang]) ? stepMap[lang] : [];
      nextStepValue = { ...stepMap, [lang]: [...arr, text] };
    } else {
      const arr = Array.isArray(existingStep) ? existingStep : [];
      nextStepValue = [...arr, text];
    }


    return {
      ...(prev || {}),
      [threadId]: {
        ...cur,
        chatItems: {
          ...chatItems,
          [chatItemId]: {
            ...existing,
            stream: { ...stream, [step]: nextStepValue },
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

      try {
        const st = String(patch?.status?.transcribe?.state || "");
        if (st === "done" || st === "failed") {
          releaseForChatItems(threadId, [chatItemId]);
          refreshTokensThrottled().catch(() => {});
        }
      } catch {}

      // ✅ release translate optimistic per-lang when done/failed/blocked
      try {
        const tr = patch?.status?.translate && typeof patch.status.translate === "object" ? patch.status.translate : null;
        const rootState = String(tr?.state || "");

        if (rootState === "done" || rootState === "failed" || rootState === "blocked") {
          releaseForTranslateChatItem(threadId, chatItemId);
          refreshTokensThrottled().catch(() => {});
        } else {
          const byLang = tr?.byLang && typeof tr.byLang === "object" ? tr.byLang : null;
          if (byLang) {
            const finished = [];
            for (const [lang, row] of Object.entries(byLang)) {
              const s = String(row?.state || "");
              if (s === "done" || s === "failed" || s === "blocked") finished.push(lang);
            }
            if (finished.length) releaseForTranslateChatItem(threadId, chatItemId, finished);
          }
        }
      } catch {}

      // ✅ release summarize optimistic when done/failed/blocked
try {
  const su = patch?.status?.summarize && typeof patch.status.summarize === "object" ? patch.status.summarize : null;
  const st = String(su?.state || "");
  if (st === "done" || st === "failed" || st === "blocked") {
    releaseForSummarizeChatItem(threadId, chatItemId);
    refreshTokensThrottled().catch(() => {});
  }
} catch {}


      const cur = threadsRef.current || {};
      const t = cur[threadId];
      if (!t) return;

      const items = ensureChatItemsArray(t.chatItems);
      const idx = items.findIndex((x) => String(x?.chatItemId) === chatItemId);
      if (idx < 0) return;

      const nextItems = [...items];
      nextItems[idx] = applyChatItemPatch(nextItems[idx], patch);

const nextThread = { ...t, chatItems: nextItems, updatedAt: nowIso() };
const nextThreads = { ...cur, [threadId]: nextThread };

setThreadsById(nextThreads);
threadsRef.current = nextThreads;

// ✅ persist so refresh keeps the latest translations
try {
  if (scope && String(activeRef.current) === String(threadId)) {
    persist(nextThreads, activeRef.current, syncRef.current).catch(() => {});
  }
} catch {}

return;

    }

    if (type === "RUN_COMPLETED") {
      refreshTokensThrottled().catch(() => {});
      return;
    }

    if (type === "RUN_FAILED") {
      const message = String(msg?.payload?.message || "Run failed");
      toast.error(message);

      // release optimistic for this thread
      try {
        const tid = String(threadId || "");
        const liveT = threadsRef.current?.[tid];
        const ids = ensureChatItemsArray(liveT?.chatItems).map((x) => String(x?.chatItemId || "")).filter(Boolean);
        releaseForChatItems(tid, ids);
        releaseForTranslateChatItems(tid, ids);
        for (const cid of ids) releaseForSummarizeChatItem(tid, cid);
      } catch {}

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

    if (wsBoundThreadRef.current && String(wsBoundThreadRef.current) !== tid) disconnectWs();

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

  // --------- BOOT ---------
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
  if (creatingThreadRef.current) {
    toast.message("Already creating a thread…");
    return null;
  }

  creatingThreadRef.current = true;
  setCreatingThread(true);

  const localThread = makeNewThread(`Thread ${new Date().toLocaleString()}`);

  const promise = (async () => {
      const jwt = await getJwtIfAny();
        if (!jwt) throw new Error("No session/JWT (guest cookies likely blocked)");

      const r = await apiCreateThread(jwt, {
        threadId: localThread.id,
        title: localThread.title,
      });

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

    const cur = threadsRef.current || {};
    const next = { ...cur, [localThread.id]: localThread };
    await commit(next, localThread.id, syncRef.current);
    return localThread.id;
  })();

  toast.promise(promise, {
    loading: "Creating thread…",
    success: "Thread created",
    error: (e) => e?.message || "Failed to create thread",
  });

  try {
    return await promise;
  } catch (e) {
    // ✅ IMPORTANT: prevent Next dev overlay from taking over
    // Optional: special-case limits / upgrade UI here
    if (e?.statusCode === 403) {
      // toast.error(e.message) // already handled by toast.promise
      // openUpgradeModal?.()
    }
    return null;
  } finally {
    creatingThreadRef.current = false;
    setCreatingThread(false);
  }
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

  // ---------------- Draft Media (UPLOAD / URL / DELETE) ----------------
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

    // If mp3 already, mark upload progress start
    if (isMp3(file)) {
      patchDraftFileUi(threadId, itemId, { stage: "uploading", uploadPct: 0, uploadStage: "verifying" });
    }

    if (!isMp3(file)) {
      mp3File = await convertToMp3OrPassThrough(file, { ensureFfmpeg, extractAudioToMp3 });

      const curMid = threadsRef.current || {};
      const tMid = curMid[threadId];
      if (tMid) {
        const dMid = ensureDraftShape(tMid.draft);
        const filesMid = [...(dMid.files || [])];
        const idx = filesMid.findIndex((x) => String(x?.itemId) === String(itemId));
        if (idx >= 0) {
          filesMid[idx] = {
            ...filesMid[idx],
            stage: "uploading",
            uploadPct: 0,
            uploadStage: "verifying",
            updatedAt: nowIso(),
          };
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

    try {
      const dur = await probeDurationSecondsFromFile(mp3File);
      if (dur != null) localMeta.durationSeconds = dur;
    } catch {}

    // ✅ ensure WS connected
    await connectWsForThread(threadId);

    // ✅ upload via websocket (binary chunk stream) + forward progress to draft UI
    const r = await uploadDraftFileViaWs({
      wsClient: wsClientRef.current,
      threadId,
      itemId,
      clientFileId,
      file: mp3File,
      localMeta,
      onProgress: (ev) => {
        try {
          forwardUploadProgressToDraft(threadId, itemId, ev);
        } catch {}
      },
    });

    const cur2 = threadsRef.current || {};
    const t2 = cur2[threadId];
    if (!t2) return itemId;

    const d2 = ensureDraftShape(t2.draft);
    const files2 = [...(d2.files || [])];
    const idx2 = files2.findIndex((x) => String(x?.itemId) === String(itemId));
    if (idx2 >= 0) {
      const prev = files2[idx2] || {};
      const srv = r && r.draftFile ? r.draftFile : {};

      files2[idx2] = {
        ...prev,
        ...srv,
        clientFileId: prev.clientFileId,
        local: prev.local,
        audio: { ...(prev.audio || {}), ...(srv.audio || {}) },
        stage: srv && srv.stage ? srv.stage : "uploaded",
        // ✅ clear progress fields once done
        uploadPct: null,
        uploadStage: null,
        uploadSentBytes: null,
        uploadReceivedBytes: null,
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
    // ✅ keep your original toast UX
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

      if (isUpgradeLimitError(e)) {
        openUpgradeFromError(e);
        return formatUpgradeMessage(e);
      }

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

  function normalizeWhitespace(t) {
  return String(t || "").replace(/\s+/g, " ").trim();
}

function parseTimecodeToSeconds(tc) {
  const s = String(tc || "").trim();
  const m = s.match(/^(\d+):(\d+):(\d+),(\d+)$/);
  if (!m) return null;
  const hh = Number(m[1] || 0);
  const mm = Number(m[2] || 0);
  const ss = Number(m[3] || 0);
  const ms = Number(m[4] || 0);
  if (![hh, mm, ss, ms].every((x) => Number.isFinite(x))) return null;
  return hh * 3600 + mm * 60 + ss + ms / 1000;
}

const clearLiveTranslateLangs = (threadId, chatItemId, langs) => {
  const tid = String(threadId || "");
  const cid = String(chatItemId || "");
  const ls = Array.isArray(langs) ? langs.map((x) => safeLangKey(x)).filter(Boolean) : [];
  if (!tid || !cid || !ls.length) return;

  setLiveRunsByThread((prev) => {
    const cur = (prev && prev[tid]) || {};
    const chatItems = cur.chatItems && typeof cur.chatItems === "object" ? cur.chatItems : {};
    const existing = chatItems[cid] || {};

    const stream = existing.stream && typeof existing.stream === "object" ? existing.stream : {};
    const progress = existing.progress && typeof existing.progress === "object" ? existing.progress : {};
    const segments = existing.segments && typeof existing.segments === "object" ? existing.segments : {};

    const trStream =
      stream.translate && typeof stream.translate === "object" && !Array.isArray(stream.translate) ? stream.translate : {};
    const trProg =
      progress.translate && typeof progress.translate === "object" && !Array.isArray(progress.translate)
        ? progress.translate
        : {};
    const trSegs =
      segments.translate && typeof segments.translate === "object" && !Array.isArray(segments.translate)
        ? segments.translate
        : {};

    const nextTrStream = { ...trStream };
    const nextTrProg = { ...trProg };
    const nextTrSegs = { ...trSegs };

    for (const l of ls) {
      nextTrStream[l] = [];
      nextTrProg[l] = 0;
      nextTrSegs[l] = [];
    }

    return {
      ...(prev || {}),
      [tid]: {
        ...cur,
        chatItems: {
          ...chatItems,
          [cid]: {
            ...existing,
            stream: { ...stream, translate: nextTrStream },
            progress: { ...progress, translate: nextTrProg },
            segments: { ...segments, translate: nextTrSegs },
            updatedAt: nowIso(),
          },
        },
        updatedAt: nowIso(),
      },
    };
  });
};


function srtToSegments(srt) {
  const raw = String(srt || "").trim();
  if (!raw) return [];
  const blocks = raw.split(/\n\s*\n/g);
  const out = [];

  for (const b of blocks) {
    const lines = b.split("\n").map((x) => String(x || "").trim());
    if (lines.length < 3) continue;

    const ts = lines[1] || "";
    const parts = ts.split(" --> ");
    if (parts.length !== 2) continue;

    const start = parseTimecodeToSeconds(parts[0]);
    const end = parseTimecodeToSeconds(parts[1]);
    if (start == null || end == null) continue;

    const text = normalizeWhitespace(lines.slice(2).join("\n"));
    if (!text) continue;

    out.push({ start, end, text });
  }

  out.sort((a, b) => a.start - b.start || a.end - b.end);
  return out;
}

function normalizeSegmentsForWs(segments) {
  const arr = Array.isArray(segments) ? segments : [];
  const clean = [];

  for (const s of arr) {
    const start = Number(s?.start);
    const end = Number(s?.end);
    const text = String(s?.text || "").trim();

    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (end < start) continue;
    if (!text) continue;

    clean.push({ start: Math.max(0, start), end: Math.max(0, end), text });
  }

  clean.sort((a, b) => a.start - b.start || a.end - b.end);
  return clean;
}


  const saveSrt = async ({ chatItemId, transcriptSrt, segments } = {}) => {
  const tid = wsBoundThreadRef.current || activeRef.current;
  if (!tid || tid === "default") {
    toast.error("No thread selected.");
    return false;
  }
  if (!wsClientRef.current || !wsClientRef.current.isConnected()) {
    toast.error("Not connected to the realtime server yet.");
    return false;
  }

  const segsRaw = Array.isArray(segments) ? segments : srtToSegments(transcriptSrt);
  const segs = normalizeSegmentsForWs(segsRaw);

  if (!String(chatItemId || "").trim()) {
    toast.error("Missing chatItemId.");
    return false;
  }
  if (!segs.length) {
    toast.error("No segments to save.");
    return false;
  }

  const payload = {
    threadId: String(tid),
    chatItemId: String(chatItemId),
    segments: segs,
  };

  const ok = wsClientRef.current.send("SAVE_SEGMENTS", payload);
  if (!ok) toast.error("Failed to send SAVE_SEGMENTS");
  return ok;
};


const saveTranslationSrt = async ({ chatItemId, lang, translationSrt, segments } = {}) => {
  const tid = wsBoundThreadRef.current || activeRef.current;
  if (!tid || tid === "default") {
    toast.error("No thread selected.");
    return false;
  }
  if (!wsClientRef.current || !wsClientRef.current.isConnected()) {
    toast.error("Not connected to the realtime server yet.");
    return false;
  }

  const cid = String(chatItemId || "").trim();
  const l = safeLangKey(lang); // ✅ match server canonicalization

  if (!cid) {
    toast.error("Missing chatItemId.");
    return false;
  }
  if (!l) {
    toast.error("Missing translation language.");
    return false;
  }

  const segsRaw = Array.isArray(segments) ? segments : srtToSegments(translationSrt);
  const segs = normalizeSegmentsForWs(segsRaw);

  if (!segs.length) {
    toast.error("No translation segments to save.");
    return false;
  }

  const payload = {
    threadId: String(tid),
    chatItemId: cid,
    lang: l,
    segments: segs,
  };

  const ok = wsClientRef.current.send("SAVE_TRANSLATION_SEGMENTS", payload);
  if (!ok) toast.error("Failed to send SAVE_TRANSLATION_SEGMENTS");
  return ok;
};



  // --------- START / RETRY ----------
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
      transcribeTokens: null,
      mediaTokens: null,
    };

    const nextThread = { ...t, chatItems: nextItems, updatedAt: nowIso() };
    const nextThreads = { ...cur, [tid]: nextThread };

    setThreadsById(nextThreads);
    threadsRef.current = nextThreads;

    if (String(activeRef.current) === tid) persist(nextThreads, activeRef.current, syncRef.current).catch(() => {});
  };


  const clearTranslateFieldsOnThread = (threadId, chatItemId, targetLangs) => {
  const tid = String(threadId || "");
  const cid = String(chatItemId || "");
const langs = Array.isArray(targetLangs)
  ? targetLangs.map((x) => safeLangKey(x)).filter(Boolean)
  : [];

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

  const prevTranslations =
    results.translations && typeof results.translations === "object" ? results.translations : {};


  const prevTr = status.translate && typeof status.translate === "object" ? status.translate : {};
  const prevByLang = prevTr.byLang && typeof prevTr.byLang === "object" ? prevTr.byLang : {};

let nextTranslations = prevTranslations || {};
for (const l of langs) nextTranslations = deleteLangKey(nextTranslations, l);

let nextByLang = prevByLang || {};
for (const l of langs) nextByLang = deleteLangKey(nextByLang, l);


  const nextItems = [...items];
  nextItems[idx] = {
    ...it,
    status: {
      ...status,
      translate: {
        ...prevTr,
        state: "queued",
        stage: "queued",
        queuedAt: nowIso(),
        error: null,
        byLang: nextByLang,
      },
    },
    results: {
      ...results,
      translations: nextTranslations,
      // keep results.translation (single) optional; up to you:
      translation: "",
      updatedAt: nowIso(),
    },
    updatedAt: nowIso(),
  };

  const nextThread = { ...t, chatItems: nextItems, updatedAt: nowIso() };
  const nextThreads = { ...cur, [tid]: nextThread };
  setThreadsById(nextThreads);
  threadsRef.current = nextThreads;

  if (String(activeRef.current) === tid) persist(nextThreads, activeRef.current, syncRef.current).catch(() => {});
};

const retrySummarize = async ({ chatItemId, options } = {}) => {
  const tid = String(activeRef.current || "");
  const cid = String(chatItemId || "");
  if (!tid || !cid) return;

  const normalized = normalizeRunOptions({ ...(options || {}), doSummarize: true });
  normalized.force = true;
  normalized.doSummarize = true;

  // ensure summarize block exists + enabled
  normalized.summarize = normalized.summarize || {};
  normalized.summarize.enabled = true;
  normalized.summarize.targetLang = normalized.summarize.targetLang || "auto";

  // support either clearSummary or clearSummarize flags
  const clearSummary = !!(normalized.clearSummary || normalized.clearSummarize);

  try {
    reserveForSummarizeChatItems(tid, [cid], normalized, { force: true, clearSummary });

    // ✅ Use the SAME transport pattern you already use for retryTranscribe/retryTranslate.
    // If your existing code has a helper, call that instead.
    if (wsClientRef.current && wsClientRef.current.isConnected()) {
      wsClientRef.current.send("RETRY_SUMMARIZE", { threadId: tid, chatItemId: cid, options: normalized });
    } else {
      const jwt = await getJwtIfAny();
      await postJson("/api/threads/retry_summarize", jwt, { threadId: tid, chatItemId: cid, options: normalized });
    }

    refreshTokensThrottled().catch(() => {});
  } catch (err) {
    // release optimistic reserve on immediate failure
    releaseForSummarizeChatItem(tid, cid);

    const msg = err?.message || "Failed to summarize";
    toast.error(msg);
  }
};


const retryTranslate = async ({ chatItemIds, chatItemId, options } = {}) => {
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

  const normalized = normalizeRunOptions(options);
  const wantClearTranslate = !!normalized?.clearTranslate;
const runLangs =
  normalized?.translation?.targetLangs && Array.isArray(normalized.translation.targetLangs)
    ? normalized.translation.targetLangs
    : [];


  // If clearing, clear local live buffers & thread fields for those target langs
  if (wantClearTranslate) {
    const targetLangs =
      normalized?.translation?.targetLangs && Array.isArray(normalized.translation.targetLangs)
        ? normalized.translation.targetLangs
        : [];

    for (const cid of ids) {
      if (wantClearTranslate) {
        patchLiveChatItem(tid, cid, {
          stream: { translate: {} },
          progress: { translate: {} },
          segments: { translate: {} },
          updatedAt: nowIso(),
        });
        clearTranslateFieldsOnThread(tid, cid, runLangs);
      } else {
        // ✅ re-run only requested langs: reset live buffers for those langs only
        clearLiveTranslateLangs(tid, cid, runLangs);
      }
    }

  }

  const payload = {
    threadId: String(tid),
    chatItemIds: ids,
    options: normalized,
  };

  // ✅ optimistic reserve immediately (shows in badge blue pending)
  // reserve only langs that would actually queue (unless force)
  reserveForTranslateChatItems(tid, ids, normalized, {
    force: !!normalized?.force,
    clearTranslate: wantClearTranslate,
  });

  const ok = wsClientRef.current.send("RETRY_TRANSLATE", payload);
  if (!ok) toast.error("Failed to send RETRY_TRANSLATE");
  return ok;
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
      options: normalizeRunOptions(options),
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

    // ✅ optimistic reserve immediately
    reserveForChatItems(tid, ids);

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

    // ✅ optimistic reserve by itemId (draft files). Will transfer on CHAT_ITEMS_CREATED.
    reserveForDraftItemIds(tid, ids);

    const payload = {
      threadId: String(tid),
      itemIds: ids,
      options: normalizeRunOptions(options),
    };

    const ok = wsClientRef.current.send("START_RUN", payload);
    if (!ok) toast.error("Failed to send START_RUN");
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

    creatingThread,
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
    retryTranslate,
    retrySummarize,
    requestThreadSnapshot,
    requestMediaUrl,

    saveSrt,
    saveTranslationSrt, // ✅ add this
  };

  return <ThreadsContext.Provider value={value}>{children}</ThreadsContext.Provider>;
}

export function useThreads() {
  const ctx = useContext(ThreadsContext);
  if (!ctx) throw new Error("useThreads must be used inside <ThreadsProvider />");
  return ctx;
}
