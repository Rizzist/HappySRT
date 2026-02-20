// components/ThreadComposer.js
import { useEffect, useMemo, useRef, useState } from "react";
import styled from "styled-components";
import { toast } from "sonner";
import { useThreads } from "../contexts/threadsContext";
import { useAuth } from "../contexts/AuthContext";
import { getLocalMedia } from "../lib/mediaStore";

import { makeScope } from "@/lib/scopeKey";

import * as CatalogImport from "../shared/transcriptionCatalog";
import * as BillingImport from "../shared/billingCatalog";
import * as TranslationImport from "../shared/translationCatalog";
import * as TrBillingImport from "../shared/translationBillingCatalog";
import * as SummarizationImport from "../shared/summarizationCatalog";
import * as SumBillingImport from "../shared/summarizationBillingCatalog";

const TrBilling = (TrBillingImport && (TrBillingImport.default || TrBillingImport)) || {};
const {
  EST_DEFAULTS: TRB_DEFAULTS,
  estimateUsdCentsFromBillableTokens,
  estimateMediaTokensFromUsdCents,
  formatUsdFromCents,

  // ✅ NEW: duration fallback token estimator
  estimateTranslationLlmTokensWithDurationFallback,
} = TrBilling;


const TranslationCatalog =
  (TranslationImport && (TranslationImport.default || TranslationImport)) || {};

const {
  DEFAULTS: TR_DEFAULTS,
  getModels: getTrModels,
  getSourceLanguages,
  getTargetLanguages,
} = TranslationCatalog;

const SummarizationCatalog =
  (SummarizationImport && (SummarizationImport.default || SummarizationImport)) || {};

const {
  DEFAULTS: SUM_DEFAULTS,
  getModels: getSumModels,
  getModelById: getSumModelById,
} = SummarizationCatalog;


const Billing = (BillingImport && (BillingImport.default || BillingImport)) || {};
const { estimateTokensForRun, tokensToUsd, PRICING_VERSION } = Billing;

const Catalog = (CatalogImport && (CatalogImport.default || CatalogImport)) || {};
const { LANGUAGES, getModelsForLanguage, getModelById } = Catalog;

const SumBilling = (SumBillingImport && (SumBillingImport.default || SumBillingImport)) || {};


function ensureDraftShape(d) {
  const out = d && typeof d === "object" ? { ...d } : {};
  if (!Array.isArray(out.files)) out.files = [];
  return out;
}

function isAudioOrVideo(file) {
  const t = String(file?.type || "");
  return t.startsWith("audio/") || t.startsWith("video/");
}

function isReadyDraftFile(f) {
  const stage = String(f?.stage || "");
  return stage === "uploaded" || stage === "linked";
}

function isBusyDraftFile(f) {
  const stage = String(f?.stage || "");
  return stage === "uploading" || stage === "converting" || stage === "linking" || stage === "downloading";
}


function safeArr(x) {
  return Array.isArray(x) ? x : [];
}

function durationSecondsFromDraftFile(f) {
  const n =
    f?.local?.durationSeconds ??
    f?.urlMeta?.durationSeconds ??
    f?.audio?.durationSeconds ??
    f?.durationSeconds;

  const x = Number(n);
  return Number.isFinite(x) && x > 0 ? x : null;
}

function safeFiniteSeconds(n) {
  const x = Number(n);
  return Number.isFinite(x) && x > 0 && x !== Infinity ? x : null;
}

// Browser-only metadata probe from a media URL (objectURL or remote URL)
function probeDurationSecondsFromSrc({ src, kind }) {
  if (typeof window === "undefined") return Promise.resolve(null);

  const tag = kind === "video" ? "video" : "audio";
  const el = document.createElement(tag);

  // keep it light + metadata-only
  el.preload = "metadata";
  el.muted = true;
  el.playsInline = true;

  return new Promise((resolve) => {
    let done = false;

    const cleanup = () => {
      try {
        el.removeAttribute("src");
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

    // slightly longer than your 6s in threadsContext; remote links can be slower
    const timer = setTimeout(() => finish(null), 8000);

    el.onloadedmetadata = () => {
      clearTimeout(timer);
      const d = safeFiniteSeconds(el.duration);
      if (!d) return finish(null);

      // IMPORTANT:
      // - do NOT toFixed() here; server uses ffprobe float then billing does Math.ceil()
      // - keep raw-ish float to avoid rounding down around integer boundaries
      finish(d);
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

function isProbablyVideoDraftFile(f) {
  return (
    Boolean(f?.local?.isVideo) ||
    String(f?.local?.mime || "").startsWith("video/") ||
    String(f?.audio?.mime || "").startsWith("video/") ||
    String(f?.mime || "").startsWith("video/")
  );
}


function formatCompact(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  if (x >= 1000000) return `${(x / 1000000).toFixed(x >= 10000000 ? 0 : 1)}m`;
  if (x >= 10000) return `${Math.round(x / 1000)}k`;
  if (x >= 1000) return `${(x / 1000).toFixed(1)}k`;
  return String(Math.round(x));
}

function safeStr(x) {
  return String(x == null ? "" : x);
}

function uniq(arr) {
  return Array.from(new Set((arr || []).map((x) => String(x || "")).filter(Boolean)));
}

function hasConfirmedStart(thread, pendingItemIds) {
  const want = new Set((pendingItemIds || []).map((x) => String(x || "")).filter(Boolean));
  if (!want.size) return false;

  // Prefer confirming via chatItems (strong signal)
  const chatItems = Array.isArray(thread?.chatItems) ? thread.chatItems : [];
  for (const it of chatItems) {
    const iid = String(it?.itemId || "");
    if (iid && want.has(iid)) return true;
  }

  // Fallback: if item disappeared from draft (weaker signal)
  const draftFiles = Array.isArray(thread?.draft?.files) ? thread.draft.files : [];
  const draftIds = new Set(draftFiles.map((f) => String(f?.itemId || "")).filter(Boolean));
  for (const iid of want) {
    if (!draftIds.has(iid)) return true;
  }

  return false;
}

function MultiLangSelect({ value, options, onChange, placeholder }) {
  const wrapRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");

  const vals = Array.isArray(value) ? value : [];
  const opts = Array.isArray(options) ? options : [];

  const labelByValue = useMemo(() => {
    const m = new Map();
    for (const o of opts) m.set(String(o?.value), String(o?.label || o?.value));
    return m;
  }, [opts]);

  const selectedLabels = useMemo(() => {
    return vals.map((v) => labelByValue.get(String(v)) || String(v));
  }, [vals, labelByValue]);

  const summary = useMemo(() => {
    if (!selectedLabels.length) return placeholder || "Select…";
    if (selectedLabels.length === 1) return selectedLabels[0];
    return `${selectedLabels[0]} +${selectedLabels.length - 1}`;
  }, [selectedLabels, placeholder]);

  const filtered = useMemo(() => {
    const needle = String(q || "").trim().toLowerCase();
    if (!needle) return opts;
    return opts.filter((o) => {
      const v = String(o?.value || "").toLowerCase();
      const l = String(o?.label || "").toLowerCase();
      return v.includes(needle) || l.includes(needle);
    });
  }, [opts, q]);

  const allValues = useMemo(() => {
    return opts.map((o) => String(o?.value || "")).filter(Boolean);
  }, [opts]);

  const selectedSet = useMemo(() => new Set(vals.map(String)), [vals]);

  const allSelected = useMemo(() => {
    if (!allValues.length) return false;
    for (const v of allValues) if (!selectedSet.has(v)) return false;
    return true;
  }, [allValues, selectedSet]);

  const toggle = (lang) => {
    const v = String(lang || "");
    if (!v) return;

    const set = new Set(vals.map(String));
    if (set.has(v)) set.delete(v);
    else set.add(v);

    onChange && onChange(Array.from(set));
  };

  const clearAll = () => {
    onChange && onChange([]);
  };

  const selectAll = () => {
    onChange && onChange(allValues.slice());
  };

  const selectFiltered = () => {
    const filteredValues = filtered.map((o) => String(o?.value || "")).filter(Boolean);
    if (!filteredValues.length) return;

    const set = new Set(vals.map(String));
    for (const v of filteredValues) set.add(v);
    onChange && onChange(Array.from(set));
  };

  useEffect(() => {
    if (!open) return;

    const onDown = (e) => {
      const t = e?.target;
      if (!t) return;
      const w = wrapRef.current;
      if (w && w.contains(t)) return;
      setOpen(false);
    };

    const onKey = (e) => {
      if (String(e?.key || "") === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <MultiWrap ref={wrapRef} $open={open}>
      <MultiBtn
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={selectedLabels.join(", ") || ""}
        aria-expanded={open}
      >
        <MultiBtnText>{summary}</MultiBtnText>
        <MultiCaret $open={open}>▾</MultiCaret>
      </MultiBtn>

      {/* ✅ Preview targets */}
      {selectedLabels.length ? (
        <MultiPreview title={selectedLabels.join(", ")}>
          {selectedLabels.slice(0, 6).map((lbl, i) => (
            <MultiChip key={`${lbl}|${i}`}>{lbl}</MultiChip>
          ))}
          {selectedLabels.length > 6 ? <MultiMore>+{selectedLabels.length - 6}</MultiMore> : null}
        </MultiPreview>
      ) : (
        <MultiPreviewMuted>None selected</MultiPreviewMuted>
      )}

      {open ? (
        <MultiMenu role="listbox" aria-label="Target languages">
          <MultiSearch
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search languages…"
            autoFocus
          />

          <MultiTopbar>
            <MultiCount>
              Selected <b>{vals.length}</b> / {allValues.length || opts.length || 0}
            </MultiCount>
            <MultiTopActions>
              <MultiLink type="button" onClick={selectFiltered} title="Add all currently filtered languages">
                Select filtered
              </MultiLink>
              <MultiLink type="button" onClick={selectAll} title="Select all available languages">
                {allSelected ? "All selected" : "Select all"}
              </MultiLink>
            </MultiTopActions>
          </MultiTopbar>

          <MultiList>
            {filtered.map((o) => {
              const v = String(o?.value || "");
              const lbl = String(o?.label || o?.value || "");
              const checked = selectedSet.has(v);

              return (
                <MultiItem key={v} type="button" onClick={() => toggle(v)} $on={checked}>
                  <MultiCheck $on={checked}>{checked ? "✓" : ""}</MultiCheck>
                  <span>{lbl}</span>
                </MultiItem>
              );
            })}
          </MultiList>

          <MultiFooter>
            <MultiFooterLeft>
              <MultiLink type="button" onClick={clearAll}>
                Clear
              </MultiLink>
            </MultiFooterLeft>

            <MultiFooterRight>
              <MultiLink type="button" onClick={() => setOpen(false)}>
                Done
              </MultiLink>
            </MultiFooterRight>
          </MultiFooter>
        </MultiMenu>
      ) : null}
    </MultiWrap>
  );
}



export default function ThreadComposer({ thread }) {
  const {
    addDraftMediaFromFile,
    addDraftMediaFromUrl,
    deleteDraftMedia,
    startRun,
    wsStatus,
    wsError,
    requestThreadSnapshot,
  } = useThreads();

  const { user, isAnonymous, mediaTokens } = useAuth();

  const [url, setUrl] = useState("");
const [durationsByItemId, setDurationsByItemId] = useState({});
  const [doTranscribe, setDoTranscribe] = useState(true);
  const [doTranslate, setDoTranslate] = useState(false);
  const [doSummarize, setDoSummarize] = useState(false);

  const [asrLang, setAsrLang] = useState("auto");
  const [asrModel, setAsrModel] = useState("deepgram_nova3");

const [trSourceLang, setTrSourceLang] = useState(TR_DEFAULTS?.sourceLang || "auto");

const [trTargetLangs, setTrTargetLangs] = useState(() => {
  const defaults = Array.isArray(TR_DEFAULTS?.targetLangs) ? TR_DEFAULTS.targetLangs : [];
  return uniq((defaults.length ? defaults : ["en"]).filter(Boolean));
});

const [trModelId, setTrModelId] = useState(TR_DEFAULTS?.modelId || "gpt-4o-mini");


const [sumModelId, setSumModelId] = useState(() => String(SUM_DEFAULTS?.modelId || "gpt-4o-mini"));
const [sumTargetLang, setSumTargetLang] = useState(() =>
  String(SUM_DEFAULTS?.targetLang || "English")
);


  const draft = ensureDraftShape(thread?.draft);
  const files = draft.files || [];

  const [objectUrls, setObjectUrls] = useState({});
  const [playingId, setPlayingId] = useState(null);
  const mediaRefs = useRef({});

  const objectUrlsRef = useRef({});
  const objectUrlMetaRef = useRef({}); // itemId -> clientFileId

  const filesPreviewKey = useMemo(() => {
    return (files || [])
      .map((f) => {
        const itemId = String(f?.itemId || "");
        const clientFileId = String(f?.clientFileId || "");
        const hasLocal = f?.local ? "1" : "0";
        const url = f?.sourceType === "url" ? String(f?.url || "") : "";
        return `${itemId}:${clientFileId}:${hasLocal}:${url}`;
      })
      .join("|");
  }, [files]);

  const asrModelOptions = useMemo(() => {
    if (typeof getModelsForLanguage !== "function") return [];
    return safeArr(getModelsForLanguage(asrLang));
  }, [asrLang]);

    const [startPending, setStartPending] = useState(null);
  // shape: { toastId, itemIds, startedAt }

  const startPendingRef = useRef(null);
  useEffect(() => {
    startPendingRef.current = startPending;
  }, [startPending]);


  useEffect(() => {
    if (!asrModelOptions.length) return;
    const ok = asrModelOptions.some((m) => String(m?.id || "") === String(asrModel || ""));
    if (!ok) setAsrModel(String(asrModelOptions[0]?.id || "deepgram_nova3"));
  }, [asrLang, asrModelOptions, asrModel]);

  useEffect(() => {
    if (!LANGUAGES || !Array.isArray(LANGUAGES) || typeof getModelsForLanguage !== "function") {
      console.warn("[ThreadComposer] transcriptionCatalog import looks wrong", { Catalog });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

    const scope = useMemo(() => makeScope(user, isAnonymous), [user?.$id, isAnonymous]);
    


  useEffect(() => {
    for (const [id, el] of Object.entries(mediaRefs.current || {})) {
      if (!el) continue;
      if (playingId && String(id) === String(playingId)) continue;
      try {
        if (!el.paused) el.pause();
      } catch {}
    }
  }, [playingId]);

  useEffect(() => {
    if (!playingId) return;
    const stillThere = (files || []).some((f) => String(f?.itemId) === String(playingId));
    if (!stillThere) setPlayingId(null);
  }, [files, playingId]);

  const readyFiles = useMemo(() => {
    return (files || []).filter((f) => f?.itemId && isReadyDraftFile(f));
  }, [files]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!thread?.id) return;

      const nextMap = { ...(objectUrlsRef.current || {}) };
      const nextMeta = { ...(objectUrlMetaRef.current || {}) };

      const want = new Set();

      for (const f of files || []) {
        const itemId = String(f?.itemId || "");
        const clientFileId = String(f?.clientFileId || "");
        const local = f?.local;

        if (!itemId || !clientFileId || !local) continue;

        want.add(itemId);

        // keep stable URL while progress updates come in
        if (nextMap[itemId] && nextMeta[itemId] === clientFileId) continue;

        try {
          const blob = await getLocalMedia(scope, thread.id, clientFileId);
          if (!blob) continue;

          if (nextMap[itemId]) {
            try { URL.revokeObjectURL(nextMap[itemId]); } catch {}
          }

          nextMap[itemId] = URL.createObjectURL(blob);
          nextMeta[itemId] = clientFileId;
        } catch {}
      }

      // cleanup removed items
      for (const itemId of Object.keys(nextMap)) {
        if (want.has(itemId)) continue;
        try { URL.revokeObjectURL(nextMap[itemId]); } catch {}
        delete nextMap[itemId];
        delete nextMeta[itemId];
      }

      if (cancelled) return;

      objectUrlsRef.current = nextMap;
      objectUrlMetaRef.current = nextMeta;
      setObjectUrls(nextMap);
    })();

    return () => {
      cancelled = true;
    };
  }, [thread?.id, scope, filesPreviewKey]);



  const busyUploading = useMemo(() => {
    return (files || []).some((f) => isBusyDraftFile(f));
  }, [files]);

  const hasAnyOption = useMemo(() => {
    return Boolean(doTranscribe || doTranslate || doSummarize);
  }, [doTranscribe, doTranslate, doSummarize]);

  const threadIsValid = Boolean(thread?.id && thread.id !== "default");
  const wsIsReady = String(wsStatus || "") === "ready";
  const hasReadyMedia = readyFiles.length > 0;

   const billingEstimate = useMemo(() => {
    if (!doTranscribe) return { ok: true, tokens: 0, unknown: 0 };

    if (typeof estimateTokensForRun !== "function") {
      return { ok: false, tokens: null, unknown: readyFiles.length };
    }

    const items = [];
    let unknown = 0;

    for (const f of readyFiles) {
      const itemId = String(f?.itemId || "");
      const d1 = durationSecondsFromDraftFile(f);
      const d2 = itemId ? safeFiniteSeconds(durationsByItemId[itemId]) : null;

      const sec = d1 != null ? d1 : d2;
      if (sec == null) {
        unknown += 1;
        continue;
      }

      items.push({ durationSeconds: sec });
    }

    if (unknown) return { ok: false, tokens: null, unknown };

    // Be explicit with opts to avoid any “defaults drift”
    const opts =
      Billing && typeof Billing.getPublicPricingManifest === "function"
        ? {
            quantumSeconds: Billing.BILLING_QUANTUM_SECONDS,
            minBillableSeconds: Billing.MIN_BILLABLE_SECONDS,
            tokensOverheadPerItem: Billing.TOKENS_OVERHEAD_PER_ITEM,
            tokensOverheadPerRun: Billing.TOKENS_OVERHEAD_PER_RUN,
          }
        : null;

    const tokens = estimateTokensForRun(items, asrModel, opts);
    return { ok: true, tokens: Number(tokens || 0) || 0, unknown: 0 };
  }, [doTranscribe, readyFiles, asrModel, durationsByItemId]);


const translationEstimate = useMemo(() => {
  if (!doTranslate) {
    return { ok: true, mediaTokens: 0, usdCents: 0, unknown: 0 };
  }

  const targets = uniq(trTargetLangs);
  if (!targets.length) return { ok: true, mediaTokens: 0, usdCents: 0, unknown: 0 };

  // Need estimator
  if (typeof TrBilling?.estimateTranslationRunFromDurationSeconds !== "function") {
    return { ok: false, mediaTokens: null, usdCents: null, unknown: readyFiles.length };
  }

  let unknown = 0;
  let mediaTokensTotal = 0;
  let usdCentsTotal = 0;

  for (const f of readyFiles) {
    const itemId = String(f?.itemId || "");
    const d1 = durationSecondsFromDraftFile(f);
    const d2 = itemId ? safeFiniteSeconds(durationsByItemId?.[itemId]) : null;
    const sec = d1 != null ? d1 : d2;

    if (sec == null) {
      unknown += 1;
      continue;
    }

    const run = TrBilling.estimateTranslationRunFromDurationSeconds(sec, targets, null);
    mediaTokensTotal += Math.max(0, Number(run?.mediaTokens || 0) || 0);
    usdCentsTotal += Math.max(0, Number(run?.usdCents || 0) || 0);
  }

  if (unknown) {
    return { ok: false, mediaTokens: null, usdCents: null, unknown };
  }

  return {
    ok: true,
    unknown: 0,
    mediaTokens: mediaTokensTotal,
    usdCents: usdCentsTotal,
  };
}, [doTranslate, readyFiles, trTargetLangs, durationsByItemId]);


// ✅ Summarization estimate (shared deterministic; duration fallback)
const summarizationEstimate = useMemo(() => {
  if (!doSummarize) {
    return { ok: true, mediaTokens: 0, usdCents: 0, unknown: 0 };
  }

  if (typeof SumBilling?.estimateSummarizationRunFromDurationSeconds !== "function") {
    return { ok: false, mediaTokens: null, usdCents: null, unknown: readyFiles.length };
  }

  let unknown = 0;
  let mediaTokensTotal = 0;
  let usdCentsTotal = 0;

  for (const f of readyFiles) {
    const itemId = String(f?.itemId || "");
    const d1 = durationSecondsFromDraftFile(f);
    const d2 = itemId ? safeFiniteSeconds(durationsByItemId?.[itemId]) : null;
    const sec = d1 != null ? d1 : d2;

    if (sec == null) {
      unknown += 1;
      continue;
    }

    const run = SumBilling.estimateSummarizationRunFromDurationSeconds(sec, null);
    mediaTokensTotal += Math.max(0, Number(run?.mediaTokens || 0) || 0);
    usdCentsTotal += Math.max(0, Number(run?.usdCents || 0) || 0);
  }

  if (unknown) {
    return { ok: false, mediaTokens: null, usdCents: null, unknown };
  }

  return {
    ok: true,
    unknown: 0,
    mediaTokens: mediaTokensTotal,
    usdCents: usdCentsTotal,
  };
}, [doSummarize, readyFiles, durationsByItemId]);



const transcribeMini = useMemo(() => {
  if (!doTranscribe || !hasReadyMedia) return { show: false };
  if (!billingEstimate?.ok) return { show: true, state: "unknown", text: "—", title: "Missing duration — can’t estimate." };

  const need = Number(billingEstimate.tokens || 0) || 0;
  const title = `Est. transcription: ${need} tokens`;
  return { show: true, state: "ok", text: formatCompact(need), title };
}, [doTranscribe, hasReadyMedia, billingEstimate]);

const translateMini = useMemo(() => {
  if (!doTranslate || !hasReadyMedia) return { show: false };
  if (!translationEstimate?.ok) {
    const title =
      translationEstimate?.unknown
        ? `Missing duration on ${translationEstimate.unknown} file(s) — can’t estimate translation.`
        : "Can’t estimate translation.";
    return { show: true, state: "unknown", text: "—", title };
  }

  const need = Number(translationEstimate.mediaTokens || 0) || 0;
  const usd = Number(translationEstimate.usdCents || 0) || 0;
  const title = [
    `Est. translation: ${need} media tokens`,
    typeof formatUsdFromCents === "function" ? `(~${formatUsdFromCents(usd)})` : null,
    `Targets: ${uniq(trTargetLangs).length}`,
  ]
    .filter(Boolean)
    .join(" • ");

  return { show: true, state: "ok", text: formatCompact(need), title };
}, [doTranslate, hasReadyMedia, translationEstimate, trTargetLangs, formatUsdFromCents]);

const summarizeMini = useMemo(() => {
  if (!doSummarize || !hasReadyMedia) return { show: false };
 if (!summarizationEstimate?.ok) {
    const title =
      summarizationEstimate?.unknown
        ? `Missing duration on ${summarizationEstimate.unknown} file(s) — can’t estimate summarization.`
        : "Can’t estimate summarization.";
    return { show: true, state: "unknown", text: "—", title };
  }

  const need = Number(summarizationEstimate.mediaTokens || 0) || 0;
  const usd = Number(summarizationEstimate.usdCents || 0) || 0;
  const title = [
    `Est. summarization: ${need} media tokens`,
    typeof formatUsdFromCents === "function" ? `(~${formatUsdFromCents(usd)})` : null,
    sumTargetLang ? `Target: ${String(sumTargetLang)}` : null,
  ]
    .filter(Boolean)
    .join(" • ");

  return { show: true, state: "ok", text: formatCompact(need), title };
}, [doSummarize, hasReadyMedia, summarizationEstimate, sumTargetLang, formatUsdFromCents]);


  const availableTokens = Number(mediaTokens || 0) || 0;
  // ✅ Gate on total estimated media tokens across selected steps (only when all selected estimates are known)
  const totalNeed = useMemo(() => {
    let sum = 0;
    if (doTranscribe) {
      if (!billingEstimate?.ok) return null;
      sum += Number(billingEstimate.tokens || 0) || 0;
    }
    if (doTranslate) {
      if (!translationEstimate?.ok) return null;
      sum += Number(translationEstimate.mediaTokens || 0) || 0;
    }
    if (doSummarize) {
      if (!summarizationEstimate?.ok) return null;
      sum += Number(summarizationEstimate.mediaTokens || 0) || 0;
    }
    return sum;
  }, [doTranscribe, doTranslate, doSummarize, billingEstimate, translationEstimate, summarizationEstimate]);

  const overLimit = totalNeed != null && totalNeed > availableTokens;

  // Minimal badge shown next to "Summarization" pill (right after it)
 const totalBadge = useMemo(() => {
  // show when we have anything to estimate and any ready media
  if (!hasReadyMedia) return { show: false };

  const parts = [];

  // transcription
  let trOk = true;
  let trNeed = 0;
  if (doTranscribe) {
    if (!billingEstimate?.ok) trOk = false;
    else trNeed = Number(billingEstimate.tokens || 0) || 0;
    parts.push({ label: "Transcription", ok: billingEstimate?.ok, need: trNeed });
  }

  // translation
  let tlOk = true;
  let tlNeed = 0;
  if (doTranslate) {
    if (!translationEstimate?.ok) tlOk = false;
    else tlNeed = Number(translationEstimate.mediaTokens || 0) || 0;
    parts.push({ label: "Translation", ok: translationEstimate?.ok, need: tlNeed });
  }

  // summarization
  let suOk = true;
  let suNeed = 0;
  if (doSummarize) {
    if (!summarizationEstimate?.ok) suOk = false;
    else suNeed = Number(summarizationEstimate.mediaTokens || 0) || 0;
    parts.push({ label: "Summarization", ok: summarizationEstimate?.ok, need: suNeed });
  }

  // If neither is on, hide.
  if (!parts.length) return { show: false };

  const ok = trOk && tlOk && suOk;
  if (!ok) {
    const unknownCount =
      (doTranscribe && !billingEstimate?.ok ? (Number(billingEstimate?.unknown || 0) || 1) : 0) +
      (doTranslate && !translationEstimate?.ok ? (Number(translationEstimate?.unknown || 0) || 1) : 0) +
      (doSummarize && !summarizationEstimate?.ok ? (Number(summarizationEstimate?.unknown || 0) || 1) : 0);

    return {
      show: true,
      ok: false,
      totalNeed: null,
      state: "unknown",
      text: "—",
      title: unknownCount ? `Missing duration on ${unknownCount} file(s) — can’t estimate total.` : "Can’t estimate total.",
    };
  }


  const need = parts.reduce((a, p) => a + (Number(p?.need || 0) || 0), 0);
  const title = parts
    .map((p) => `${p.label}: ${Number(p.need || 0) || 0}`)
    .join(" • ");

     return {
     show: true,
    ok: true,
    totalNeed: need,
     state: "ok",
     text: formatCompact(need),
     title: `Total est.: ${need} media tokens • ${title}`,
   };

 }, [
   hasReadyMedia,
   doTranscribe,
   doTranslate,
  doSummarize,
   billingEstimate,
   translationEstimate,
  summarizationEstimate,
 ]);

  const startUi = useMemo(() => {
    if (!threadIsValid) return { disabled: true, text: "Select", title: "Select a thread to begin" };
    if (!hasAnyOption) return { disabled: true, text: "Options", title: "Choose transcription / translation / summarization" };
    if (busyUploading) return { disabled: true, text: "Uploading…", title: "Finish uploading/converting first" };
    if (!hasReadyMedia) return { disabled: true, text: "Add media", title: "Upload/link at least one media file first" };

  if (doTranscribe || doTranslate || doSummarize) {
    if (totalNeed == null) {
      return {
       disabled: true,
        text: "Duration",
        title: totalBadge?.title || "Cannot estimate total cost (missing duration).",
      };
    }
    if (totalNeed > availableTokens) {
      return {
        disabled: true,
        text: "No tokens",
        title: totalBadge?.title || `Need ${totalNeed} tokens, have ${availableTokens}.`,
      };
    }
  }


    if (!wsIsReady) {
      const st = String(wsStatus || "");
      const label =
        st === "connecting" || st === "socket_open"
          ? "Connecting…"
          : st === "error"
          ? "WS error"
          : "Connecting…";
      return { disabled: true, text: label, title: "Connecting to realtime server (auth/HELLO)…" };
    }

    return { disabled: false, text: "Start", title: "Start processing" };
  }, [
   threadIsValid,
   hasAnyOption,
   busyUploading,
   hasReadyMedia,
   wsIsReady,
   wsStatus,
   doTranscribe,
  doTranslate,
  doSummarize,
   billingEstimate,
  totalNeed,
  totalBadge,
   availableTokens,
  ]);

    // Confirm "started" once items show up in chatItems (or disappear from draft)
useEffect(() => {
  if (!startPending) return;

  const confirmed = hasConfirmedStart(thread, startPending.itemIds);
  if (confirmed) {
    toast.success("Started ✅", { id: startPending.toastId });

    // ✅ NEW: turn off the option pills after a successful start
    setDoTranscribe(false);
    setDoTranslate(false);
    setDoSummarize(false);

    setStartPending(null);
    return;
  }

  // Timeout: don’t lock the UI forever
  const elapsed = Date.now() - Number(startPending.startedAt || 0);
  if (elapsed > 12000) {
    toast.error("Still waiting for the server… try Start again.", { id: startPending.toastId });
    setStartPending(null);
  }
}, [thread?.draft?.files, thread?.chatItems, startPending, thread]);


  // If WS errors while pending, fail fast
  useEffect(() => {
    if (!startPending) return;

    const st = String(wsStatus || "");
    const msg = wsError?.message ? String(wsError.message) : "";

    if (st === "error" || msg) {
      toast.error(msg || "WebSocket error while starting.", { id: startPending.toastId });
      setStartPending(null);
    }
  }, [wsStatus, wsError, startPending]);


  const onChooseFiles = async (e) => {
    const picked = Array.from(e.target.files || []);
    e.target.value = "";
    if (!thread?.id || picked.length === 0) return;

    const allowed = picked.filter(isAudioOrVideo);
    const rejected = picked.filter((f) => !isAudioOrVideo(f));

    if (rejected.length) toast.error("Only audio/video files are allowed.");

    for (const f of allowed) {
      await addDraftMediaFromFile(thread.id, f);
    }
  };

  const onAddUrl = async () => {
    const clean = String(url || "").trim();
    if (!clean || !thread?.id) return;
    await addDraftMediaFromUrl(thread.id, clean);
    setUrl("");
  };

  const playInline = async ({ itemId, previewUrl }) => {
    if (!previewUrl || !itemId) return;

    setPlayingId(itemId);

    setTimeout(() => {
      const el = mediaRefs.current[itemId];
      if (!el) return;

      try {
        if (!el.paused) {
          el.pause();
          return;
        }
        const p = el.play();
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch {}
    }, 0);
  };

    const onStart = async () => {
    // Prevent double-click spam
    if (startPendingRef.current) {
      toast.message("Already starting…", { id: startPendingRef.current.toastId });
      return;
    }

    if (startUi.disabled) {
      if (startUi.title) toast.error(startUi.title);
      return;
    }

    if (wsError?.message) {
      toast.error(wsError.message);
      return;
    }

    const first = readyFiles[0] || null;
    if (!first?.itemId) {
      toast.error("No ready media found. Upload/link media first.");
      return;
    }

    if (!wsIsReady) {
      toast.error("Realtime server not ready yet (auth/HELLO).");
      return;
    }

    const selectedModel = typeof getModelById === "function" ? getModelById(asrModel) : null;

const options = {
  doTranscribe,
  asrLang,
  asrModel,
  asrProvider: selectedModel?.provider || null,
  asrModelName: selectedModel?.model || null,

  doTranslate,
  doSummarize,
};

if (doSummarize) {
  const modelObj =
    typeof getSumModelById === "function" ? getSumModelById(sumModelId) : null;

  const modelId = String(modelObj?.id || SUM_DEFAULTS?.modelId || sumModelId || "gpt-4o-mini").trim();
  const targetLang = String(sumTargetLang || SUM_DEFAULTS?.targetLang || "English").trim();

  options.summarization = {
    enabled: true,
    provider: modelObj?.provider || "openai",
    modelId,
    targetLang,
  };

  // optional convenience/back-compat
  options.sumTargetLang = targetLang;
  options.sumModelId = modelId;
}


if (doTranslate) {
  const modelObj = typeof TranslationCatalog?.getModelById === "function"
    ? TranslationCatalog.getModelById(trModelId)
    : null;

  const fallbackTargets =
    (Array.isArray(TR_DEFAULTS?.targetLangs) && TR_DEFAULTS.targetLangs.length ? TR_DEFAULTS.targetLangs : ["en"]);

  const targets = uniq(
    (Array.isArray(trTargetLangs) && trTargetLangs.length ? trTargetLangs : fallbackTargets)
      .map((x) => String(x || "").trim())
      .filter(Boolean)
  );

  options.translation = {
    enabled: true,
    provider: modelObj?.provider || "openai",
    modelId: String(modelObj?.id || TR_DEFAULTS?.modelId || "gpt-4o-mini"),
    sourceLang: String(trSourceLang || TR_DEFAULTS?.sourceLang || "auto"),
    targetLangs: targets, // ✅ always array, never singular
  };
}





    const readyIds = uniq(readyFiles.map((x) => String(x?.itemId || "")).filter(Boolean));

    if (!readyIds.length) {
      toast.error("No ready media found.");
      return;
    }

    if (doTranscribe && billingEstimate?.ok && billingEstimate.tokens > 0) {
      options.billing = {
        pricingVersion: PRICING_VERSION || null,
        expectedTokens: billingEstimate.tokens,
      };
    }

    const toastId = `start:${thread?.id}:${Date.now()}`;

    // Immediate UI feedback
    toast.loading("Starting…", { id: toastId });
    setStartPending({ toastId, itemIds: readyIds, startedAt: Date.now() });

    try {
      const ok = await startRun({ itemIds: readyIds, options });

      if (!ok) {
        toast.error("Failed to send Start (not connected).", { id: toastId });
        setStartPending(null);
        return;
      }

      // We sent it — keep toast in loading until confirmation effect flips it to success
      toast.loading("Start sent… waiting for server", { id: toastId });

      // Best effort: ask for a snapshot soon (helps UI update faster)
      setTimeout(() => {
        try {
          requestThreadSnapshot && requestThreadSnapshot();
        } catch {}
      }, 450);
    } catch (e) {
      toast.error(e?.message || "Start failed", { id: toastId });
      setStartPending(null);
    }
  };


const trModelOptions = useMemo(() => {
  return typeof getTrModels === "function" ? safeArr(getTrModels()) : [];
}, []);

const trSourceLangOptions = useMemo(() => {
  return typeof getSourceLanguages === "function" ? safeArr(getSourceLanguages()) : [];
}, []);

const trTargetLangOptions = useMemo(() => {
  return typeof getTargetLanguages === "function" ? safeArr(getTargetLanguages()) : [];
}, []);

// ✅ Summarization models come from summarizationCatalog
const sumModelOptions = useMemo(() => {
  return typeof getSumModels === "function" ? safeArr(getSumModels()) : [];
}, [getSumModels]);

useEffect(() => {
  if (!sumModelOptions.length) return;
  const ok = sumModelOptions.some((m) => String(m?.id || "") === String(sumModelId || ""));
  if (!ok) {
    setSumModelId(String(SUM_DEFAULTS?.modelId || sumModelOptions?.[0]?.id || "gpt-4o-mini"));
  }
}, [sumModelOptions, sumModelId, SUM_DEFAULTS?.modelId]);

// ✅ Summarization target language is a *label string* (e.g. "English") per catalog DEFAULTS.
// We source the list from translation targets first, then fallback to transcription LANGUAGES.
const sumTargetLangOptions = useMemo(() => {
  // translation targets: [{value:"en", label:"English"}, ...]
  const tl = typeof getTargetLanguages === "function" ? safeArr(getTargetLanguages()) : [];
  if (tl.length) {
    // Use LABEL as the value so state matches SUM_DEFAULTS.targetLang ("English")
    return tl
      .map((o) => {
        const lbl = String(o?.label || o?.value || "").trim();
        return lbl ? { value: lbl, label: lbl } : null;
      })
      .filter(Boolean);
  }

  // fallback: transcription LANGUAGES (filter out auto)
  return safeArr(LANGUAGES)
    .filter((l) => String(l?.value || "") !== "auto")
    .map((l) => {
      const lbl = String(l?.label || l?.value || "").trim();
      return lbl ? { value: lbl, label: lbl } : null;
    })
    .filter(Boolean);
}, [getTargetLanguages, LANGUAGES]);

useEffect(() => {
  if (!sumTargetLangOptions.length) return;

  const valid = new Set(sumTargetLangOptions.map((o) => String(o?.value || "")).filter(Boolean));
  const cur = String(sumTargetLang || "").trim();
  if (cur && valid.has(cur)) return;

  const fallback = String(SUM_DEFAULTS?.targetLang || sumTargetLangOptions?.[0]?.value || "English");
  if (fallback !== cur) setSumTargetLang(fallback);
}, [sumTargetLangOptions, sumTargetLang, SUM_DEFAULTS?.targetLang]);


useEffect(() => {
  if (!trModelOptions.length) return;
  const ok = trModelOptions.some((m) => String(m?.id || "") === String(trModelId || ""));
  if (!ok) setTrModelId(String(trModelOptions[0]?.id || TR_DEFAULTS?.modelId || "gpt-4o-mini"));
}, [trModelOptions, trModelId]);

useEffect(() => {
  if (!trSourceLangOptions.length) return;
  const ok = trSourceLangOptions.some((l) => String(l?.value || "") === String(trSourceLang || ""));
  if (!ok) setTrSourceLang(String(TR_DEFAULTS?.sourceLang || "auto"));
}, [trSourceLangOptions, trSourceLang]);

useEffect(() => {
  if (!trTargetLangOptions.length) return;
  const valid = new Set(trTargetLangOptions.map((l) => String(l?.value || "")).filter(Boolean));
  const next = (trTargetLangs || []).map(String).filter((x) => valid.has(x));
  if (!next.length) next.push(String((TR_DEFAULTS?.targetLangs && TR_DEFAULTS.targetLangs[0]) || "en"));
  if (next.join("|") !== (trTargetLangs || []).map(String).join("|")) setTrTargetLangs(uniq(next));
}, [trTargetLangOptions, trTargetLangs]);


  return (
    <Dock>
      <Box>
        {files.length > 0 && (
          <MediaGrid>
            {files.map((f) => {
              const previewUrl = objectUrls[f.itemId] || (f.sourceType === "url" ? f.url : "");
              const isVideo = Boolean(f?.local?.isVideo) || String(f?.local?.mime || "").startsWith("video/");
              const isAudio = String(f?.local?.mime || "").startsWith("audio/");
              const isPlaying = String(playingId || "") === String(f.itemId || "");

              const uploadPct = Number(f?.uploadPct);
              const pctOk = Number.isFinite(uploadPct) && uploadPct >= 0 && uploadPct <= 100;

              const uploadStageRaw = String(f?.uploadStage || "").trim();
              // avoid showing boring "uploading" twice
              const uploadStage = uploadStageRaw && uploadStageRaw !== "uploading" ? uploadStageRaw : "";

const stageLabel =
  f.stage === "uploaded"
    ? "Uploaded (mp3)"
    : f.stage === "downloading"
    ? "Downloading…"
    : f.stage === "converting"
    ? "Converting to mp3…"
    : f.stage === "uploading"
    ? "Uploading mp3…"
    : f.stage === "linked"
    ? "Linked"
    : f.stage || "Draft";


              // ✅ live extra for uploads (optional)
              const stageExtra =
                String(f.stage) === "uploading" && (uploadStage || pctOk)
                  ? ` (${[uploadStage || null, pctOk ? `${Math.round(uploadPct)}%` : null].filter(Boolean).join(" ")})`
                  : "";

              const stageLabelUi = `${stageLabel}${stageExtra}`;


              const onDelete = async () => {
                try {
                  const el = mediaRefs.current[f.itemId];
                  if (el && !el.paused) el.pause();
                } catch {}
                if (isPlaying) setPlayingId(null);
                await deleteDraftMedia(thread.id, f.itemId);
              };

              const onOpenNewTab = () => {
                if (!previewUrl) return;
                window.open(previewUrl, "_blank", "noopener,noreferrer");
              };

              const onPlayClick = () => {
                if (!previewUrl) return;
                playInline({ itemId: f.itemId, previewUrl });
              };

              return (
                <Card key={f.itemId}>
                  <Thumb>
                    {previewUrl ? (
                      isVideo ? (
                        <VideoPlayer
                          ref={(el) => {
                            if (el) mediaRefs.current[f.itemId] = el;
                            else delete mediaRefs.current[f.itemId];
                          }}
                          src={previewUrl}
                          playsInline
                          preload="metadata"
                          muted={!isPlaying}
                          controls={isPlaying}
                          onEnded={() => {
                            if (String(playingId) === String(f.itemId)) setPlayingId(null);
                          }}
                        />
                      ) 
              : isAudio ? (
                <AudioWrap>
                  <AudioPlayer
                    ref={(el) => {
                      if (el) mediaRefs.current[f.itemId] = el;
                      else delete mediaRefs.current[f.itemId];
                    }}
                    src={previewUrl}
                    controls={isPlaying}
                    preload="metadata"
                    onEnded={() => {
                      if (String(playingId) === String(f.itemId)) setPlayingId(null);
                    }}
                  />
                  {!isPlaying ? (
                    <AudioBadge style={{ position: "absolute", inset: 0 }}>
                      audio
                    </AudioBadge>
                  ) : null}
                </AudioWrap>
              ) : (

                        <LinkBadge>link</LinkBadge>
                      )
                    ) : (
                      <EmptyThumb>…</EmptyThumb>
                    )}

                    <HoverActions>
                      <IconButton type="button" title={isPlaying ? "Pause" : "Play"} onClick={onPlayClick}>
                        {isPlaying ? "❚❚" : "▶"}
                      </IconButton>

                      <IconButton type="button" title="Open in new tab" onClick={onOpenNewTab}>
                        ↗
                      </IconButton>

                      <IconButton type="button" title="Delete" onClick={onDelete}>
                        ✕
                      </IconButton>
                    </HoverActions>
                  </Thumb>

                  <Meta>
                    <Name title={f?.local?.name || f?.audio?.b2?.filename || f?.url || ""}>
                      {f?.local?.name || f?.audio?.b2?.filename || f?.url || "Media"}
                    </Name>
                    <Sub>{stageLabelUi}</Sub>
                  </Meta>
                </Card>
              );
            })}
          </MediaGrid>
        )}

        <TopRow>
          <Attach>
            <HiddenFile type="file" multiple accept="audio/*,video/*" onChange={onChooseFiles} />
            <AttachButton type="button" title="Attach media">
              📎
            </AttachButton>
          </Attach>

          <UrlInput placeholder="Paste a media URL and press +" value={url} onChange={(e) => setUrl(e.target.value)} />

          <AddUrlButton type="button" onClick={onAddUrl} disabled={!url.trim()}>
            +
          </AddUrlButton>

<StartButton
  type="button"
  disabled={startUi.disabled || !!startPending}
  title={startPending ? "Starting…" : startUi.title}
  onClick={onStart}
>
  <StartBtnInner>
    {startPending ? (
      <>
        <TinySpinner />
        Starting…
      </>
    ) : (
      startUi.text
    )}
  </StartBtnInner>
</StartButton>

        </TopRow>

<OptionsRow>
  <Pill type="button" $on={doTranscribe} onClick={() => setDoTranscribe((v) => !v)}>
    <PillInner>
      <span>Transcription</span>
      {transcribeMini.show && (
        <PillMiniBadge title={transcribeMini.title} $state={transcribeMini.state}>
          {"~" + transcribeMini.text}
        </PillMiniBadge>
      )}
    </PillInner>
  </Pill>

  <Pill type="button" $on={doTranslate} onClick={() => setDoTranslate((v) => !v)}>
    <PillInner>
      <span>Translation</span>
      {translateMini.show && (
        <PillMiniBadge title={translateMini.title} $state={translateMini.state}>
          {"~" + translateMini.text}
        </PillMiniBadge>
      )}
    </PillInner>
  </Pill>

  <Pill type="button" $on={doSummarize} onClick={() => setDoSummarize((v) => !v)}>
    <PillInner>
      <span>Summarization</span>
      {summarizeMini.show ? (
    <PillMiniBadge title={summarizeMini.title} $state={summarizeMini.state}>
      {"~" + summarizeMini.text}
    </PillMiniBadge>
  ) : null}
  </PillInner>
  </Pill>

  {totalBadge.show && (
    <TokenBadge title={totalBadge.title} $state={totalBadge.state} aria-label={totalBadge.title || "Total estimate"}>
      {"~" + totalBadge.text}
    </TokenBadge>
  )}
</OptionsRow>


        {(doTranscribe || doTranslate || doSummarize) && (
          <Panel>
            {doTranscribe && (
              <Group>
                <GroupTitle>Transcription</GroupTitle>

                <Fields>
                  <Field>
                    <Label>Language</Label>
                    <Select value={asrLang} onChange={(e) => setAsrLang(e.target.value)}>
                      {safeArr(LANGUAGES).map((l) => (
                        <option key={String(l.value)} value={String(l.value)}>
                          {String(l.label || l.value)}
                        </option>
                      ))}
                    </Select>
                  </Field>

                  <Field>
                    <Label>Model</Label>
                    <Select value={asrModel} onChange={(e) => setAsrModel(e.target.value)}>
                      {asrModelOptions.length ? (
                        asrModelOptions.map((m) => (
                          <option key={String(m.id)} value={String(m.id)}>
                            {String(m.label || m.id)}
                          </option>
                        ))
                      ) : (
                        <option value={asrModel}>No models for this language</option>
                      )}
                    </Select>
                  </Field>
                </Fields>
              </Group>
            )}

            {doTranslate && (
  <Group>
    <GroupTitle>Translation</GroupTitle>

    <TrFields>
      <TrField>
        <Label>Source</Label>
        <Select value={trSourceLang} onChange={(e) => setTrSourceLang(e.target.value)}>
          {(trSourceLangOptions.length ? trSourceLangOptions : [{ value: "auto", label: "Auto-detect" }]).map((l) => (
            <option key={String(l.value)} value={String(l.value)}>
              {String(l.label || l.value)}
            </option>
          ))}
        </Select>
      </TrField>

      <TrFieldGrow>
        <Label>Targets</Label>
        <MultiLangSelect
          value={trTargetLangs}
          options={(trTargetLangOptions.length ? trTargetLangOptions : [{ value: "en", label: "English" }])}
          placeholder="Select target languages…"
          onChange={(next) => setTrTargetLangs(uniq(next))}
        />
      </TrFieldGrow>

      <TrField>
        <Label>Model</Label>
        <Select value={trModelId} onChange={(e) => setTrModelId(e.target.value)}>
          {(trModelOptions.length ? trModelOptions : [{ id: "gpt-4o-mini", label: "GPT-4o mini" }]).map((m) => (
            <option key={String(m.id)} value={String(m.id)}>
              {String(m.label || m.id)}
            </option>
          ))}
        </Select>
      </TrField>
    </TrFields>
  </Group>
)}



            {doSummarize && (
              <Group>
                <GroupTitle>Summarization</GroupTitle>
                <Fields>

                  <Field>
                    <Label>Language</Label>

                    {/* ✅ full dropdown */}
                    <Select value={sumTargetLang} onChange={(e) => setSumTargetLang(e.target.value)}>
                      {(sumTargetLangOptions.length ? sumTargetLangOptions : [{ value: "English", label: "English" }]).map((l) => (
                        <option key={String(l.value)} value={String(l.value)}>
                          {String(l.label || l.value)}
                        </option>
                      ))}
                    </Select>

                  </Field>

                  <Field>
                    <Label>Model</Label>
<Select value={sumModelId} onChange={(e) => setSumModelId(e.target.value)}>
  {(sumModelOptions.length ? sumModelOptions : [{ id: "gpt-4o-mini", label: "GPT-4o mini" }]).map((m) => (
    <option key={String(m.id)} value={String(m.id)}>
      {String(m.label || m.id)}
    </option>
  ))}
</Select>

                  </Field>
                </Fields>
              </Group>
            )}
          </Panel>
        )}
      </Box>
    </Dock>
  );
}

/* --- styles --- */

const Dock = styled.div`
  padding: 16px 18px;
  border-top: 1px solid var(--border);
  background: var(--bg);
  display: flex;
  justify-content: center;
`;

const Box = styled.div`
  width: 100%;
  max-width: 860px;
`;

const MediaGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 12px;

  @media (max-width: 900px) {
    grid-template-columns: repeat(3, 1fr);
  }
  @media (max-width: 680px) {
    grid-template-columns: repeat(2, 1fr);
  }
`;

const Card = styled.div`
  border: 1px solid var(--border);
  background: var(--panel);
  border-radius: 14px;
  overflow: hidden;
  box-shadow: var(--shadow);
`;

const Thumb = styled.div`
  position: relative;
  height: 110px;
  background: rgba(0, 0, 0, 0.05);

  &:hover > div {
    opacity: 1;
    pointer-events: auto;
  }
`;

const VideoPlayer = styled.video`
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
`;

  const AudioWrap = styled.div`
    position: relative;
    height: 100%;
    width: 100%;
    display: grid;
    place-items: center;
    padding: 10px;
  `;

const AudioPlayer = styled.audio`
  width: 100%;
`;

const EmptyThumb = styled.div`
  height: 100%;
  display: grid;
  place-items: center;
  color: var(--muted);
  font-weight: 900;
`;

const AudioBadge = styled.div`
  height: 100%;
  display: grid;
  place-items: center;
  font-weight: 950;
  color: var(--text);
`;

const LinkBadge = styled.div`
  height: 100%;
  display: grid;
  place-items: center;
  font-weight: 950;
  color: var(--text);
`;

const HoverActions = styled.div`
  position: absolute;
  inset: 0;
  display: flex;
  align-items: flex-end;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 120ms ease;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.35), rgba(0, 0, 0, 0));
`;

const IconButton = styled.button`
  width: 34px;
  height: 34px;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.35);
  background: rgba(255, 255, 255, 0.18);
  color: #fff;
  font-weight: 900;
  cursor: pointer;

  &:hover {
    background: rgba(255, 255, 255, 0.26);
  }
`;

const Meta = styled.div`
  padding: 10px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
`;

const Name = styled.div`
  font-weight: 900;
  font-size: 12px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const Sub = styled.div`
  font-size: 11px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const TopRow = styled.div`
  display: grid;
  grid-template-columns: 44px 1fr 44px 92px;
  gap: 10px;
  align-items: center;
`;

const Attach = styled.label`
  position: relative;
  display: inline-grid;
  place-items: center;
`;

const HiddenFile = styled.input`
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
`;

const AttachButton = styled.div`
  width: 44px;
  height: 44px;
  border-radius: 14px;
  border: 1px solid var(--border);
  background: var(--panel);
  display: grid;
  place-items: center;
  font-size: 16px;
  box-shadow: var(--shadow);
`;

const UrlInput = styled.input`
  height: 44px;
  border-radius: 14px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
  padding: 0 14px;
  outline: none;
  box-shadow: var(--shadow);

  &::placeholder {
    color: rgba(107, 114, 128, 0.9);
  }
`;

const AddUrlButton = styled.button`
  height: 44px;
  width: 44px;
  border-radius: 14px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
  font-weight: 950;
  cursor: pointer;
  box-shadow: var(--shadow);

  &:hover:enabled {
    background: var(--hover);
  }
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

const StartButton = styled.button`
  height: 44px;
  border-radius: 14px;
  border: 1px solid rgba(239, 68, 68, 0.25);
  background: rgba(239, 68, 68, 0.1);
  color: var(--accent);
  font-weight: 950;
  cursor: pointer;
  box-shadow: var(--shadow);

  &:hover:enabled {
    background: rgba(239, 68, 68, 0.14);
  }
  &:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
`;

const OptionsRow = styled.div`
  margin-top: 12px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
`;

const Pill = styled.button`
  border-radius: 999px;
  border: 1px solid ${(p) => (p.$on ? "rgba(239,68,68,0.28)" : "var(--border)")};
  background: ${(p) => (p.$on ? "rgba(239,68,68,0.10)" : "var(--panel)")};
  color: ${(p) => (p.$on ? "var(--accent)" : "var(--text)")};
  font-weight: 900;
  font-size: 12px;
  padding: 8px 10px;
  cursor: pointer;
  box-shadow: var(--shadow);

  &:hover {
    background: ${(p) => (p.$on ? "rgba(239,68,68,0.12)" : "var(--hover)")};
  }
`;

// Minimal: a tiny readout right after "Summarization" (need/have).
// - ok: subtle neutral
// - bad: red-tinted to convey insufficient
// - unknown: muted
const TokenBadge = styled.div`
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 10px;
  border-radius: 999px;
  font-weight: 950;
  font-size: 12px;
  letter-spacing: -0.01em;
  white-space: nowrap;
  user-select: none;
  box-shadow: var(--shadow);

  border: 1px solid
    ${(p) =>
      p.$state === "bad"
        ? "rgba(239,68,68,0.32)"
        : p.$state === "unknown"
        ? "rgba(0,0,0,0.10)"
        : "rgba(0,0,0,0.10)"};

  background:
    ${(p) =>
      p.$state === "bad"
        ? "rgba(239,68,68,0.12)"
        : p.$state === "unknown"
        ? "rgba(0,0,0,0.03)"
        : "rgba(255,255,255,0.55)"};

  color: ${(p) => (p.$state === "bad" ? "var(--accent)" : p.$state === "unknown" ? "var(--muted)" : "var(--text)")};

  backdrop-filter: blur(7px);
`;

const Panel = styled.div`
  margin-top: 12px;
  border-radius: 16px;
  border: 1px solid var(--border);
  background: var(--panel);
  box-shadow: var(--shadow);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
`;

const Group = styled.div`
  border: 1px solid var(--border);
  background: rgba(0, 0, 0, 0.015);
  border-radius: 14px;
  padding: 10px;
`;

const GroupTitle = styled.div`
  font-weight: 950;
  font-size: 12px;
  color: var(--text);
  margin-bottom: 8px;
`;

const Fields = styled.div`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;

  @media (max-width: 720px) {
    grid-template-columns: 1fr;
  }
`;

const Field = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
`;

const Label = styled.div`
  font-size: 11px;
  color: var(--muted);
  font-weight: 800;
`;

const Select = styled.select`
  height: 38px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: #fff;
  color: var(--text);
  padding: 0 10px;
  outline: none;

  &:focus {
    border-color: rgba(239, 68, 68, 0.35);
    box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.1);
  }
`;

const StartBtnInner = styled.span`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
`;

const TinySpinner = styled.span`
  width: 14px;
  height: 14px;
  border: 2px solid rgba(239, 68, 68, 0.55);
  border-bottom-color: transparent;
  border-radius: 50%;
  display: inline-block;
  animation: spin 0.65s linear infinite;

  @keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }
`;

// ✅ Translation: keep ALL 3 controls in one row (scroll on small screens)

const TrField = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 170px;
  flex: 0 0 auto;
`;

const TrFields = styled.div`
  display: flex;
  gap: 10px;
  align-items: flex-end;
  flex-wrap: nowrap;

  overflow-x: auto;
  overflow-y: visible; /* ✅ key: don't clip dropdown vertically */
  padding-bottom: 2px;

  -webkit-overflow-scrolling: touch;
  scrollbar-width: thin;
`;


const TrFieldGrow = styled(TrField)`
  min-width: 240px;
  flex: 1 1 320px;
`;

// ✅ Multi-select dropdown (matches your Select visual language)


const MultiBtn = styled.button`
  height: 38px;
  width: 100%;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: #fff;
  color: var(--text);
  padding: 0 10px;
  outline: none;
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  cursor: pointer;

  &:focus {
    border-color: rgba(239, 68, 68, 0.35);
    box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.1);
  }

  &:hover {
    background: var(--hover);
  }
`;

const MultiBtnText = styled.span`
  font-weight: 900;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const MultiCaret = styled.span`
  font-size: 12px;
  opacity: 0.75;
  transform: ${(p) => (p.$open ? "rotate(180deg)" : "rotate(0deg)")};
  transition: transform 0.12s ease;
`;

const MultiSearch = styled.input`
  width: 100%;
  height: 40px;
  border: 0;
  border-bottom: 1px solid var(--border);
  padding: 0 12px;
  outline: none;
  background: rgba(0, 0, 0, 0.01);
  color: var(--text);
  font-weight: 900;
  font-size: 12px;

  &::placeholder {
    color: var(--muted);
    font-weight: 800;
  }
`;


const MultiItem = styled.button`
  width: 100%;
  border: 0;
  border-radius: 12px;
  background: ${(p) => (p.$on ? "rgba(239,68,68,0.10)" : "transparent")};
  color: var(--text);
  padding: 9px 10px;
  font-size: 12px;
  font-weight: 900;
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  text-align: left;

  &:hover {
    background: ${(p) => (p.$on ? "rgba(239,68,68,0.12)" : "rgba(0,0,0,0.04)")};
  }
`;

const MultiCheck = styled.span`
  width: 18px;
  height: 18px;
  border-radius: 6px;
  border: 1px solid ${(p) => (p.$on ? "rgba(239,68,68,0.35)" : "rgba(0,0,0,0.12)")};
  background: ${(p) => (p.$on ? "rgba(239,68,68,0.12)" : "rgba(255,255,255,0.55)")};
  display: inline-grid;
  place-items: center;
  color: var(--accent);
  font-weight: 1000;
  font-size: 12px;
`;



const MultiLink = styled.button`
  border: 0;
  background: transparent;
  color: var(--text);
  font-weight: 950;
  font-size: 12px;
  cursor: pointer;
  opacity: 0.9;

  &:hover {
    opacity: 1;
    color: var(--accent);
  }
`;





const MultiWrap = styled.div`
  position: relative;

  /* ✅ THIS is the “increase height by ~100” fix when opened */
  margin-bottom: ${(p) => (p.$open ? "110px" : "0")};
`;

const MultiMenu = styled.div`
  position: absolute;
  z-index: 9999;
  top: calc(100% + 8px);
  left: 0;
  width: 100%;
  min-width: 260px;
  border-radius: 14px;
  border: 1px solid var(--border);
  background: var(--panel);
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.16);
  overflow: hidden;
`;

const MultiTopbar = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  background: rgba(0, 0, 0, 0.01);
`;

const MultiCount = styled.div`
  font-size: 11px;
  font-weight: 900;
  color: var(--muted);

  b {
    color: var(--text);
    font-weight: 1000;
  }
`;

const MultiTopActions = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 10px;
`;

const MultiList = styled.div`
  max-height: 320px; /* ✅ a bit taller */
  overflow: auto;
  padding: 6px;
`;

const MultiFooter = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border-top: 1px solid var(--border);
  background: rgba(0, 0, 0, 0.01);
`;

const MultiFooterLeft = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 10px;
`;

const MultiFooterRight = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 10px;
`;

/* ✅ Preview row under the button */
const MultiPreview = styled.div`
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
`;

const MultiPreviewMuted = styled.div`
  margin-top: 6px;
  font-size: 11px;
  font-weight: 800;
  color: var(--muted);
`;

const MultiChip = styled.span`
  font-size: 11px;
  font-weight: 950;
  color: var(--text);
  padding: 3px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: rgba(0, 0, 0, 0.02);
  white-space: nowrap;
`;

const MultiMore = styled.span`
  font-size: 11px;
  font-weight: 950;
  color: var(--muted);
  padding: 3px 6px;
`;

const PillInner = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 8px;
`;

const PillMiniBadge = styled.span`
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  font-weight: 950;
  font-size: 11px;
  letter-spacing: -0.01em;
  white-space: nowrap;

  border: 1px solid
    ${(p) =>
      p.$state === "unknown"
        ? "rgba(0,0,0,0.10)"
        : "rgba(0,0,0,0.10)"};

  background:
    ${(p) =>
      p.$state === "unknown"
        ? "rgba(0,0,0,0.03)"
        : "rgba(255,255,255,0.55)"};

  color: ${(p) => (p.$state === "unknown" ? "var(--muted)" : "var(--text)")};
`;
