// components/ChatTimeline.js
import { useEffect, useMemo, useRef, useState } from "react";
import styled from "styled-components";
import { useAuth } from "../contexts/AuthContext";
import { createPortal } from "react-dom";
import { useThreads } from "../contexts/threadsContext";
import ChatMediaPlayer from "./ChatMediaPlayer";
import LegacySrtSegmentsEditor from "./LegacySrtSegmentsEditor";
import TranslatedSrtViewer from "./TranslatedSrtViewer";
import { getLangKeyCI, getByLangCI } from "../lib/langKey";
import * as CatalogImport from "../shared/transcriptionCatalog";
const Catalog = (CatalogImport && (CatalogImport.default || CatalogImport)) || {};
const { LANGUAGES, getModelsForLanguage } = Catalog;

// ✅ billing helpers for client-side estimates
import * as BillingImport from "../shared/billingCatalog";
const Billing = (BillingImport && (BillingImport.default || BillingImport)) || {};
const { estimateTokensForSeconds, tokensToUsd } = Billing;

// ✅ translation catalog (UI-only settings)
import * as TranslationImport from "../shared/translationCatalog";
const TranslationCatalog = (TranslationImport && (TranslationImport.default || TranslationImport)) || {};
const { DEFAULTS: TR_DEFAULTS, getModels: getTrModels, getSourceLanguages, getTargetLanguages } = TranslationCatalog;

import * as TrBillImport from "../shared/translationBillingCatalog";
const TrBill = (TrBillImport && (TrBillImport.default || TrBillImport)) || {};

import * as SumBillImport from "../shared/summarizationBillingCatalog";
const SumBill = (SumBillImport && (SumBillImport.default || SumBillImport)) || {};

function normalizeWhitespace(t) {
  return String(t || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSegmentsForCompare(segs) {
  const arr = Array.isArray(segs) ? segs : [];
  const clean = arr
    .map((s) => ({
      start: Number(s?.start || 0),
      end: Number(s?.end || 0),
      text: normalizeWhitespace(s?.text || ""),
    }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end >= s.start && s.text);

  clean.sort((a, b) => a.start - b.start || a.end - b.end || a.text.localeCompare(b.text));
  return clean;
}

function segmentsEqual(a, b) {
  const A = normalizeSegmentsForCompare(a);
  const B = normalizeSegmentsForCompare(b);
  if (A.length !== B.length) return false;

  for (let i = 0; i < A.length; i++) {
    if (segKey(A[i]) !== segKey(B[i])) return false;
  }
  return true;
}


function segKey(seg) {
  const s = Number(seg?.start || 0);
  const e = Number(seg?.end || 0);
  const t = normalizeWhitespace(seg?.text || "");
  return `${s.toFixed(3)}|${e.toFixed(3)}|${t}`;
}


function getTranslationPayload(results, lang, opts) {
  const trMap = results?.translations && typeof results.translations === "object" ? results.translations : null;
  if (!trMap) return null;

  const allowFallback = !(opts && typeof opts === "object" && opts.allowFallback === false);

  // pick lang (case-insensitive)
  if (lang) {
    const key = getLangKeyCI(trMap, lang);
    if (key) return trMap[key] || null;

    // ✅ if lang was requested but missing, only fall back when allowed
    if (!allowFallback) return null;
  }

  const firstKey = Object.keys(trMap)[0];
  return firstKey ? trMap[firstKey] : null;
}


function hasTranslationContent(v) {
  if (!v) return false;

  // persisted as raw string (SRT or plain text)
  if (typeof v === "string") return v.trim().length > 0;

  // persisted as segments array
  if (Array.isArray(v)) {
    return v.some((seg) => String(seg?.text || "").trim().length > 0);
  }

  // persisted as object
  if (typeof v === "object") {
    const srt = String(v?.srt || v?.translationSrt || "").trim();
    const text = String(v?.text || v?.translationText || "").trim();
    const segs =
      (Array.isArray(v?.segments) && v.segments) ||
      (Array.isArray(v?.translationSegments) && v.translationSegments) ||
      [];

    return !!(srt || text || (segs && segs.length));
  }

  return false;
}

function getCompletedTranslateLangs(results, trByLang) {
  const out = [];

  const trMap = results?.translations && typeof results.translations === "object" ? results.translations : null;

  // ✅ include languages that have persisted output (string/array/object)
  if (trMap) {
    for (const k of Object.keys(trMap)) {
      if (hasTranslationContent(trMap[k])) out.push(k);
    }
  }

  // ✅ include languages marked done by status (migration-safe)
  const by = trByLang && typeof trByLang === "object" ? trByLang : null;
  if (by) {
    for (const k of Object.keys(by)) {
      const st = normalizeStepState(by[k]?.state);
      if (st === "done") out.push(k);
    }
  }

  return uniq(out);
}


function getLiveTranslateSegments(liveTranslateStepVal, lang) {
  const v = liveTranslateStepVal;

  // legacy: array of segs
  if (Array.isArray(v)) return v;

  // new: { [lang]: segs[] }
  if (v && typeof v === "object" && lang) {
    const hit = getByLangCI(v, lang);
    return Array.isArray(hit) ? hit : [];
  }

  return [];
}


function getLiveStreamFor(stepVal, lang) {
  if (!stepVal) return "";

  // old shape: []
  if (Array.isArray(stepVal)) return stepVal.join("");

  // new shape: { [lang]: [] }
  if (stepVal && typeof stepVal === "object" && lang) {
    const hit = getByLangCI(stepVal, lang);
    return Array.isArray(hit) ? hit.join("") : "";
  }

  return "";
}



function isRtlLang(lang) {
  const base = String(lang || "")
    .toLowerCase()
    .trim()
    .split(/[-_]/)[0];

  return ["ar", "fa", "he", "ur", "ps", "dv", "ku", "ug", "yi", "sd"].includes(base);
}

function looksRtlText(text) {
  const t = String(text || "");
  return /[\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC]/.test(t);
}

function dirFromLangAndSample(lang, sampleText) {
  const l = String(lang || "").toLowerCase().trim();
  if (!l || l === "auto") return looksRtlText(sampleText) ? "rtl" : "ltr";
  return isRtlLang(l) ? "rtl" : "ltr";
}

function mergeSegments(a, b) {
  const A = Array.isArray(a) ? a : [];
  const B = Array.isArray(b) ? b : [];
  if (!A.length) return B.slice();
  if (!B.length) return A.slice();

  const seen = new Set();
  const out = [];

  for (const seg of [...A, ...B]) {
    if (!seg) continue;
    const k = segKey(seg);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(seg);
  }

  out.sort(
    (x, y) => Number(x?.start || 0) - Number(y?.start || 0) || Number(x?.end || 0) - Number(y?.end || 0)
  );
  return out;
}

function pickFirstNumber(...vals) {
  for (const v of vals) {
    if (v == null) continue;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

// Try to read server-side translation unit estimate (per-language).
// Server code computes ONE unit cost and repeats per lang (does not multiply totals),
// so we multiply on the client by lang count.
function getServerTranslateUnitTokens({ it, liveOne, tr }) {
  // Most likely places (be liberal / migration safe)
  const candidates = [
    // If you attach estimate object onto status.translate
    tr?.estimate?.estimatedTokensPerLang,
    tr?.estimate?.tokensPerLang,
    tr?.estimate?.mediaTokensPerLang,
    tr?.estimatedTokensPerLang,
    tr?.potentialTokensPerLang,

    // Or if server repeats perLang array
    tr?.estimate?.perLang?.[0]?.expectedTokens,
    tr?.estimate?.perLang?.[0]?.mediaTokens,
    tr?.estimate?.perLang?.[0]?.tokens,

    // Or byLang (if you store expected tokens on each lang)
    tr?.byLang && typeof tr.byLang === "object"
      ? pickFirstNumber(
          ...Object.keys(tr.byLang).map((k) => tr.byLang[k]?.expectedTokens),
          ...Object.keys(tr.byLang).map((k) => tr.byLang[k]?.mediaTokens),
          ...Object.keys(tr.byLang).map((k) => tr.byLang[k]?.potentialTokens)
        )
      : null,

    // Sometimes might live under billing on the item or live run
    it?.billing?.translateEstimatedTokensPerLang,
    liveOne?.billing?.translateEstimatedTokensPerLang,
  ];

  return pickFirstNumber(...candidates);
}

// Returns { totalTokens, usdFormatted, used: "server"|"client"|"none" }
function estimateTranslateTotalTokens({ it, liveOne, tr, inputForEstimate, targetLangs }) {
  const langs = Array.isArray(targetLangs) ? targetLangs.map(String).filter(Boolean) : [];
  if (!langs.length) return { totalTokens: 0, usdFormatted: "", used: "none" };

  // ✅ server-first unit estimate stays as-is (if you trust it)
  const unit = getServerTranslateUnitTokens({ it, liveOne, tr });
  if (unit != null && unit > 0) {
    const totalTokens = Math.max(0, Math.round(unit * langs.length));
    return { totalTokens, usdFormatted: "", used: "server" };
  }

  // ✅ prefer duration-based estimate (matches ThreadComposer)
  const durationSeconds = durationSecondsFromChatItem(it);
  if (durationSeconds != null && typeof TrBill?.estimateTranslationRunWithDurationFallback === "function") {
    const est = TrBill.estimateTranslationRunWithDurationFallback(null, durationSeconds, langs, null);
    const totalTokens = Math.max(0, Number(est?.mediaTokens || 0) || 0);
    const usdFormatted = est?.usdFormatted || "";
    return { totalTokens, usdFormatted, used: totalTokens ? "duration" : "none" };
  }

  // fallback: text-based
  const est =
    typeof TrBill?.estimateTranslationRun === "function"
      ? TrBill.estimateTranslationRun(inputForEstimate, langs, null)
      : null;

  const totalTokens = est ? Math.max(0, Number(est.mediaTokens || 0) || 0) : 0;
  const usdFormatted = est?.usdFormatted || "";
  return { totalTokens, usdFormatted, used: totalTokens ? "text" : "none" };
}



function safeArr(x) {
  return Array.isArray(x) ? x : [];
}

function uniq(arr) {
  return Array.from(new Set((arr || []).map((x) => String(x || "")).filter(Boolean)));
}

function normalizeStepState(raw) {
  const s = String(raw || "").toLowerCase().trim();
  // ✅ "blocked" is not a real UX state for timeline — treat it as idle
  if (s === "blocked") return "idle";
  return s;
}

function normalizeStageLabel(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  // if server ever sends stage="blocked", hide it too
  if (s.toLowerCase() === "blocked") return "";
  return s;
}


function isBusy(stepStatus) {
  const s = normalizeStepState(stepStatus?.state);
  return s === "queued" || s === "running";
}

function isFailed(stepStatus) {
  return normalizeStepState(stepStatus?.state) === "failed";
}

function compactTranslateStage(stageLabel, hasOut, prog) {
  const s = String(stageLabel || "").toUpperCase().trim();

  let base =
    s === "TRANSLATING" || s === "RUNNING"
      ? "RUN"
      : s === "QUEUED"
      ? "Q"
      : s === "DONE"
      ? "DONE"
      : s === "FAILED"
      ? "FAIL"
      : s === "—" || !s
      ? hasOut
        ? "READY"
        : "MISS"
      : s.slice(0, 4);

  if (prog > 0 && prog < 1) base = `${base} ${Math.round(prog * 100)}%`;
  return base;
}


function deriveStage(stepStatus, stepName) {
  const state = normalizeStepState(stepStatus?.state);
  const stage = normalizeStageLabel(stepStatus?.stage);

  if (stage) return stage;
  if (state === "queued") return "QUEUED";
  if (state === "running") {
    if (stepName === "transcribe") return "TRANSCRIBING";
    if (stepName === "translate") return "TRANSLATING";
    if (stepName === "summarize") return "SUMMARIZING";
    return "RUNNING";
  }
  if (state === "done") return "DONE";
  if (state === "failed") return "FAILED";

  // ✅ hide idle (and anything normalized to idle, like blocked)
  if (state === "idle") return "—";

  // fallback (should be rare)
  return state || "—";
}

function stateTone(stepStatus) {
  const s = normalizeStepState(stepStatus?.state);
  if (s === "done") return "done";
  if (s === "failed") return "failed";
  if (s === "running") return "running";
  if (s === "queued") return "queued";
  // ✅ no "blocked" tone
  return "idle";
}


function aggregateStepFromByLang(step, targets) {
  const base = step && typeof step === "object" ? step : {};
  const byLang = base.byLang && typeof base.byLang === "object" ? base.byLang : null;

  const langs = Array.isArray(targets) ? targets.map(String).filter(Boolean) : [];
  if (!byLang || !langs.length) {
    return { ...base, state: normalizeStepState(base.state || "idle") };
  }

  // ✅ missing langs => "idle" (do NOT drop them)
  const states = langs.map((l) => normalizeStepState(getByLangCI(byLang, l)?.state || "idle"));

  const anyBusy = states.some((s) => s === "queued" || s === "running");
  const anyFailed = states.some((s) => s === "failed");
  const allDone = states.length && states.every((s) => s === "done");

  let nextState;
  if (anyBusy) nextState = "running";
  else if (anyFailed) nextState = "failed";
  else if (allDone) nextState = "done";
  else {
    // ✅ don't let a stale base "done" leak into this rollup
    const baseNorm = normalizeStepState(base.state || "idle");
    nextState = baseNorm === "queued" || baseNorm === "running" || baseNorm === "failed" ? baseNorm : "idle";
  }

  const doneCount = states.filter((s) => s === "done").length;
  const failCount = states.filter((s) => s === "failed").length;

  return {
    ...base,
    state: normalizeStepState(nextState),
    _rollup: { total: langs.length, done: doneCount, failed: failCount },
  };
}



function getStepForLang(step, lang) {
  const l = String(lang || "").trim();
  const byLang = step?.byLang && typeof step.byLang === "object" ? step.byLang : null;

  // ✅ translate has byLang — never fall back to aggregate state for per-lang UI
  if (byLang && l) {
    const hit = getByLangCI(byLang, l);
    return hit || { state: "idle" };
  }

  // transcribe/summarize (no byLang)
  return step || {};
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
    out.push({ start, end, text });
  }

  out.sort((a, b) => a.start - b.start || a.end - b.end);
  return out;
}

function segmentsToPlainText(segments) {
  const segs = Array.isArray(segments) ? segments : [];
  return segs
    .map((s) => normalizeWhitespace(s?.text || ""))
    .filter(Boolean)
    .join(" ")
    .trim();
}

function formatCompact(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  if (x >= 1000000) return `${(x / 1000000).toFixed(x >= 10000000 ? 0 : 1)}m`;
  if (x >= 10000) return `${Math.round(x / 1000)}k`;
  if (x >= 1000) return `${(x / 1000).toFixed(1)}k`;
  return String(Math.round(x));
}

function pickDefaultModelIdForLang(lang) {
  const l = String(lang || "auto") || "auto";
  if (typeof getModelsForLanguage !== "function") return "deepgram_nova3";
  const opts = safeArr(getModelsForLanguage(l));
  return String(opts?.[0]?.id || "deepgram_nova3");
}

function isActiveAtTime(seg, t) {
  const s = Number(seg?.start || 0);
  const e = Number(seg?.end || 0);
  const time = Number(t || 0);
  return time >= s && time < e;
}

function fmtClock(seconds) {
  const s = Math.max(0, Number(seconds || 0));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const pad = (n) => String(n).padStart(2, "0");
  if (hh > 0) return `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
  return `${pad(mm)}:${pad(ss)}`;
}

function trKey(chatItemId, lang) {
  const cid = String(chatItemId || "").trim();
  const l = String(lang || "").trim().toLowerCase();
  return cid && l ? `${cid}::${l}` : cid;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}
function pad3(n) {
  return String(n).padStart(3, "0");
}
function secondsToTimecode(sec) {
  const s = Math.max(0, Number(sec || 0));
  const totalMs = Math.round(s * 1000);

  const hh = Math.floor(totalMs / 3600000);
  const rem1 = totalMs % 3600000;
  const mm = Math.floor(rem1 / 60000);
  const rem2 = rem1 % 60000;
  const ss = Math.floor(rem2 / 1000);
  const ms = rem2 % 1000;

  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)},${pad3(ms)}`;
}

function segmentsToSrt(segments) {
  const segs = Array.isArray(segments) ? segments : [];
  const blocks = segs
    .map((seg, i) => {
      const idx = String(i + 1);
      const start = secondsToTimecode(Number(seg?.start || 0));
      const end = secondsToTimecode(Number(seg?.end || 0));
      const text = String(seg?.text || "").trim();
      return `${idx}\n${start} --> ${end}\n${text}`;
    })
    .join("\n\n");
  return blocks.trim() ? blocks.trim() + "\n" : "";
}


// ✅ robust duration getter for client-side estimation
function durationSecondsFromChatItem(it) {
  const media = it?.media || {};
  const n =
    media?.durationSeconds ??
    media?.duration ??
    media?.meta?.durationSeconds ??
    media?.meta?.duration ??
    media?.urlMeta?.durationSeconds ??
    media?.audio?.durationSeconds ??
    it?.durationSeconds ??
    it?.audio?.durationSeconds ??
    it?.urlMeta?.durationSeconds ??
    it?.results?.transcriptMeta?.durationSeconds ??
    it?.results?.mediaMeta?.durationSeconds ??
    null;

  const x = Number(n);
  return Number.isFinite(x) && x > 0 ? x : null;
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

  const clearAll = () => onChange && onChange([]);

  const selectAll = () => onChange && onChange(allValues.slice());

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
    <TL_MultiWrap ref={wrapRef} $open={open}>
      <TL_MultiBtn type="button" onClick={() => setOpen((v) => !v)} title={selectedLabels.join(", ") || ""}>
        <TL_MultiBtnText>{summary}</TL_MultiBtnText>
        <TL_MultiCaret $open={open}>▾</TL_MultiCaret>
      </TL_MultiBtn>

      {/* preview chips */}
      {selectedLabels.length ? (
        <TL_MultiPreview title={selectedLabels.join(", ")}>
          {selectedLabels.slice(0, 6).map((lbl, i) => (
            <TL_MultiChip key={`${lbl}|${i}`}>{lbl}</TL_MultiChip>
          ))}
          {selectedLabels.length > 6 ? <TL_MultiMore>+{selectedLabels.length - 6}</TL_MultiMore> : null}
        </TL_MultiPreview>
      ) : (
        <TL_MultiPreviewMuted>None selected</TL_MultiPreviewMuted>
      )}

      {open ? (
        <TL_MultiMenu role="listbox" aria-label="Target languages">
          <TL_MultiSearch
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search languages…"
            autoFocus
          />

          <TL_MultiTopbar>
            <TL_MultiCount>
              Selected <b>{vals.length}</b> / {allValues.length || opts.length || 0}
            </TL_MultiCount>

            <TL_MultiTopActions>
              <TL_MultiLink type="button" onClick={selectFiltered} title="Add all currently filtered languages">
                Select filtered
              </TL_MultiLink>
              <TL_MultiLink type="button" onClick={selectAll} title="Select all available languages">
                {allSelected ? "All selected" : "Select all"}
              </TL_MultiLink>
            </TL_MultiTopActions>
          </TL_MultiTopbar>

          <TL_MultiList>
            {filtered.map((o) => {
              const v = String(o?.value || "");
              const lbl = String(o?.label || o?.value || "");
              const checked = selectedSet.has(v);

              return (
                <TL_MultiItem key={v} type="button" onClick={() => toggle(v)} $on={checked}>
                  <TL_MultiCheck $on={checked}>{checked ? "✓" : ""}</TL_MultiCheck>
                  <span>{lbl}</span>
                </TL_MultiItem>
              );
            })}
          </TL_MultiList>

          <TL_MultiFooter>
            <TL_MultiLink type="button" onClick={clearAll}>
              Clear
            </TL_MultiLink>
            <TL_MultiLink type="button" onClick={() => setOpen(false)}>
              Done
            </TL_MultiLink>
          </TL_MultiFooter>
        </TL_MultiMenu>
      ) : null}
    </TL_MultiWrap>
  );
}

function getTranslateTargetsForItem(it, trStatus, trOpts) {
  const results = it?.results || {};
  const translations = results?.translations && typeof results.translations === "object" ? results.translations : null;
  const fromResults = translations ? Object.keys(translations).filter(Boolean) : [];

  const fromStatus = uniq(
    Array.isArray(trStatus?.targetLangs) ? trStatus.targetLangs : trStatus?.targetLang ? [trStatus.targetLang] : []
  );

  const fromOptions = uniq(Array.isArray(it?.options?.translation?.targetLangs) ? it.options.translation.targetLangs : []);

  const fromUi = uniq(Array.isArray(trOpts?.targetLangs) ? trOpts.targetLangs : trOpts?.targetLang ? [trOpts.targetLang] : []);

  // results first (completed), then status/options, then UI
  return uniq([...fromResults, ...fromStatus, ...fromOptions, ...fromUi]);
}

function TranslateSelectionGuard({ chatItemId, explicitLang, validLangs, clearSelectedLang }) {
  useEffect(() => {
    if (!chatItemId) return;

    const l = String(explicitLang || "").trim();
    if (!l) return; // only guard explicit picks

    const ok = Array.isArray(validLangs) && validLangs.includes(l);
    if (ok) return;

    clearSelectedLang && clearSelectedLang(chatItemId);
  }, [chatItemId, explicitLang, Array.isArray(validLangs) ? validLangs.join("|") : "", clearSelectedLang]);

  return null;
}


// ======================
// ✅ SUMMARY ESTIMATION HELPERS (deterministic + ThreadComposer-aligned)
// ======================

function estimateTokensForTextLoose(text) {
  // safe fallback heuristic: ~1 token ≈ 4 chars
  const s = String(text || "");
  const chars = s.length;
  if (!chars) return 0;
  return Math.max(1, Math.ceil(chars / 4));
}

function estimateSummaryTokensFallback({ inputText } = {}) {
  const inTok = estimateTokensForTextLoose(inputText);

  // output heuristic: ~20% of input + fixed, capped
  const outTok = Math.min(900, Math.max(180, Math.ceil(inTok * 0.2) + 120));

  // overhead (system/tooling)
  const overhead = 80;

  return Math.max(0, Math.round(inTok + outTok + overhead));
}

// ✅ deterministic estimator (same method as ThreadComposer)
function estimateSummarizeRunTokensDeterministic({ inputText, modelId, language } = {}) {
  const text = String(inputText || "").trim();
  if (!text) return 0;

  if (SumBill && typeof SumBill.estimateSummarizationRun === "function") {
    try {
      const opts = {};
      if (modelId) opts.modelId = String(modelId);
      // only pass language if your billing estimator supports it (harmless if ignored)
      if (language && String(language).trim()) opts.language = String(language);

      const run = SumBill.estimateSummarizationRun({ text }, opts);
      const n = Number(run?.mediaTokens || 0) || 0;
      return Math.max(0, Math.round(n));
    } catch {}
  }

  return estimateSummaryTokensFallback({ inputText: text });
}

function getSummaryCostDisplay({ it, liveOne, sum, inputText, modelId, language }) {
  // actual tokens (prefer actual)
  const costRaw =
    sum?.actualTokensUsed ??
    sum?.costTokens ??
    sum?.billingTokens ??
    sum?.tokens ??
    it?.billing?.summarizeTokens ??
    it?.billing?.summaryTokens ??
    liveOne?.billing?.summarizeTokens ??
    liveOne?.billing?.summaryTokens ??
    null;

  const hasCost = costRaw != null && String(costRaw) !== "";
  const costTokens = Math.max(0, Number(costRaw || 0) || 0);

  // potential/estimated tokens (server-side “expected”)
  const potentialRaw =
    sum?.potentialTokens ??
    sum?.estimatedTokens ??
    sum?.expectedTokens ??
    it?.billing?.summarizePotentialTokens ??
    it?.billing?.summaryPotentialTokens ??
    liveOne?.billing?.summarizePotentialTokens ??
    null;

  const hasPotential = potentialRaw != null && String(potentialRaw) !== "";
  const potentialTokens = Math.max(0, Number(potentialRaw || 0) || 0);

  // ✅ deterministic estimate when server didn’t provide anything yet
  const clientTokens =
    !hasCost && !hasPotential
      ? estimateSummarizeRunTokensDeterministic({ inputText, modelId, language })
      : 0;

  const kind = hasCost ? "actual" : hasPotential ? "potential" : clientTokens > 0 ? "client" : "unknown";

  const tokens =
    kind === "actual" ? costTokens : kind === "potential" ? potentialTokens : kind === "client" ? clientTokens : null;

  const usd = tokens != null && typeof tokensToUsd === "function" ? Number(tokensToUsd(tokens) || 0) : null;

  const title =
    kind === "actual"
      ? `Summary cost: ${costTokens} tokens`
      : kind === "potential"
      ? `Estimated summary cost: ~${potentialTokens} tokens`
      : kind === "client"
      ? `Client estimate: ~${clientTokens} tokens • ${String(modelId || "") || "model"}`
      : "No estimate yet";

  return { kind, tokens, usd, title };
}




export default function ChatTimeline({ thread, showEmpty = true }) {
  const { liveRunsByThread, retryTranscribe, retryTranslate, retrySummarize, saveSrt, saveTranslationSrt } = useThreads();


  const [trViewByItem, setTrViewByItem] = useState({});
const [trLangByItem, setTrLangByItem] = useState({});

const trSrtEditorRefsRef = useRef({});
const [trSrtMetaByKey, setTrSrtMetaByKey] = useState({});
const [optimisticTrSrtByKey, setOptimisticTrSrtByKey] = useState({});

const [sumOptsByItem, setSumOptsByItem] = useState({});

  const [tabByItem, setTabByItem] = useState({});
  const [transViewByItem, setTransViewByItem] = useState({});
  const [timeByItem, setTimeByItem] = useState({});

// shape: { chatItemId, kind: "transcribe" | "translate" | "summarize" }
const [openMenu, setOpenMenu] = useState(null);

  const anchorElRef = useRef(null);
  const menuElRef = useRef(null);
  const [menuPos, setMenuPos] = useState(null);

  const [transOptsByItem, setTransOptsByItem] = useState({});
  const [trOptsByItem, setTrOptsByItem] = useState({});

  const playerApisRef = useRef({});

  const srtEditorRefsRef = useRef({});
  const [srtMetaByItem, setSrtMetaByItem] = useState({});

  const [optimisticSrtByItem, setOptimisticSrtByItem] = useState({});

  // ✅ token gating for client-side actions
  const { tokenSnapshot, mediaTokens, pendingMediaTokens, reserveMediaTokens } = useAuth();

  // ✅ unused = availableRaw - optimisticEffective (capped)
  const availableUnused = useMemo(() => {
    const availableRaw =
      tokenSnapshot && typeof tokenSnapshot.mediaTokens === "number"
        ? tokenSnapshot.mediaTokens
        : typeof mediaTokens === "number"
        ? mediaTokens
        : 0;

    const serverReserved = tokenSnapshot && typeof tokenSnapshot.mediaTokensReserved === "number" ? tokenSnapshot.mediaTokensReserved : 0;

    const pendingRaw = typeof pendingMediaTokens === "number" ? pendingMediaTokens : serverReserved;

    const baseAvailable = Math.max(0, Number(availableRaw || 0));
    const baseServerReserved = Math.max(0, Number(serverReserved || 0));
    const basePending = Math.max(0, Number(pendingRaw || 0));

    const optimisticRequested = Math.max(0, basePending - baseServerReserved);
    const optimisticEffective = Math.min(optimisticRequested, baseAvailable);

    return Math.max(0, baseAvailable - optimisticEffective);
  }, [tokenSnapshot, mediaTokens, pendingMediaTokens]);

  const items = useMemo(() => {
    const arr = safeArr(thread?.chatItems);
    return arr
      .slice()
      .sort((a, b) => (Date.parse(b?.createdAt || 0) || 0) - (Date.parse(a?.createdAt || 0) || 0));
  }, [thread?.chatItems]);

useEffect(() => {
  setOptimisticSrtByItem((prev) => {
    const next = { ...(prev || {}) };

    for (const it of items) {
      const id = String(it?.chatItemId || "");
      if (!id) continue;

      const persistedSrtRaw = String(it?.results?.transcriptSrt || "").trim();
      const persistedSegsRaw = Array.isArray(it?.results?.transcriptSegments) ? it.results.transcriptSegments : [];

      const optSrt = String(next[id] || "").trim();
      if (!optSrt) continue;

      // Old behavior (if server still returns transcriptSrt)
      if (persistedSrtRaw && optSrt === persistedSrtRaw) {
        delete next[id];
        continue;
      }

      // New behavior: clear if server segments match our optimistic SRT parsed into segments
      if (!persistedSrtRaw && persistedSegsRaw.length) {
        const optSegs = srtToSegments(optSrt);
        if (segmentsEqual(optSegs, persistedSegsRaw)) delete next[id];
      }
    }

    return next;
  });
}, [items]);


function safeFileBaseName(name) {
  const raw = String(name || "file").trim() || "file";
  const cleaned = raw
    .replace(/[\/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

  // strip a simple extension (".mp4", ".wav", ".m4a", etc.)
  const noExt = cleaned.replace(/\.[a-z0-9]{1,6}$/i, "").trim();
  return noExt || "file";
}

function downloadBlobFile(filename, blob) {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();

  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function downloadTextFile(filename, text, mime) {
  const content = String(text || "");
  const blob = new Blob([content], { type: mime || "text/plain;charset=utf-8" });
  downloadBlobFile(filename, blob);
}

async function copyToClipboard(text) {
  if (typeof window === "undefined" || typeof document === "undefined") return false;

  const s = String(text || "");
  if (!s.trim()) return false;

  // modern
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch (e) {}

  // fallback
  try {
    const ta = document.createElement("textarea");
    ta.value = s;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.left = "-1000px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return !!ok;
  } catch (e) {
    return false;
  }
}

// ✅ tries to zip many files if jszip exists; else falls back to a single bundle .txt
async function downloadAllAsZipOrBundle({ zipName, bundleName, files }) {
  if (typeof window === "undefined") return;

  const cleanFiles = (Array.isArray(files) ? files : [])
    .map((f) => ({
      name: String(f?.name || "").trim(),
      content: String(f?.content || ""),
    }))
    .filter((f) => f.name && f.content.trim());

  if (!cleanFiles.length) return;

  // Try JSZip (global or dynamic import)
  try {
    const JSZip = window.JSZip || (await import("jszip")).default;
    if (JSZip) {
      const zip = new JSZip();
      for (const f of cleanFiles) zip.file(f.name, f.content);
      const blob = await zip.generateAsync({ type: "blob" });
      downloadBlobFile(zipName || "downloads.zip", blob);
      return;
    }
  } catch (e) {
    // ignore -> fallback
  }

  // Fallback: one bundle txt
  const bundled = cleanFiles
    .map((f) => `===== ${f.name} =====\n${f.content}\n`)
    .join("\n");

  downloadTextFile(bundleName || "downloads.bundle.txt", bundled, "text/plain;charset=utf-8");
}


  useEffect(() => {
  setOptimisticTrSrtByKey((prev) => {
    const next = { ...(prev || {}) };

    for (const it of items) {
      const cid = String(it?.chatItemId || "");
      if (!cid) continue;

      const trMap =
        it?.results?.translations && typeof it.results.translations === "object"
          ? it.results.translations
          : null;
      if (!trMap) continue;

      for (const lang of Object.keys(trMap)) {
        const payload = trMap[lang];

        let persistedSrt = "";
        let persistedSegs = [];

        if (typeof payload === "string") {
          persistedSrt = String(payload || "").trim();
        } else if (Array.isArray(payload)) {
          persistedSegs = payload;
        } else if (payload && typeof payload === "object") {
          persistedSrt = String(payload?.srt || payload?.translationSrt || "").trim();
          persistedSegs =
            (Array.isArray(payload?.segments) && payload.segments) ||
            (Array.isArray(payload?.translationSegments) && payload.translationSegments) ||
            [];
        }

        const k = trKey(cid, lang);
        const opt = String(next[k] || "").trim();
        if (!opt) continue;

        // Old behavior: clear if exact SRT match
        if (persistedSrt && opt === persistedSrt) {
          delete next[k];
          continue;
        }

        // New behavior: clear if server segs match our optimistic SRT parsed to segments
        if (!persistedSrt && persistedSegs.length) {
          const optSegs = srtToSegments(opt);
          if (segmentsEqual(optSegs, persistedSegs)) delete next[k];
        }
      }
    }

    return next;
  });
}, [items]);



  const live = liveRunsByThread && liveRunsByThread[String(thread?.id)] ? liveRunsByThread[String(thread?.id)] : null;
  const liveChat = live?.chatItems && typeof live.chatItems === "object" ? live.chatItems : {};

  const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";

  // ✅ translation options (shared)
  const trModelOptions = useMemo(() => {
    return typeof getTrModels === "function" ? safeArr(getTrModels()) : [];
  }, []);
  const trSourceLangOptions = useMemo(() => {
    return typeof getSourceLanguages === "function" ? safeArr(getSourceLanguages()) : [];
  }, []);
  const trTargetLangOptions = useMemo(() => {
    return typeof getTargetLanguages === "function" ? safeArr(getTargetLanguages()) : [];
  }, []);

  const computeMenuPos = () => {
    if (!isBrowser) return;
    const anchor = anchorElRef.current;
    if (!anchor) return;

    const rect = anchor.getBoundingClientRect();

    const width = Math.min(420, Math.max(300, Math.floor(window.innerWidth * 0.36)));
    const pad = 12;

    let left = rect.right - width;
    left = Math.max(pad, Math.min(left, window.innerWidth - width - pad));

    let top = rect.bottom + 8;
    let placement = "bottom";

    setMenuPos({ top, left, width, placement, _anchorTop: rect.top, _anchorBottom: rect.bottom });
  };

  const refineMenuPlacement = () => {
    if (!isBrowser) return;
    if (!menuElRef.current) return;
    if (!menuPos) return;

    const mr = menuElRef.current.getBoundingClientRect();
    const pad = 12;

    if (mr.bottom > window.innerHeight - pad) {
      const anchorTop = Number(menuPos?._anchorTop || 0);
      const desiredTop = anchorTop - mr.height - 8;
      if (desiredTop >= pad) {
        setMenuPos((p) => (p ? { ...p, top: desiredTop, placement: "top" } : p));
      }
    }
  };

  const openTranslationView = (cid, lang, view) => {
  const id = String(cid || "").trim();
  const l = String(lang || "").trim();
  if (!id || !l) return;

  setTrLangByItem((p) => ({ ...(p || {}), [id]: l }));
  setTabByItem((p) => ({ ...(p || {}), [id]: "translate" }));
  setTrViewByItem((p) => ({ ...(p || {}), [id]: view || "srt" }));
  closeMenu();
};

  const closeMenu = () => {
    setOpenMenu(null);
    anchorElRef.current = null;
    setMenuPos(null);
  };





  useEffect(() => {
    if (!openMenu) return;

    computeMenuPos();

    const onDown = (e) => {
      const t = e?.target;
      if (!t) return;

      const a = anchorElRef.current;
      const m = menuElRef.current;

      if (a && a.contains(t)) return;
      if (m && m.contains(t)) return;

      closeMenu();
    };

    const onKey = (e) => {
      if (String(e?.key || "") === "Escape") closeMenu();
    };

    const onReflow = () => {
      computeMenuPos();
      requestAnimationFrame(() => refineMenuPlacement());
    };

    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);

    requestAnimationFrame(() => refineMenuPlacement());

    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openMenu]);

  if (!items.length) {
    if (!showEmpty) return null;
    return (
      <EmptyCard>
        <EmptyTitle>No messages yet</EmptyTitle>
        <EmptySub>Press Start to move uploaded media into chat items.</EmptySub>
      </EmptyCard>
    );
  }

  const languageOptions = safeArr(LANGUAGES);

  return (
    <List>
      {items.map((it) => {
        const chatItemId = String(it?.chatItemId || "");
        const media = it?.media || {};
        const status = it?.status || {};
        const results = it?.results || {};
        const liveOne = liveChat[chatItemId] || null;

        const tab = tabByItem[chatItemId] || "transcribe";
        const transView = transViewByItem[chatItemId] || "srt";

        const trans = status?.transcribe || {};
        const tr = status?.translate || {};
        const sum = status?.summarize || {};

      


        const transState = String(trans?.state || "");
        const isTranscribing = transState === "running" || transState === "queued";

        const persistedSrtRaw = String(results?.transcriptSrt || "");
        const optimisticSrt = String(optimisticSrtByItem?.[chatItemId] || "");
        const persistedSrt = (optimisticSrt || persistedSrtRaw || "").trim();

        const editedSegs = persistedSrt ? srtToSegments(persistedSrt) : [];
        const persistedSegs = editedSegs.length
          ? editedSegs
          : Array.isArray(results?.transcriptSegments)
          ? results.transcriptSegments
          : [];

        const liveSegs = Array.isArray(liveOne?.segments?.transcribe) ? liveOne.segments.transcribe : [];
        const mergedSegs = transState === "running" ? mergeSegments(persistedSegs, liveSegs) : persistedSegs;

        const segPlain = segmentsToPlainText(mergedSegs);

        // ✅ Best available input for translation estimation (same as doTranslateNow)

const seedTargets = Array.isArray(TR_DEFAULTS?.targetLangs) && TR_DEFAULTS.targetLangs.length
  ? TR_DEFAULTS.targetLangs
  : [String(TR_DEFAULTS?.targetLang || "en") || "en"];

const trSeed = {
  sourceLang: String(TR_DEFAULTS?.sourceLang || "auto") || "auto",
  targetLangs: uniq(seedTargets),
  modelId: String(TR_DEFAULTS?.modelId || "gpt-4o-mini") || "gpt-4o-mini",
};

const trOpts = trOptsByItem?.[chatItemId] || trSeed;


const trByLang = tr?.byLang && typeof tr.byLang === "object" ? tr.byLang : null;

// completed (persisted OR status-done)
const trCompletedLangs = getCompletedTranslateLangs(results, trByLang);

// targets (same source as menu)
const trTargetsForViewer = getTranslateTargetsForItem(it, tr, trOpts);

// ✅ selectable = completed first, then the rest of targets
const trSelectableLangs = uniq([...trCompletedLangs, ...trTargetsForViewer]);

const explicitTrLang = String(trLangByItem?.[chatItemId] || "").trim();

// ✅ keep explicit if it's still selectable; otherwise fall back
const selectedTrLang =
  (explicitTrLang && trSelectableLangs.includes(explicitTrLang) ? explicitTrLang : "") ||
  trCompletedLangs[0] ||
  trSelectableLangs[0] ||
  "";


// ======================
// ✅ SUMMARY (estimate + actual + rerun gating)
// ======================

// seed settings (ThreadComposer-aligned)
const sumSeed = {
  modelId: String(sum?.modelId || it?.options?.summarize?.modelId || TR_DEFAULTS?.modelId || "gpt-4o-mini"),
  language: String(sum?.language || it?.options?.summarize?.language || it?.options?.summarize?.lang || "auto") || "auto",
};

const sumOpts = sumOptsByItem?.[chatItemId] || sumSeed;
const sumModelId = String(sumOpts?.modelId || sumSeed.modelId || "gpt-4o-mini");
const sumLang = String(sumOpts?.language || sumSeed.language || "auto") || "auto";

// best input text to summarize (prefer transcript)
const summaryInputText =
  normalizeWhitespace(results?.transcript || segPlain || getLiveStreamFor(liveOne?.stream?.transcribe) || "");

// display object (actual wins; else server potential; else deterministic client estimate)
const sumDisp = getSummaryCostDisplay({
  it,
  liveOne,
  sum,
  inputText: summaryInputText,
  modelId: sumModelId,
  language: sumLang,
});

const sumTokens = sumDisp.tokens;
const sumUsd = sumDisp.usd;
const sumIsBusy = isBusy(sum);

// ✅ rerun estimate ALWAYS computed from current UI settings (like transcribe rerunTokens)
const sumRerunTokens =
  summaryInputText
    ? estimateSummarizeRunTokensDeterministic({ inputText: summaryInputText, modelId: sumModelId, language: sumLang })
    : null;

const sumRerunUsd =
  sumRerunTokens != null && typeof tokensToUsd === "function" ? Number(tokensToUsd(sumRerunTokens) || 0) : null;

const sumRerunAffordable = sumRerunTokens == null ? true : sumRerunTokens <= availableUnused;

// used for “can click rerun”
const sumCanRerun = !sumIsBusy && sumRerunAffordable;

let sumPillState =
  sumDisp.kind === "potential" || sumDisp.kind === "client"
    ? "potential"
    : sumIsBusy
    ? "pending"
    : normalizeStepState(sum?.state) === "failed"
    ? "failed"
    : normalizeStepState(sum?.state) === "done"
    ? "done"
    : "idle";

// ✅ optional: show red if estimate exists but you can’t afford rerun
if (!sumIsBusy && sumDisp.kind !== "actual" && sumRerunTokens != null && !sumRerunAffordable) {
  sumPillState = "failed";
}

const sumPillTitle =
  sumDisp.kind === "unknown"
    ? `No estimate yet • ${sumModelId} • ${sumLang}`
    : [
        sumDisp.title,
        sumUsd != null ? `(~$${sumUsd.toFixed(2)})` : null,
        `Lang: ${sumLang}`,
        `Model: ${sumModelId}`,
        sumRerunTokens != null ? `Rerun: ~${sumRerunTokens} tok${sumRerunUsd != null ? ` (~$${sumRerunUsd.toFixed(2)})` : ""}` : null,
        sumRerunTokens != null ? `Have unused: ${availableUnused}` : null,
      ]
        .filter(Boolean)
        .join(" • ");



  const trStepForLang = selectedTrLang ? getStepForLang(tr, selectedTrLang) : {};
const isTranslatingLang = !!selectedTrLang && isBusy(trStepForLang);

const trMetaKey = trKey(chatItemId, selectedTrLang);
const trMeta = trSrtMetaByKey?.[trMetaKey] || {};
const trDirty = !!trMeta.dirty;
const trBadTime = !!trMeta.hasBadTime;
const trView = trViewByItem?.[chatItemId] || "srt";

const canTrReset = tab === "translate" && trView === "srt" && !isTranslatingLang && trDirty;
const canTrSave = tab === "translate" && trView === "srt" && !isTranslatingLang && trDirty && !trBadTime;

const doTrReset = () => {
  const api = trSrtEditorRefsRef.current?.[chatItemId];
  if (api && typeof api.reset === "function") api.reset();
};

const doTrSave = () => {
  const api = trSrtEditorRefsRef.current?.[chatItemId];
  if (api && typeof api.save === "function") api.save();
};




const trPayload = getTranslationPayload(results, selectedTrLang, { allowFallback: !explicitTrLang });

// persisted translation segments/text
const trOptKey = trKey(chatItemId, selectedTrLang);
const optimisticTrSrt = String(optimisticTrSrtByKey?.[trOptKey] || "").trim();

let persistedTrSrt = "";
let persistedTrSegs = [];
let persistedTrText = "";

const p = trPayload;

// ✅ optimistic wins (so editor/text updates immediately after save)
if (optimisticTrSrt) {
  persistedTrSrt = optimisticTrSrt;
}

if (!persistedTrSrt) {
  if (typeof p === "string") {
    persistedTrSrt = String(p || "").trim();
  } else if (Array.isArray(p)) {
    persistedTrSegs = p;
  } else if (p && typeof p === "object") {
    persistedTrSrt = String(p?.srt || p?.translationSrt || "").trim();
    persistedTrText = String(p?.text || p?.translationText || "").trim();
    persistedTrSegs =
      (Array.isArray(p?.segments) && p.segments) ||
      (Array.isArray(p?.translationSegments) && p.translationSegments) ||
      [];
  }
}

if (!persistedTrSegs.length && persistedTrSrt) persistedTrSegs = srtToSegments(persistedTrSrt);
if (!persistedTrText && persistedTrSegs.length) persistedTrText = segmentsToPlainText(persistedTrSegs);


// live streaming translate segments (from ws live store)
const liveTranslateSegs = getLiveTranslateSegments(liveOne?.segments?.translate, selectedTrLang);



// merge while running

const trAggForRunning = aggregateStepFromByLang(tr, getTranslateTargetsForItem(it, tr, trOpts));
const mergedTranslateSegs =
  normalizeStepState(trAggForRunning?.state) === "running"
    ? mergeSegments(persistedTrSegs, liveTranslateSegs)
    : persistedTrSegs;

const mergedTranslateText =
  persistedTrText || (mergedTranslateSegs.length ? segmentsToPlainText(mergedTranslateSegs) : "");

// ✅ Now drive the displayed text from the correct source
const showText =
  tab === "transcribe"
    ? results?.transcript || ""
    : tab === "translate"
    ? (mergedTranslateText || "") // <-- key fix
    : results?.summary || "";


        const curTime = Number(timeByItem[chatItemId] || 0);

        const title = media?.filename || media?.name || (media?.url ? "linked media" : "media");

        const baseName = safeFileBaseName(title || chatItemId);



        const toneT = stateTone(trans);
        const toneTR = stateTone(tr);
        const toneS = stateTone(sum);

        const isTransMenuOpen = openMenu && openMenu.chatItemId === chatItemId && openMenu.kind === "transcribe";
        const isTranslateMenuOpen = openMenu && openMenu.chatItemId === chatItemId && openMenu.kind === "translate";

        const seedLang = String(trans?.language || "") || "auto";
        const seedModel = String(trans?.modelId || "") || pickDefaultModelIdForLang(seedLang);

        const opts = transOptsByItem[chatItemId] || {
          language: seedLang,
          modelId: seedModel,
        };

        const modelsForLang =
          typeof getModelsForLanguage === "function"
            ? safeArr(getModelsForLanguage(String(opts.language || "auto") || "auto"))
            : [];

        const modelIsValid = modelsForLang.some((m) => String(m?.id || "") === String(opts.modelId || ""));
        const effectiveModelId =
          String(opts.modelId || "") && (modelsForLang.length ? modelIsValid : true)
            ? String(opts.modelId || "")
            : String(modelsForLang?.[0]?.id || pickDefaultModelIdForLang(opts.language));

        const canReTranscribeState = !isTranscribing;


        // ======================
        // ✅ COST (actual vs estimate; actual wins)
        // ======================
        const costTokensRaw =
          trans?.actualTokensUsed ??
          trans?.costTokens ??
          trans?.billingTokens ??
          trans?.tokens ??
          it?.billing?.transcribeTokens ??
          it?.billing?.mediaTokens ??
          it?.billing?.tokens ??
          it?.transcribeTokens ??
          it?.mediaTokens ??
          results?.transcriptMeta?.actualTokensUsed ??
          results?.transcriptMeta?.billingTokens ??
          results?.transcriptMeta?.tokens ??
          liveOne?.billing?.transcribeTokens ??
          liveOne?.billing?.mediaTokens ??
          liveOne?.billing?.tokens ??
          live?.billingByChatItemId?.[chatItemId];

        const hasCostField = costTokensRaw != null && String(costTokensRaw) !== "";
        const costTokens = Math.max(0, Number(costTokensRaw || 0) || 0);

        const potentialRaw =
          trans?.potentialTokens ??
          trans?.estimatedTokens ??
          trans?.expectedTokens ??
          results?.transcriptMeta?.potentialTokens ??
          results?.transcriptMeta?.estimatedTokens ??
          liveOne?.billing?.potentialTokens ??
          it?.billing?.potentialTokens ??
          liveOne?.potentialTokens ??
          it?.potentialTokens ??
          null;

        const hasPotentialField = potentialRaw != null && String(potentialRaw) !== "";
        const potentialTokens = Math.max(0, Number(potentialRaw || 0) || 0);

        const durationSeconds = durationSecondsFromChatItem(it);
        const clientEstimateTokens =
          !hasCostField &&
          !hasPotentialField &&
          durationSeconds != null &&
          typeof estimateTokensForSeconds === "function"
            ? Math.max(0, Number(estimateTokensForSeconds(durationSeconds, effectiveModelId, null) || 0) || 0)
            : 0;

        const displayKind = hasCostField
          ? "actual"
          : hasPotentialField
          ? "potential"
          : clientEstimateTokens > 0
          ? "client"
          : "unknown";

        const displayTokens =
          displayKind === "actual"
            ? costTokens
            : displayKind === "potential"
            ? potentialTokens
            : displayKind === "client"
            ? clientEstimateTokens
            : null;

        const pillState =
          displayKind === "potential" || displayKind === "client"
            ? "potential"
            : isBusy(trans)
            ? "pending"
            : transState === "failed"
            ? "failed"
            : transState === "done"
            ? "done"
            : "idle";

        const modelLabel =
          modelsForLang.find((m) => String(m?.id || "") === String(effectiveModelId || ""))?.label || effectiveModelId;

        const usdApprox = displayTokens != null && typeof tokensToUsd === "function" ? Number(tokensToUsd(displayTokens) || 0) : null;

        const pillTitle =
          displayKind === "actual"
            ? `Transcription cost: ${costTokens} tokens`
            : displayKind === "potential"
            ? `Estimated transcription cost: ~${potentialTokens} tokens`
            : displayKind === "client"
            ? `Client estimate: ~${clientEstimateTokens} tokens${durationSeconds ? ` • duration ${fmtClock(durationSeconds)}` : ""} • ${modelLabel}`
            : `No estimate yet${durationSeconds ? "" : " (missing duration)"}${modelLabel ? ` • ${modelLabel}` : ""}`;

        // ✅ open transcription menu (portal)
        const openTranscribeMenu = (e) => {
          if (!isBrowser) return;
          const el = e?.currentTarget;
          if (!el) return;

          setTransOptsByItem((p) => {
            const cur = p?.[chatItemId];
            if (cur) return p || {};

            const lang = seedLang;
            const models = typeof getModelsForLanguage === "function" ? safeArr(getModelsForLanguage(lang)) : [];
            const modelId = String(trans?.modelId || "") || String(models?.[0]?.id || pickDefaultModelIdForLang(lang));

            return {
              ...(p || {}),
              [chatItemId]: { language: lang, modelId },
            };
          });

          if (isTransMenuOpen) {
            closeMenu();
            return;
          }

          anchorElRef.current = el;
          setOpenMenu({ chatItemId, kind: "transcribe" });
        };



// normalize (if older state only has targetLang)
const trTargets = uniq(
  Array.isArray(trOpts?.targetLangs)
    ? trOpts.targetLangs
    : [String(trOpts?.targetLang || trSeed.targetLang || "en")]
);



// per-lang status (optional)


const trAgg = aggregateStepFromByLang(tr, trTargetsForViewer);
const toneTR2 = stateTone(trAgg);
const trRoll = trAgg?._rollup || null;

const trBtnPill =
  trRoll && trRoll.total
    ? `${trRoll.done}/${trRoll.total}`
    : (trTargetsForViewer.length ? `${trTargetsForViewer.length}` : "—");



const trModelLabel =
  (trModelOptions || []).find((m) => String(m?.id || "") === String(trOpts?.modelId || ""))?.label ||
  String(trOpts?.modelId || "gpt-4o-mini");

const translateSummaryTitle = [
  `Source: ${String(trOpts?.sourceLang || "auto")}`,
  `Targets: ${trTargets.length ? trTargets.join(", ") : "—"}`,
  `Model: ${trModelLabel}`,
].join(" • ");

const canDoTranslateNow = !isBusy(trAgg);




// persisted translations map
const trMap =
  results?.translations && typeof results.translations === "object" ? results.translations : null;


// "completed & exists" predicate
function hasTranslationOutput(lang) {
  // done state from status
  const st = getByLangCI(trByLang, lang);
  const stState = String(st?.state || "").toLowerCase().trim();

  // persisted payload
  const payload = getByLangCI(trMap, lang);

  // decide “exists”
const hasPersisted =
  typeof payload === "string"
    ? payload.trim().length > 0
    : Array.isArray(payload)
    ? payload.some((seg) => String(seg?.text || "").trim().length > 0)
    : payload && typeof payload === "object"
    ? !!(
        String(payload?.srt || payload?.translationSrt || payload?.text || payload?.translationText || "").trim() ||
        (Array.isArray(payload?.segments) && payload.segments.length) ||
        (Array.isArray(payload?.translationSegments) && payload.translationSegments.length)
      )
    : false;


  // your rule: completed (not pending) AND exists
  // (if you want to allow “exists even if status missing”, keep the OR)
  return (stState === "done" && hasPersisted) || (stState !== "queued" && stState !== "running" && hasPersisted);
}

const trTargetsAll = uniq(trTargets);
const trMissingTargets = trTargetsAll.filter((l) => !hasTranslationOutput(l));


// ----------------------
// ✅ TRANSCRIPTION export
// ----------------------
const getTranscribeSrtOut = () => {
  const api = srtEditorRefsRef.current?.[chatItemId];
  if (api && typeof api.getSrt === "function") return String(api.getSrt() || "");
  // if server has no raw SRT but we have segments, generate one
  if (persistedSrt && String(persistedSrt).trim()) return String(persistedSrt);
  if (Array.isArray(mergedSegs) && mergedSegs.length) return segmentsToSrt(mergedSegs);
  return "";
};

const getTranscribeTextOut = () => {
  // match what user sees in Text view as closely as possible
  const txt = String(results?.transcript || segPlain || getLiveStreamFor(liveOne?.stream?.transcribe) || "");
  return txt;
};

const transcribeHasOut =
  transView === "srt" ? !!getTranscribeSrtOut().trim() : !!getTranscribeTextOut().trim();

const onDownloadTranscribe = () => {
  if (transView === "srt") {
    const srt = getTranscribeSrtOut();
    if (!srt.trim()) return;
    downloadTextFile(`${baseName}.srt`, srt, "application/x-subrip;charset=utf-8");
  } else {
    const txt = getTranscribeTextOut();
    if (!txt.trim()) return;
    downloadTextFile(`${baseName}.txt`, txt, "text/plain;charset=utf-8");
  }
};

const onCopyTranscribe = async () => {
  const payload = transView === "srt" ? getTranscribeSrtOut() : getTranscribeTextOut();
  await copyToClipboard(payload);
};

// ----------------------
// ✅ TRANSLATION export
// ----------------------
function extractTranslationForLang(lang) {
  const l = String(lang || "").trim();
  if (!l) return { srt: "", text: "" };

  // optimistic per-lang wins
  const k = trKey(chatItemId, l);
  const optSrt = String(optimisticTrSrtByKey?.[k] || "").trim();
  if (optSrt) {
    const srt = optSrt.endsWith("\n") ? optSrt : optSrt + "\n";
    const segs = srtToSegments(srt);
    const text = segs.length ? segmentsToPlainText(segs) : "";
    return { srt, text };
  }

  const payload = trMap ? getByLangCI(trMap, l) : null;

  let srt = "";
  let segs = [];
  let text = "";

  if (typeof payload === "string") {
    srt = payload;
  } else if (Array.isArray(payload)) {
    segs = payload;
  } else if (payload && typeof payload === "object") {
    srt = String(payload?.srt || payload?.translationSrt || "");
    text = String(payload?.text || payload?.translationText || "");
    segs =
      (Array.isArray(payload?.segments) && payload.segments) ||
      (Array.isArray(payload?.translationSegments) && payload.translationSegments) ||
      [];
  }

  srt = String(srt || "").trim();
  text = String(text || "").trim();

  if (!segs.length && srt) segs = srtToSegments(srt);
  if (!text && segs.length) text = segmentsToPlainText(segs);
  if (!srt && segs.length) srt = segmentsToSrt(segs);

  if (srt && !srt.endsWith("\n")) srt += "\n";
  return { srt, text };
}

const getTranslateSrtOut = () => {
  const api = trSrtEditorRefsRef.current?.[chatItemId];
  if (api && typeof api.getSrt === "function") return String(api.getSrt() || "");
  if (persistedTrSrt && String(persistedTrSrt).trim()) return String(persistedTrSrt);
  if (Array.isArray(mergedTranslateSegs) && mergedTranslateSegs.length) return segmentsToSrt(mergedTranslateSegs);
  return "";
};

const getTranslateTextOut = () => {
  return String(mergedTranslateText || translateStream || "");
};

const translateHasOut =
  trView === "srt" ? !!getTranslateSrtOut().trim() : !!getTranslateTextOut().trim();

const onDownloadTranslateOne = () => {
  const lang = String(selectedTrLang || "").trim();
  if (!lang) return;

  if (trView === "srt") {
    const srt = getTranslateSrtOut();
    if (!srt.trim()) return;
    downloadTextFile(`${baseName}.${lang}.srt`, srt, "application/x-subrip;charset=utf-8");
  } else {
    const txt = getTranslateTextOut();
    if (!txt.trim()) return;
    downloadTextFile(`${baseName}.${lang}.txt`, txt, "text/plain;charset=utf-8");
  }
};

const onCopyTranslate = async () => {
  const payload = trView === "srt" ? getTranslateSrtOut() : getTranslateTextOut();
  await copyToClipboard(payload);
};

// ✅ Download-all languages that actually have output
const trLangsForDownloadAll = (Array.isArray(trSelectableLangs) ? trSelectableLangs : []).filter((l) => {
  const lang = String(l || "").trim();
  if (!lang) return false;

  const k = trKey(chatItemId, lang);
  const opt = String(optimisticTrSrtByKey?.[k] || "").trim();
  if (opt) return true;

  const payload = trMap ? getByLangCI(trMap, lang) : null;
  return hasTranslationContent(payload);
});

const onDownloadTranslateAll = async () => {
  const ext = trView === "text" ? "txt" : "srt";
  const files = trLangsForDownloadAll
    .map((lang) => {
      const out = extractTranslationForLang(lang);
      const content = trView === "text" ? out.text : out.srt;
      return {
        name: `${baseName}.${lang}.${ext}`,
        content,
      };
    })
    .filter((f) => String(f.content || "").trim());

  if (!files.length) return;

  await downloadAllAsZipOrBundle({
    zipName: `${baseName}.translations.${ext}.zip`,
    bundleName: `${baseName}.translations.${ext}.bundle.txt`,
    files,
  });
};

// ----------------------
// ✅ SUMMARY export
// ----------------------
const summaryTextOut = String(results?.summary || getLiveStreamFor(liveOne?.stream?.summarize) || "");
const summaryHasOut = !!summaryTextOut.trim();

const onDownloadSummary = () => {
  if (!summaryTextOut.trim()) return;
  downloadTextFile(`${baseName}.summary.txt`, summaryTextOut, "text/plain;charset=utf-8");
};

const onCopySummary = async () => {
  await copyToClipboard(summaryTextOut);
};





const inputForTrEstimate =
  (Array.isArray(mergedSegs) && mergedSegs.length ? { segments: mergedSegs } : null) ||
  (results?.transcriptSrt ? { srt: results.transcriptSrt } : null) ||
  (results?.transcript ? { text: results.transcript } : { text: segPlain });

  const missingEst = estimateTranslateTotalTokens({
  it,
  liveOne,
  tr,
  inputForEstimate: inputForTrEstimate,
  targetLangs: trMissingTargets,
});

const fullEst = estimateTranslateTotalTokens({
  it,
  liveOne,
  tr,
  inputForEstimate: inputForTrEstimate,
  targetLangs: trTargetsAll,
});

const missingNeed = missingEst.totalTokens || 0;
const fullNeed = fullEst.totalTokens || 0;

const missingAffordable = missingNeed <= 0 ? true : missingNeed <= availableUnused;
const fullAffordable = fullNeed <= 0 ? true : fullNeed <= availableUnused;

  const trPillTokens = trMissingTargets.length ? missingNeed : fullNeed;
const trPillUsed = trMissingTargets.length ? missingEst.used : fullEst.used;
const trPillAffordable = trMissingTargets.length ? missingAffordable : fullAffordable;

const trPillTitle = [
  trRoll && trRoll.total ? `Done: ${trRoll.done}/${trRoll.total}` : null,
  trTargetsAll.length ? `Targets: ${trTargetsAll.join(", ")}` : null,
  trMissingTargets.length ? `Missing: ${trMissingTargets.join(", ")}` : "Missing: none",
  trMissingTargets.length
    ? `Translate missing estimate: ~${missingNeed} tok${missingEst.usdFormatted ? ` (${missingEst.usdFormatted})` : ""} • ${missingEst.used}`
    : null,
  trTargetsAll.length
    ? `Clear & re-translate estimate: ~${fullNeed} tok${fullEst.usdFormatted ? ` (${fullEst.usdFormatted})` : ""} • ${fullEst.used}`
    : null,
  trPillTokens > 0 ? `Have unused: ${availableUnused}` : null,
].filter(Boolean).join(" • ");


const translateStream = getLiveStreamFor(liveOne?.stream?.translate, selectedTrLang);

const fallbackStream =
  tab === "transcribe"
    ? getLiveStreamFor(liveOne?.stream?.transcribe)
    : tab === "translate"
    ? translateStream
    : getLiveStreamFor(liveOne?.stream?.summarize);


const doTranslateNow = ({ clearTranslate = false } = {}) => {
  setTabByItem((p) => ({ ...(p || {}), [chatItemId]: "translate" }));


const targetsToRun = clearTranslate ? trTargetsAll : trMissingTargets;
  if (!targetsToRun.length) {
    toast.message("Nothing to translate — all selected targets already exist.");
    closeMenu();
    return;
  }
const est = estimateTranslateTotalTokens({
  it,
  liveOne,
  tr,
  inputForEstimate: inputForTrEstimate,
  targetLangs: targetsToRun,
});

const need = est ? Math.max(0, Number(est.totalTokens || 0) || 0) : 0;

if (need > 0 && need > availableUnused) {
  toast.error(
    `Not enough media tokens to translate. Need ~${need}, have ${availableUnused}. (${est.usdFormatted || ""})`
  );
  closeMenu();
  return;
}

  if (need > 0 && need > availableUnused) {
    toast.error(
      `Not enough media tokens to translate. Need ~${need}, have ${availableUnused}. (${est.usdFormatted || ""})`
    );
    closeMenu();
    return;
  }

  // ✅ Optional: optimistic reserve (so UI blocks double-clicks / parallel actions)
  // If you already have reserveMediaTokens wired (you do), reserve a unique key.
  try {
    const key = `tr:${String(thread?.id || "")}:${chatItemId}:${targetsToRun.join(",")}`;
    if (need > 0 && typeof reserveMediaTokens === "function") {
      reserveMediaTokens(key, need);
    }
  } catch {}

  retryTranslate({
    chatItemId,
    options: {
      force: true,
      clearTranslate: !!clearTranslate,
      doTranslate: true,
      translation: {
        enabled: true,
        modelId: String(trOpts?.modelId || "gpt-4o-mini"),
        sourceLang: String(trOpts?.sourceLang || "auto"),
        targetLangs: targetsToRun,
      },
    },
  });

  closeMenu();
};





        const openTranslateMenu = (e) => {
          if (!isBrowser) return;
          const el = e?.currentTarget;
          if (!el) return;

          setTrOptsByItem((p) => {
            const cur = p?.[chatItemId];
            if (cur) return p || {};
            return { ...(p || {}), [chatItemId]: trSeed };
          });

          if (isTranslateMenuOpen) {
            closeMenu();
            return;
          }

          anchorElRef.current = el;
          setOpenMenu({ chatItemId, kind: "translate" });
        };

        const doSeek = (t) => {
          const api = playerApisRef.current?.[chatItemId];
          if (api && typeof api.seek === "function") api.seek(t);
        };

        const doReTranscribe = () => {
          setTabByItem((p) => ({ ...(p || {}), [chatItemId]: "transcribe" }));
          setTransViewByItem((p) => ({ ...(p || {}), [chatItemId]: "srt" }));

          retryTranscribe({
            chatItemId,
            options: {
              force: true,
              clear: true,
              asrLang: String(opts.language || "auto") || "auto",
              asrModel: String(effectiveModelId || "deepgram_nova3") || "deepgram_nova3",
            },
          });

          closeMenu();
        };

        const isSummarizeMenuOpen = openMenu && openMenu.chatItemId === chatItemId && openMenu.kind === "summarize";

const openSummarizeMenu = (e) => {
  if (!isBrowser) return;
  const el = e?.currentTarget;
  if (!el) return;

  setSumOptsByItem((p) => {
    const cur = p?.[chatItemId];
    if (cur) return p || {};
    return { ...(p || {}), [chatItemId]: sumSeed };
  });

  if (isSummarizeMenuOpen) {
    closeMenu();
    return;
  }

  anchorElRef.current = el;
  setOpenMenu({ chatItemId, kind: "summarize" });
};

const doReSummarize = () => {
  setTabByItem((p) => ({ ...(p || {}), [chatItemId]: "summarize" }));

  const need = sumRerunTokens != null ? Math.max(0, Number(sumRerunTokens || 0) || 0) : 0;

  if (need > 0 && need > availableUnused) {
    toast.error(`Not enough media tokens to summarize. Need ~${need}, have ${availableUnused}.`);
    closeMenu();
    return;
  }
console.log("SUM CLICK", {
  chatItemId,
  sumModelId,
  sumLang,
  sumOpts: sumOptsByItem?.[chatItemId],
});
  if (typeof retrySummarize === "function") {
    retrySummarize({
      chatItemId,
      options: {
        force: true,
        clearSummary: true,
        clearSummarize: true,
        doSummarize: true,
        summarize: {
          enabled: true,
          modelId: sumModelId,
          language: sumLang,     // ✅ UI language setting
          lang: sumLang,         // ✅ extra alias (server can ignore)
        },
      },
    });
  } else {
    toast.error("Summarize action is not wired (retrySummarize missing).");
  }

  closeMenu();
};



        const outputHeaderLabel =
          tab === "transcribe" ? (transView === "srt" ? "SRT" : "Text") : tab === "translate" ? "Translation" : "Summary";

        const meta = srtMetaByItem?.[chatItemId] || {};
        const dirty = !!meta.dirty;
        const hasBadTime = !!meta.hasBadTime;

        const canReset = tab === "transcribe" && transView === "srt" && !isTranscribing && dirty;
        const canSave = tab === "transcribe" && transView === "srt" && !isTranscribing && dirty && !hasBadTime;

        const doReset = () => {
          const api = srtEditorRefsRef.current?.[chatItemId];
          if (api && typeof api.reset === "function") api.reset();
        };

        const doSave = () => {
          const api = srtEditorRefsRef.current?.[chatItemId];
          if (api && typeof api.save === "function") api.save();
        };

        const langForDir = String(trans?.language || opts?.language || seedLang || "auto") || "auto";

        const sampleForDir =
          normalizeWhitespace(
            (mergedSegs || [])
              .slice(0, 12)
              .map((s) => String(s?.text || ""))
              .join(" ")
          ) || normalizeWhitespace(showText || segPlain || fallbackStream || "");

        const textDir = dirFromLangAndSample(langForDir, sampleForDir);

        const transcriptionBody =
          transView === "srt" ? (
            <SrtModeWrap>
              <LegacySrtSegmentsEditor
                ref={(r) => {
                  if (!r) {
                    const next = { ...(srtEditorRefsRef.current || {}) };
                    delete next[chatItemId];
                    srtEditorRefsRef.current = next;
                    return;
                  }
                  srtEditorRefsRef.current = { ...(srtEditorRefsRef.current || {}), [chatItemId]: r };
                }}
                segments={mergedSegs}
                currentTime={curTime}
                onSeek={(t) => doSeek(t)}
                disabled={isTranscribing}
                maxHeight={360}
                onMeta={(m) => {
                  setSrtMetaByItem((p) => ({ ...(p || {}), [chatItemId]: m || {} }));
                }}
                onSave={({ transcriptSrt, transcriptText }) => {
                  setOptimisticSrtByItem((p) => ({ ...(p || {}), [chatItemId]: String(transcriptSrt || "") }));
                  saveSrt({ chatItemId, transcriptSrt, transcriptText });
                }}
              />

              {!mergedSegs.length && (fallbackStream || showText || segPlain) ? (
                <LiveTextHint>
                  <LiveTextTitle>Text (while SRT builds)</LiveTextTitle>
                  <LiveTextBody>{showText || segPlain || fallbackStream}</LiveTextBody>
                </LiveTextHint>
              ) : null}
            </SrtModeWrap>
          ) : mergedSegs.length ? (
            <TextSnippets aria-label="Transcript text (clickable)" dir={textDir} $dir={textDir}>
              {mergedSegs.map((seg, idx) => {
                const txt = normalizeWhitespace(seg?.text || "");
                if (!txt) return null;

                const active = isActiveAtTime(seg, curTime);
                return (
                  <Snippet
                    dir="auto"
                    key={`${segKey(seg)}|${idx}`}
                    $active={active}
                    title={`${fmtClock(seg?.start)} → ${fmtClock(seg?.end)} (click to seek)`}
                    onClick={() => doSeek(Number(seg?.start || 0))}
                  >
                    {txt}
                  </Snippet>
                );
              })}
            </TextSnippets>
          ) : (
            <Text>{showText || segPlain || fallbackStream || "—"}</Text>
          );

        let outputBody = null;

if (tab === "transcribe") {
  outputBody = transcriptionBody;
} else if (tab === "translate") {
  outputBody = selectedTrLang ? (
    trView === "srt" ? (
      <SrtModeWrap>
        <LegacySrtSegmentsEditor
          key={`${chatItemId}::${selectedTrLang}`} // ✅ reset editor when switching langs
          ref={(r) => {
            if (!r) {
              const next = { ...(trSrtEditorRefsRef.current || {}) };
              delete next[chatItemId];
              trSrtEditorRefsRef.current = next;
              return;
            }
            trSrtEditorRefsRef.current = { ...(trSrtEditorRefsRef.current || {}), [chatItemId]: r };
          }}
          segments={mergedTranslateSegs}
          currentTime={curTime}
          onSeek={(t) => doSeek(t)}
          disabled={isTranslatingLang}
          maxHeight={360}
          onMeta={(m) => {
            setTrSrtMetaByKey((p) => ({ ...(p || {}), [trMetaKey]: m || {} }));
          }}
          onSave={({ transcriptSrt, transcriptText }) => {
            const srt = String(transcriptSrt || "");
            const txt = String(transcriptText || "");

            setOptimisticTrSrtByKey((p) => ({ ...(p || {}), [trOptKey]: srt }));

            // ✅ WS save (server persists results.translations[lang])
            saveTranslationSrt({
              chatItemId,
              lang: selectedTrLang,
              translationSrt: srt,
              translationText: txt,
            });
          }}
        />

        {!mergedTranslateSegs.length && (mergedTranslateText || translateStream) ? (
          <LiveTextHint>
            <LiveTextTitle>Text (while SRT builds)</LiveTextTitle>
            <LiveTextBody>{mergedTranslateText || translateStream}</LiveTextBody>
          </LiveTextHint>
        ) : null}
      </SrtModeWrap>
    ) : mergedTranslateSegs.length ? (
      <TextSnippets
        aria-label="Translation text (clickable)"
        dir={dirFromLangAndSample(selectedTrLang, mergedTranslateText || translateStream || "")}
        $dir={dirFromLangAndSample(selectedTrLang, mergedTranslateText || translateStream || "")}
      >
        {mergedTranslateSegs.map((seg, idx) => {
          const txt = normalizeWhitespace(seg?.text || "");
          if (!txt) return null;
          const active = isActiveAtTime(seg, curTime);
          return (
            <Snippet
              dir="auto"
              key={`${segKey(seg)}|tr|${idx}`}
             $active={active}
              title={`${fmtClock(seg?.start)} → ${fmtClock(seg?.end)} (click to seek)`}
              onClick={() => doSeek(Number(seg?.start || 0))}
            >
              {txt}
            </Snippet>
          );
        })}
      </TextSnippets>
) : mergedTranslateText || translateStream ? (
  <Text>{mergedTranslateText || translateStream}</Text>
) : isTranslatingLang ? (
  <LiveTextHint>
    <LiveTextTitle>Translating…</LiveTextTitle>
    <LiveTextBody>Generating {selectedTrLang} output for this item.</LiveTextBody>
  </LiveTextHint>
) : (
  <LiveTextHint>
    <LiveTextTitle>Not translated yet</LiveTextTitle>
    <LiveTextBody>
      {selectedTrLang} is selected, but this item doesn’t have a saved translation in that language yet.
      Open the <b>TR</b> menu and click <b>Translate</b> to generate it.
      {trCompletedLangs.length ? ` (Available now: ${trCompletedLangs.join(", ")})` : ""}
    </LiveTextBody>
  </LiveTextHint>
)


  ) : (
    <Text>Select a language above to view the translated subtitles.</Text>
  );
}

 else {
  outputBody = <Text>{showText || fallbackStream || "—"}</Text>;
}


        // ✅ estimate shown next to Re-transcribe (uses current effectiveModelId)
        const rerunTokens =
          durationSeconds != null && typeof estimateTokensForSeconds === "function"
            ? Math.max(0, Number(estimateTokensForSeconds(durationSeconds, effectiveModelId, null) || 0) || 0)
            : null;

        const rerunUsd = rerunTokens != null && typeof tokensToUsd === "function" ? Number(tokensToUsd(rerunTokens) || 0) : null;

        const rerunAffordable = rerunTokens == null ? true : rerunTokens <= availableUnused;
        const canReTranscribe = canReTranscribeState && rerunAffordable;

        const rerunTitle =
          rerunTokens == null
            ? "Need duration to estimate re-transcription cost."
            : rerunAffordable
            ? [
                `Estimated re-transcribe: ~${rerunTokens} tokens`,
                rerunUsd != null ? `(~$${rerunUsd.toFixed(2)})` : null,
                durationSeconds ? `duration ${fmtClock(durationSeconds)}` : null,
                modelLabel ? `${modelLabel}` : null,
              ]
                .filter(Boolean)
                .join(" • ")
            : [
                `Not enough media tokens`,
                `need ~${rerunTokens}`,
                `have ${availableUnused} unused`,
                rerunUsd != null ? `(~$${rerunUsd.toFixed(2)})` : null,
                durationSeconds ? `duration ${fmtClock(durationSeconds)}` : null,
                modelLabel ? `${modelLabel}` : null,
              ]
                .filter(Boolean)
                .join(" • ");

        // ✅ render menu for this item?
        const shouldShowMenu = isBrowser && openMenu && openMenu.chatItemId === chatItemId && menuPos;

        return (
          <Card key={chatItemId}>
            <CardHead>
<TranslateSelectionGuard
  chatItemId={chatItemId}
  explicitLang={trLangByItem?.[chatItemId]}
  validLangs={trSelectableLangs}
  clearSelectedLang={(cid) =>
    setTrLangByItem((p) => {
      const next = { ...(p || {}) };
      delete next[String(cid)];
      return next;
    })
  }
/>



              <HeadLeft>
                <Title title={title}>{title}</Title>
                <Sub>
                  {String(media?.mime || "") || "—"}
                  {trans?.language ? ` • ${String(trans.language)}` : ""}
                  {trans?.modelId ? ` • ${String(trans.modelId)}` : ""}
                </Sub>
              </HeadLeft>

              <HeadRight>
                <StepBtn
                  type="button"
                  $tone={toneT}
                  onClick={openTranscribeMenu}
                  $open={!!isTransMenuOpen}
                  title="Transcription options"
                >
                  <Dot $tone={toneT} />
                  <StepK> T </StepK>
                  <StepV>{deriveStage(trans, "transcribe")}</StepV>

                  <CostPill $state={pillState} title={pillTitle}>
                    {displayKind === "potential" || displayKind === "client" ? "~" : ""}
                    {displayKind === "unknown" ? "—" : formatCompact(displayTokens)} tok
                    {usdApprox != null ? "" : ""}
                  </CostPill>

                  {isBusy(trans) ? <Spinner /> : null}
                  <Caret $open={!!isTransMenuOpen}>▾</Caret>
                </StepBtn>

                {/* ✅ Translation: now a dropdown button (UI-only settings) */}
               <StepBtn
                  type="button"
                  $tone={toneTR2}
                  onClick={openTranslateMenu}
                  $open={!!isTranslateMenuOpen}
                  title="Translation options"
                >
                  <Dot $tone={toneTR2} />
                  <StepK> TR </StepK>
                  <StepV>{deriveStage(trAgg, "translate")}</StepV>

                  <CostPill
                      $state={
                        isBusy(trAgg)
                          ? "pending"
                          : trPillTokens > 0
                          ? (trPillAffordable ? "idle" : "failed") // ✅ white pill (no blue)
                          : "idle"
                      }
                    title={trPillTitle}
                  >
                    {trPillTokens > 0 ? `~${formatCompact(trPillTokens)} tok` : "— tok"}
                  </CostPill>


                  {isBusy(trAgg) ? <Spinner /> : null}
                  <Caret $open={!!isTranslateMenuOpen}>▾</Caret>
                </StepBtn>


<StepBtn
  type="button"
  $tone={toneS}
  onClick={openSummarizeMenu}
  $open={!!isSummarizeMenuOpen}
  title="Summary options"
>
  <Dot $tone={toneS} />
  <StepK> S </StepK>
  <StepV>{deriveStage(sum, "summarize")}</StepV>

<CostPill
  $state={sumPillState}
  title={sumPillTitle}
>
  {sumTokens != null
    ? `${sumDisp.kind === "actual" ? "" : "~"}${formatCompact(sumTokens)} tok`
    : "— tok"}
</CostPill>


  {sumIsBusy ? <Spinner /> : null}
  <Caret $open={!!isSummarizeMenuOpen}>▾</Caret>
</StepBtn>


                {isFailed(trans) && trans?.error ? <Err title={String(trans.error)}>{String(trans.error)}</Err> : null}
              </HeadRight>
            </CardHead>

            <Grid>
              <Left>
                <ChatMediaPlayer
                  threadId={String(thread?.id || "")}
                  item={it}
                  media={media}
                  onTime={(t) => setTimeByItem((p) => ({ ...(p || {}), [chatItemId]: t }))}
                  onApi={(api) => {
                    if (!api) {
                      const next = { ...(playerApisRef.current || {}) };
                      delete next[chatItemId];
                      playerApisRef.current = next;
                      return;
                    }
                    playerApisRef.current = { ...(playerApisRef.current || {}), [chatItemId]: api };
                  }}
                />
              </Left>

              <Right>
                <Tabs>
                  <TabBtn
                    type="button"
                    $on={tab === "transcribe"}
                    onClick={() => setTabByItem((p) => ({ ...(p || {}), [chatItemId]: "transcribe" }))}
                  >
                    Transcription
                  </TabBtn>
                  <TabBtn
                    type="button"
                    $on={tab === "translate"}
                    onClick={() => setTabByItem((p) => ({ ...(p || {}), [chatItemId]: "translate" }))}
                  >
                    Translation
                  </TabBtn>
                  <TabBtn
                    type="button"
                    $on={tab === "summarize"}
                    onClick={() => setTabByItem((p) => ({ ...(p || {}), [chatItemId]: "summarize" }))}
                  >
                    Summary
                  </TabBtn>
                </Tabs>

                <Output $tight={tab === "transcribe" && transView === "srt"}>
                  <OutputHead>
                    <OutTitle>
                      {outputHeaderLabel}
{tab === "transcribe" && transView === "srt" && dirty ? <DirtyPill>unsaved</DirtyPill> : null}
{tab === "transcribe" && transView === "srt" && hasBadTime ? <BadPill>bad timecode</BadPill> : null}

{tab === "translate" && trView === "srt" && trDirty ? <DirtyPill>unsaved</DirtyPill> : null}
{tab === "translate" && trView === "srt" && trBadTime ? <BadPill>bad timecode</BadPill> : null}

                    </OutTitle>

                    {tab === "transcribe" ? (
  <HdrRight>
    <HdrActions>
      <HdrBtn
        type="button"
        onClick={onDownloadTranscribe}
        disabled={!transcribeHasOut}
        title={transView === "srt" ? "Download transcription .srt" : "Download transcription .txt"}
      >
        {transView === "srt" ? "Download SRT" : "Download TXT"}
      </HdrBtn>

      <HdrBtn
        type="button"
        onClick={onCopyTranscribe}
        disabled={!transcribeHasOut}
        title="Copy to clipboard"
      >
        Copy
      </HdrBtn>

      {transView === "srt" ? (
        <>
          <HdrBtn type="button" onClick={doReset} disabled={!canReset} title="Discard local edits">
            Reset
          </HdrBtn>
          <HdrBtn type="button" onClick={doSave} disabled={!canSave} title="Save SRT edits">
            Save
          </HdrBtn>
        </>
      ) : null}
    </HdrActions>

    <Switch>
      <SwitchBtn
        type="button"
        $on={transView === "srt"}
        onClick={() => setTransViewByItem((p) => ({ ...(p || {}), [chatItemId]: "srt" }))}
      >
        SRT
      </SwitchBtn>
      <SwitchBtn
        type="button"
        $on={transView === "text"}
        onClick={() => setTransViewByItem((p) => ({ ...(p || {}), [chatItemId]: "text" }))}
      >
        Text
      </SwitchBtn>
    </Switch>
  </HdrRight>
) : tab === "translate" ? (
  <HdrRight>
    <HdrActions>
      <HdrBtn
        type="button"
        onClick={onDownloadTranslateOne}
        disabled={!translateHasOut || !String(selectedTrLang || "").trim()}
        title={trView === "srt" ? "Download selected translation .srt" : "Download selected translation .txt"}
      >
        {trView === "srt" ? "Download SRT" : "Download TXT"}
      </HdrBtn>

      <HdrBtn
        type="button"
        onClick={onDownloadTranslateAll}
        disabled={!trLangsForDownloadAll.length}
        title={
          trView === "srt"
            ? "Download ALL translations as .srt (zip if available)"
            : "Download ALL translations as .txt (zip if available)"
        }
      >
        Download all
      </HdrBtn>

      <HdrBtn
        type="button"
        onClick={onCopyTranslate}
        disabled={!translateHasOut}
        title="Copy to clipboard"
      >
        Copy
      </HdrBtn>

      {trView === "srt" ? (
        <>
          <HdrBtn type="button" onClick={doTrReset} disabled={!canTrReset} title="Discard local translation edits">
            Reset
          </HdrBtn>
          <HdrBtn type="button" onClick={doTrSave} disabled={!canTrSave} title="Save translated SRT edits">
            Save
          </HdrBtn>
        </>
      ) : null}
    </HdrActions>

    <TranslateLangSelect
      value={selectedTrLang}
      disabled={!trSelectableLangs.length}
      onChange={(e) => {
        const v = String(e?.target?.value || "");
        setTrLangByItem((p) => ({ ...(p || {}), [chatItemId]: v }));
      }}
      title="Choose translation language"
    >
      <option value="">
        {trSelectableLangs.length ? "Select language…" : "No translation targets"}
      </option>

      {trSelectableLangs.map((l) => {
        const st = getStepForLang(tr, l);
        const stage = deriveStage(st, "translate");
        const busy = isBusy(st);

        const payload = trMap ? getByLangCI(trMap, l) : null;
        const hasOut = hasTranslationContent(payload);

        let label = l;

        if (busy) {
          label = stage && stage !== "—" ? `${l} • ${stage}` : `${l} • translating`;
        } else if (!hasOut) {
          label = `${l} • not translated`;
        } else if (stage && stage !== "—") {
          label = `${l} • ${stage}`;
        }

        return (
          <option key={l} value={l}>
            {label}
          </option>
        );
      })}
    </TranslateLangSelect>

    <Switch>
      <SwitchBtn
        type="button"
        $on={trView === "srt"}
        onClick={() => setTrViewByItem((p) => ({ ...(p || {}), [chatItemId]: "srt" }))}
      >
        SRT
      </SwitchBtn>
      <SwitchBtn
        type="button"
        $on={trView === "text"}
        onClick={() => setTrViewByItem((p) => ({ ...(p || {}), [chatItemId]: "text" }))}
      >
        Text
      </SwitchBtn>
    </Switch>
  </HdrRight>
) : (
  <HdrRight>
    <HdrActions>
      <HdrBtn
        type="button"
        onClick={onDownloadSummary}
        disabled={!summaryHasOut}
        title="Download summary .txt"
      >
        Download TXT
      </HdrBtn>

      <HdrBtn
        type="button"
        onClick={onCopySummary}
        disabled={!summaryHasOut}
        title="Copy to clipboard"
      >
        Copy
      </HdrBtn>
    </HdrActions>
  </HdrRight>
)}


                  </OutputHead>

                  <OutputBody>{outputBody}</OutputBody>
                </Output>
              </Right>
            </Grid>

            {shouldShowMenu
              ? createPortal(
                  openMenu.kind === "transcribe" ? (
                    <Menu
                      ref={menuElRef}
                      style={{
                        position: "fixed",
                        top: menuPos.top,
                        left: menuPos.left,
                        width: menuPos.width,
                        maxHeight: `calc(100vh - ${Math.max(12, menuPos.top)}px - 12px)`,
                        overflow: "auto",
                      }}
                      role="dialog"
                      aria-label="Transcription options"
                    >
                      <MenuTop>
                        <MenuTitle>Transcription</MenuTitle>
                        <MenuStatus>
                          <Dot $tone={toneT} />
                          <MenuStatusText>{deriveStage(trans, "transcribe")}</MenuStatusText>
                        </MenuStatus>
                      </MenuTop>

                      <MenuRow>
                        <MenuAction
                          type="button"
                          onClick={doReTranscribe}
                          disabled={!canReTranscribe}
                          title={
                            isTranscribing
                              ? "Transcription is running"
                              : !rerunAffordable
                              ? `Not enough media tokens (need ~${rerunTokens}, have ${availableUnused} unused)`
                              : "Retry / re-run with these settings"
                          }
                        >
                          Re-transcribe
                        </MenuAction>

                        <MenuEstimatePill
                          $state={rerunTokens == null ? "unknown" : rerunAffordable ? "potential" : "failed"}
                          title={rerunTitle}
                        >
                          {rerunTokens == null ? "—" : "~" + formatCompact(rerunTokens)} tok
                        </MenuEstimatePill>
                      </MenuRow>



                      <MenuDivider />

                      <MenuField>
                        <MenuLabel>Language</MenuLabel>

                        {languageOptions.length ? (
                          <MenuSelect
                            value={String(opts.language || "auto")}
                            onChange={(e) => {
                              const nextLang = String(e?.target?.value || "auto") || "auto";

                              const models =
                                typeof getModelsForLanguage === "function" ? safeArr(getModelsForLanguage(nextLang)) : [];

                              const curModel = String((transOptsByItem?.[chatItemId]?.modelId || opts.modelId) || "");
                              const ok = models.some((m) => String(m?.id || "") === curModel);
                              const nextModel = ok ? curModel : String(models?.[0]?.id || pickDefaultModelIdForLang(nextLang));

                              setTransOptsByItem((p) => ({
                                ...(p || {}),
                                [chatItemId]: { ...(p?.[chatItemId] || {}), language: nextLang, modelId: nextModel },
                              }));
                            }}
                          >
                            {languageOptions.map((l) => (
                              <option key={String(l.value)} value={String(l.value)}>
                                {String(l.label || l.value)}
                              </option>
                            ))}
                          </MenuSelect>
                        ) : (
                          <MenuInput
                            value={String(opts.language || "")}
                            onChange={(e) => {
                              const v = e?.target?.value;
                              setTransOptsByItem((p) => ({
                                ...(p || {}),
                                [chatItemId]: { ...(p?.[chatItemId] || {}), language: String(v || "") },
                              }));
                            }}
                            placeholder="e.g. auto, en, en-GB, ar..."
                          />
                        )}
                      </MenuField>

                      <MenuField>
                        <MenuLabel>Model</MenuLabel>

                        {modelsForLang.length ? (
                          <MenuSelect
                            value={String(effectiveModelId || "")}
                            onChange={(e) => {
                              const v = String(e?.target?.value || "");
                              setTransOptsByItem((p) => ({
                                ...(p || {}),
                                [chatItemId]: { ...(p?.[chatItemId] || {}), modelId: String(v || "") },
                              }));
                            }}
                          >
                            {modelsForLang.map((m) => (
                              <option key={String(m.id)} value={String(m.id)}>
                                {String(m.label || m.id)}
                              </option>
                            ))}
                          </MenuSelect>
                        ) : (
                          <MenuInput
                            value={String(opts.modelId || "")}
                            onChange={(e) => {
                              const v = e?.target?.value;
                              setTransOptsByItem((p) => ({
                                ...(p || {}),
                                [chatItemId]: { ...(p?.[chatItemId] || {}), modelId: String(v || "") },
                              }));
                            }}
                            placeholder="e.g. deepgram_nova3..."
                          />
                        )}
                      </MenuField>

                      <MenuNote>
                        Re-transcribe will retry if it failed/queued, or re-run after done — always using the language/model selected above.
                      </MenuNote>
                    </Menu>
                  ) : openMenu.kind === "translate" ? (
  <Menu
    ref={menuElRef}
    style={{
      position: "fixed",
      top: menuPos.top,
      left: menuPos.left,
      width: menuPos.width,
      maxHeight: `calc(100vh - ${Math.max(12, menuPos.top)}px - 12px)`,
      overflow: "auto",
    }}
    role="dialog"
    aria-label="Translation options"
  >
    <MenuTop>
      <MenuTitle>Translation</MenuTitle>
      <MenuStatus>
        <Dot $tone={toneTR2} />
        <MenuStatusText>{deriveStage(trAgg, "translate")}</MenuStatusText>
      </MenuStatus>
    </MenuTop>

    {/* ✅ ACTIONS + PER-TARGET LIST (PASTE THIS HERE) */}
 {/* Row 1: Translate missing */}
<MenuRow>
  <MenuAction
    type="button"
    onClick={() => doTranslateNow({ clearTranslate: false })}
    disabled={isBusy(trAgg) || !trTargetsAll.length || !trMissingTargets.length || !missingAffordable}
    title={
      !trTargetsAll.length
        ? "Select at least one target language"
        : !trMissingTargets.length
        ? "All selected targets are already translated"
        : isBusy(trAgg)
        ? "Translation is running"
        : !missingAffordable
        ? `Not enough media tokens (need ~${missingNeed}, have ${availableUnused})`
        : `Translate missing: ${trMissingTargets.join(", ")} • ${translateSummaryTitle}`
    }
  >
    {String(trAgg?.state || "") === "failed" ? "Retry translate" : `Translate (${trMissingTargets.length || 0})`}
  </MenuAction>

  <MenuEstimatePill
    $state={
      missingNeed > 0
        ? (missingAffordable ? "potential" : "failed")
        : "unknown"
    }
    title={
      missingNeed > 0
        ? [
            `Translate missing estimate: ~${missingNeed} tokens`,
            missingEst.usdFormatted ? missingEst.usdFormatted : null,
            `Used: ${missingEst.used}`,
            `Have unused: ${availableUnused}`,
          ].filter(Boolean).join(" • ")
        : "No estimate yet"
    }
  >
    {missingNeed > 0 ? `~${formatCompact(missingNeed)} tok` : "—"}
  </MenuEstimatePill>
</MenuRow>

{/* Row 2: Clear & re-translate */}
<MenuRow style={{ marginTop: 8 }}>
  <MenuAction
    type="button"
    onClick={() => doTranslateNow({ clearTranslate: true })}
    disabled={isBusy(trAgg) || !trTargetsAll.length || !fullAffordable}
    title={
      !trTargetsAll.length
        ? "Select at least one target language"
        : isBusy(trAgg)
        ? "Translation is running"
        : !fullAffordable
        ? `Not enough media tokens (need ~${fullNeed}, have ${availableUnused})`
        : `Clear & re-translate: ${trTargetsAll.join(", ")} • ${translateSummaryTitle}`
    }
  >
    Clear & re-translate
  </MenuAction>

  <MenuEstimatePill
    $state={
      fullNeed > 0
        ? (fullAffordable ? "potential" : "failed")
        : "unknown"
    }
    title={
      fullNeed > 0
        ? [
            `Clear & re-translate estimate: ~${fullNeed} tokens`,
            fullEst.usdFormatted ? fullEst.usdFormatted : null,
            `Used: ${fullEst.used}`,
            `Have unused: ${availableUnused}`,
          ].filter(Boolean).join(" • ")
        : "No estimate yet"
    }
  >
    {fullNeed > 0 ? `~${formatCompact(fullNeed)} tok` : "—"}
  </MenuEstimatePill>
</MenuRow>

<MenuDivider />



                      <MenuField>
                        <MenuLabel>Source</MenuLabel>
                        <MenuSelect
                          value={String(trOpts.sourceLang || "auto")}
                          onChange={(e) => {
                            const v = String(e?.target?.value || "auto") || "auto";
                            setTrOptsByItem((p) => ({
                              ...(p || {}),
                              [chatItemId]: { ...(p?.[chatItemId] || trSeed), sourceLang: v },
                            }));
                          }}
                        >
                          {(trSourceLangOptions.length ? trSourceLangOptions : [{ value: "auto", label: "Auto-detect" }]).map(
                            (l) => (
                              <option key={String(l.value)} value={String(l.value)}>
                                {String(l.label || l.value)}
                              </option>
                            )
                          )}
                        </MenuSelect>
                      </MenuField>

<MenuField>
  <MenuLabel>Targets</MenuLabel>

  <MultiLangSelect
    value={trTargets}
    options={(trTargetLangOptions.length ? trTargetLangOptions : [{ value: "en", label: "English" }])}
    placeholder="Select target languages…"
    onChange={(next) => {
      const targets = uniq(next);
      setTrOptsByItem((p) => ({
        ...(p || {}),
        [chatItemId]: {
          ...(p?.[chatItemId] || trSeed),
          targetLangs: targets,
          targetLang: targets[0] || "en", // keep single target in sync
        },
      }));
    }}
  />
</MenuField>


                      <MenuField>
                        <MenuLabel>Model</MenuLabel>
                        <MenuSelect
                          value={String(trOpts.modelId || "gpt-4o-mini")}
                          onChange={(e) => {
                            const v = String(e?.target?.value || "gpt-4o-mini") || "gpt-4o-mini";
                            setTrOptsByItem((p) => ({
                              ...(p || {}),
                              [chatItemId]: { ...(p?.[chatItemId] || trSeed), modelId: v },
                            }));
                          }}
                        >
                          {(trModelOptions.length ? trModelOptions : [{ id: "gpt-4o-mini", label: "GPT-4o mini" }]).map((m) => (
                            <option key={String(m.id)} value={String(m.id)}>
                              {String(m.label || m.id)}
                            </option>
                          ))}
                        </MenuSelect>
                      </MenuField>

                      <MenuNote>Translate runs for this chat item only, using the settings above.</MenuNote>

                    </Menu>
                  ) : (
  /* ✅ NEW summarize menu */
  <Menu
    ref={menuElRef}
    style={{
      position: "fixed",
      top: menuPos.top,
      left: menuPos.left,
      width: menuPos.width,
      maxHeight: `calc(100vh - ${Math.max(12, menuPos.top)}px - 12px)`,
      overflow: "auto",
    }}
    role="dialog"
    aria-label="Summary options"
  >
    <MenuTop>
      <MenuTitle>Summary</MenuTitle>
      <MenuStatus>
        <Dot $tone={toneS} />
        <MenuStatusText>{deriveStage(sum, "summarize")}</MenuStatusText>
      </MenuStatus>
    </MenuTop>

   <MenuRow>
  <MenuAction
    type="button"
    onClick={doReSummarize}
    disabled={sumIsBusy || !sumRerunAffordable}
    title={
      sumIsBusy
        ? "Summarization is running"
        : !sumRerunAffordable
        ? `Not enough media tokens (need ~${sumRerunTokens}, have ${availableUnused})`
        : `Re-summarize using ${sumModelId} • ${sumLang}`
    }
  >
    {String(sum?.state || "") === "failed" ? "Retry summarize" : "Re-summarize"}
  </MenuAction>

  <MenuEstimatePill
    $state={sumRerunTokens == null ? "unknown" : sumRerunAffordable ? "potential" : "failed"}
    title={
      sumRerunTokens == null
        ? "No estimate yet"
        : [
            `Estimated re-summarize: ~${sumRerunTokens} tokens`,
            sumRerunUsd != null ? `(~$${sumRerunUsd.toFixed(2)})` : null,
            `Have unused: ${availableUnused}`,
            `Lang: ${sumLang}`,
            `Model: ${sumModelId}`,
          ]
            .filter(Boolean)
            .join(" • ")
    }
  >
    {sumRerunTokens == null ? "—" : `~${formatCompact(sumRerunTokens)} tok`}
  </MenuEstimatePill>
</MenuRow>


    <MenuDivider />

    <MenuField>
      <MenuLabel>Model</MenuLabel>
      <MenuSelect
        value={String(sumModelId)}
        onChange={(e) => {
          const v = String(e?.target?.value || "gpt-4o-mini") || "gpt-4o-mini";
          setSumOptsByItem((p) => ({
            ...(p || {}),
            [chatItemId]: { ...(p?.[chatItemId] || sumSeed), modelId: v },
          }));
        }}
      >
        {(trModelOptions.length ? trModelOptions : [{ id: "gpt-4o-mini", label: "GPT-4o mini" }]).map((m) => (
          <option key={String(m.id)} value={String(m.id)}>
            {String(m.label || m.id)}
          </option>
        ))}
      </MenuSelect>
    </MenuField>
    <MenuDivider />

<MenuField>
  <MenuLabel>Language</MenuLabel>

  {languageOptions.length ? (
    <MenuSelect
      value={String(sumLang || "auto")}
      onChange={(e) => {
        const v = String(e?.target?.value || "auto") || "auto";
        setSumOptsByItem((p) => ({
          ...(p || {}),
          [chatItemId]: { ...(p?.[chatItemId] || sumSeed), language: v },
        }));
      }}
    >
      {languageOptions.map((l) => (
        <option key={String(l.value)} value={String(l.value)}>
          {String(l.label || l.value)}
        </option>
      ))}
    </MenuSelect>
  ) : (
    <MenuInput
      value={String(sumLang || "")}
      onChange={(e) => {
        const v = e?.target?.value;
        setSumOptsByItem((p) => ({
          ...(p || {}),
          [chatItemId]: { ...(p?.[chatItemId] || sumSeed), language: String(v || "") },
        }));
      }}
      placeholder="e.g. auto, en, en-GB, ar..."
    />
  )}
</MenuField>


<MenuNote>
  Re-summarize runs for this chat item only, using the language/model above. Cost shown is an estimate unless actual tokens are present.
</MenuNote>
  </Menu>
),
                  document.body
                )
              : null}
          </Card>
        );
      })}
    </List>
  );
}

// styles unchanged except CostPill adds a new state "potential"
const List = styled.div`
  display: flex;
  flex-direction: column;
  gap: 14px;
`;

const Card = styled.div`
  border: 1px solid var(--border);
  background: var(--panel);
  border-radius: 18px;
  box-shadow: var(--shadow);
  overflow: hidden;
`;

const CardHead = styled.div`
  padding: 14px 14px 10px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  min-width: 0;

    @media (max-width: 786px) {
    gap: 9px;
    padding: 12px 12px 6px;
  }

  /* Mobile: stack title above, pills row below */
  @media (max-width: 520px) {
    flex-direction: column;
    align-items: stretch;
    gap: 9px;
  }
`;

const HeadRight = styled.div`
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;

  min-width: 0;

  /* Mobile: NEVER wrap pills; scroll horizontally if needed */
  @media (max-width: 520px) {
    width: 100%;
    flex-wrap: nowrap;
    overflow-x: auto;
    overflow-y: hidden;
    -webkit-overflow-scrolling: touch;

    padding-bottom: 2px;   /* avoid scrollbar clipping */
    margin-bottom: -2px;

    scrollbar-width: none; /* Firefox */
    &::-webkit-scrollbar {
      display: none;        /* iOS/Chrome */
    }
  }
`;


const HeadLeft = styled.div`
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
`;

const Title = styled.div`
  font-weight: 950;
  color: var(--text);
  font-size: 13px;
  max-width: 560px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  @media(max-width: 786px) {
    font-size: 12px;
  }
`;

const Sub = styled.div`
  font-size: 12px;
  color: var(--muted);
  font-weight: 800;
  @media(max-width: 786px) {
    font-size: 11px;
  }
`;



const StepBase = styled.div`
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 7px 10px;
  font-size: 11px;
  color: var(--text);
  font-weight: 950;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: rgba(0, 0, 0, 0.02);
`;

const StepPill = styled(StepBase)`
  user-select: none;
`;



const Dot = styled.span`
  width: 10px;
  height: 10px;
  border-radius: 999px;
  display: inline-block;
  box-shadow: 0 0 0 3px rgba(0, 0, 0, 0.03) inset;

  background: ${(p) =>
    p.$tone === "done"
      ? "rgba(46, 204, 113, 0.95)"
      : p.$tone === "failed"
      ? "rgba(239, 68, 68, 0.95)"
      : p.$tone === "running"
      ? "rgba(52, 152, 219, 0.95)"
      : p.$tone === "queued"
      ? "rgba(245, 158, 11, 0.95)"
      : p.$tone === "blocked"
      ? "rgba(148, 163, 184, 0.95)"
      : "rgba(148, 163, 184, 0.8)"};
`;

const StepK = styled.span`
  font-weight: 1000;
  letter-spacing: 0.2px;
  @media(max-width: 786px){
    font-size: 0.6rem;
  }
`;


const Caret = styled.span`
  font-size: 12px;
  opacity: 0.8;
  transform: ${(p) => (p.$open ? "rotate(180deg)" : "rotate(0deg)")};
  transition: transform 0.12s ease;
`;

const Err = styled.div`
  font-size: 11px;
  font-weight: 900;
  color: var(--accent);
  max-width: 360px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const Spinner = styled.span`
  width: 12px;
  height: 12px;
  border: 2px solid #999;
  border-bottom-color: transparent;
  border-radius: 50%;
  display: inline-block;
  animation: spin 0.6s linear infinite;

  @keyframes spin {
    0% {
      transform: rotate(0deg);
    }
    100% {
      transform: rotate(360deg);
    }
  }
`;

const Grid = styled.div`
  display: grid;
  grid-template-columns: 420px 1fr;
  gap: 14px;
  padding: 14px;

  @media (max-width: 786px) {
    gap: 8px;
    padding: 7px 9px 6px 9px;
  }

  @media (max-width: 980px) {
    grid-template-columns: 1fr;
  }
`;

const Left = styled.div`
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;

    @media (max-width: 786px) {
    gap: 10px;
  }
`;

const Right = styled.div`
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  @media (max-width: 786px) {
    gap: 10px;
  }
`;

const Tabs = styled.div`
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
`;

const TabBtn = styled.button`
  border-radius: 999px;
  border: 1px solid ${(p) => (p.$on ? "rgba(239,68,68,0.28)" : "var(--border)")};
  background: ${(p) => (p.$on ? "rgba(239,68,68,0.10)" : "var(--panel)")};
  color: ${(p) => (p.$on ? "var(--accent)" : "var(--text)")};
  font-weight: 950;
  font-size: 12px;
  padding: 8px 12px;
  cursor: pointer;

  &:hover {
    background: ${(p) => (p.$on ? "rgba(239,68,68,0.12)" : "var(--hover)")};
  }

  @media(max-width: 786px){
  font-size: 11px;
  padding: 6px 8px;
  }
`;

const Output = styled.div`
  border: 1px solid var(--border);
  border-radius: 14px;
  background: rgba(0, 0, 0, 0.02);
  padding: ${(p) => (p.$tight ? "8px 10px 10px" : "10px 12px 12px")};

    @media(max-width: 786px){
  padding: ${(p) => (p.$tight ? "6px 10px 8px" : "8px 10px 10px")};
    
  }
`;

const OutputHead = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;

  @media(max-width: 786px){
  margin-bottom: 5px;
  }
`;

const OutTitle = styled.div`
  font-size: 12px;
  font-weight: 950;
  color: var(--text);
  display: inline-flex;
  align-items: center;
  gap: 8px;
`;

const DirtyPill = styled.span`
  font-size: 10.5px;
  font-weight: 900;
  color: var(--accent);
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.22);
  padding: 2px 7px;
  border-radius: 999px;
`;

const BadPill = styled.span`
  font-size: 10.5px;
  font-weight: 900;
  color: rgba(239, 68, 68, 0.95);
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.22);
  padding: 2px 7px;
  border-radius: 999px;
`;

const HdrRight = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 10px;
  @media(max-width: 786px){
  gap: 4px;
  }
`;

const HdrActions = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 8px;
    @media(max-width: 786px){
  gap: 4px;
  }
`;

const HdrBtn = styled.button`
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
  font-weight: 950;
  font-size: 11px;
  padding: 7px 10px;
  cursor: pointer;

    @media(max-width: 786px){
    padding: 5px 7px;
    font-size: 11px;
  }

  &:hover {
    background: var(--hover);
  }

  &:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
`;

const OutputBody = styled.div`
  min-height: 44px;
`;

const Text = styled.pre`
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  color: var(--text);
  line-height: 1.45;
`;

const Switch = styled.div`
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--panel);
  padding: 3px;
  display: inline-flex;
  gap: 4px;
`;

const SwitchBtn = styled.button`
  border: 0;
  border-radius: 999px;
  padding: 6px 10px;
  font-weight: 950;
  font-size: 12px;
  cursor: pointer;
  background: ${(p) => (p.$on ? "rgba(239,68,68,0.10)" : "transparent")};
  color: ${(p) => (p.$on ? "var(--accent)" : "var(--text)")};

  &:hover {
    background: ${(p) => (p.$on ? "rgba(239,68,68,0.12)" : "rgba(0,0,0,0.04)")};
  }
`;

const SrtModeWrap = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
  @media(max-width: 786px){
  gap: 4px;
  }
`;

const LiveTextHint = styled.div`
  border: 1px dashed var(--border);
  border-radius: 12px;
  padding: 10px;
  background: rgba(0, 0, 0, 0.02);
`;

const LiveTextTitle = styled.div`
  font-size: 11px;
  font-weight: 950;
  color: var(--muted);
  margin-bottom: 6px;
`;

const LiveTextBody = styled.div`
  font-size: 12px;
  color: var(--text);
  line-height: 1.45;
  white-space: pre-wrap;
`;

const TextSnippets = styled.div`
  font-size: 15px;
  color: var(--text);
  line-height: 1.6;
  display: flex;
  flex-wrap: wrap;
  gap: 1px 2px;
  direction: ${(p) => (p.$dir === "rtl" ? "rtl" : "ltr")} !important;
  text-align: ${(p) => (p.$dir === "rtl" ? "right" : "left")} !important;
  unicode-bidi: isolate;
`;

const Snippet = styled.span`
  display: inline-flex;
  align-items: center;
  margin: 0;
  padding: 0px 2px;
  border-radius: 8px;
  border: 1px solid ${(p) => (p.$active ? "rgba(239,68,68,0.22)" : "transparent")};
  background: ${(p) => (p.$active ? "rgba(239,68,68,0.12)" : "transparent")};
  cursor: pointer;
  user-select: none;
  unicode-bidi: plaintext;

  &:hover {
    background: ${(p) => (p.$active ? "rgba(239,68,68,0.14)" : "rgba(0,0,0,0.04)")};
    border-color: ${(p) => (p.$active ? "rgba(239,68,68,0.26)" : "rgba(0,0,0,0.10)")};
  }
`;

const EmptyCard = styled.div`
  border: 1px solid var(--border);
  background: var(--panel);
  border-radius: 16px;
  padding: 14px;
  box-shadow: var(--shadow);
`;

const EmptyTitle = styled.div`
  font-weight: 950;
  color: var(--text);
`;

const EmptySub = styled.div`
  margin-top: 4px;
  font-size: 12px;
  color: var(--muted);
`;

const Menu = styled.div`
  border: 1px solid var(--border);
  background: var(--panel);
  border-radius: 14px;
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.16);
  padding: 10px;
  z-index: 9999;
`;

const MenuTop = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
`;

const MenuTitle = styled.div`
  font-size: 16px;
  font-weight: 1000;
  color: var(--text);
`;

const MenuStatus = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 5px 9px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: rgba(0, 0, 0, 0.02);
`;

const MenuStatusText = styled.div`
  font-size: 11px;
  font-weight: 950;
  color: var(--text);
`;

const MenuRow = styled.div`
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
`;

const MenuAction = styled.button`
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
  font-weight: 950;
  font-size: 12px;
  padding: 9px 12px;
  cursor: pointer;

  &:hover {
    background: var(--hover);
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

const MenuDivider = styled.div`
  height: 1px;
  background: var(--border);
  margin: 10px 0;
`;

const MenuField = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
`;

const MenuLabel = styled.div`
  font-size: 11px;
  font-weight: 950;
  color: var(--muted);
`;

const MenuInput = styled.input`
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 9px 10px;
  font-size: 12px;
  font-weight: 900;
  background: rgba(0, 0, 0, 0.02);
  color: var(--text);
  outline: none;

  &:focus {
    border-color: rgba(239, 68, 68, 0.35);
    box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.08);
    background: rgba(0, 0, 0, 0.01);
  }
`;

const MenuSelect = styled.select`
  height: 38px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: #fff;
  color: var(--text);
  padding: 0 10px;
  outline: none;
  font-weight: 900;
  font-size: 12px;

  &:focus {
    border-color: rgba(239, 68, 68, 0.35);
    box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.1);
  }
`;

const MenuNote = styled.div`
  font-size: 10.5px;
  color: var(--muted);
  font-weight: 800;
  line-height: 1.35;
`;

const StepBtn = styled.button`
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 7px 10px;
  font-size: 11px;
  color: var(--text);
  font-weight: 950;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: rgba(0, 0, 0, 0.02);
  cursor: pointer;

  flex: 0 0 auto;       /* ✅ don't shrink into wrap behavior */
  white-space: nowrap;  /* ✅ keep contents on one line */

  &:hover {
    background: rgba(0, 0, 0, 0.04);
  }
  &:active {
    background: rgba(0, 0, 0, 0.05);
  }

  box-shadow: ${(p) => (p.$open ? "0 0 0 3px rgba(0,0,0,0.04)" : "none")};

  @media (max-width: 786px) {
    padding: 5px 7px;
    gap: 4px;
    font-size: 10.5px;
  }
`;

const StepV = styled.span`
  font-weight: 950;
  opacity: 0.95;

  /* ✅ prevent long stages like TRANSLATING from blowing up width */
  max-width: 86px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  @media (max-width: 786px) {
    max-width: 46px;
    font-size: 0.6rem;
  }
`;

const CostPill = styled.span`
  font-size: 10px;
  font-weight: 950;
  padding: 2px 7px;
  border-radius: 999px;
  white-space: nowrap;

  /* ✅ helps a lot on mobile */
  max-width: 86px;
  overflow: hidden;
  text-overflow: ellipsis;

  border: 1px solid
    ${(p) =>
      p.$state === "failed"
        ? "rgba(239,68,68,0.30)"
        : p.$state === "pending"
        ? "rgba(245,158,11,0.30)"
        : p.$state === "potential"
        ? "rgba(59,130,246,0.35)"
        : "rgba(0,0,0,0.10)"};

  background:
    ${(p) =>
      p.$state === "failed"
        ? "rgba(239,68,68,0.10)"
        : p.$state === "pending"
        ? "rgba(245,158,11,0.10)"
        : p.$state === "potential"
        ? "rgba(59,130,246,0.10)"
        : "rgba(255,255,255,0.55)"};

  color:
    ${(p) =>
      p.$state === "failed"
        ? "rgba(239,68,68,0.95)"
        : p.$state === "pending"
        ? "rgba(245,158,11,0.95)"
        : p.$state === "potential"
        ? "rgba(59,130,246,1)"
        : "var(--text)"};

  backdrop-filter: blur(7px);

  @media (max-width: 786px) {
    max-width: 64px;
    padding: 2px 5px;
    font-size: 8px;
  }
`;


const MenuEstimatePill = styled(CostPill)`
  font-size: 11px;
  padding: 6px 10px;
`;


const TL_MultiWrap = styled.div`
  position: relative;

  /* ✅ “increase height by ~100” so dropdown isn't clipped by Menu overflow */
  margin-bottom: ${(p) => (p.$open ? "110px" : "0")};
`;

const TL_MultiBtn = styled.button`
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

const TL_MultiBtnText = styled.span`
  font-weight: 900;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const TL_MultiCaret = styled.span`
  font-size: 12px;
  opacity: 0.75;
  transform: ${(p) => (p.$open ? "rotate(180deg)" : "rotate(0deg)")};
  transition: transform 0.12s ease;
`;

const TL_MultiMenu = styled.div`
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

const TL_MultiSearch = styled.input`
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

const TL_MultiTopbar = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  background: rgba(0, 0, 0, 0.01);
`;

const TL_MultiCount = styled.div`
  font-size: 11px;
  font-weight: 900;
  color: var(--muted);

  b {
    color: var(--text);
    font-weight: 1000;
  }
`;

const TL_MultiTopActions = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 10px;
`;

const TL_MultiList = styled.div`
  max-height: 320px;
  overflow: auto;
  padding: 6px;
`;

const TL_MultiItem = styled.button`
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

const TL_MultiCheck = styled.span`
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

const TL_MultiFooter = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border-top: 1px solid var(--border);
  background: rgba(0, 0, 0, 0.01);
`;

const TL_MultiLink = styled.button`
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

const TL_MultiPreview = styled.div`
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
`;

const TL_MultiPreviewMuted = styled.div`
  margin-top: 6px;
  font-size: 11px;
  font-weight: 800;
  color: var(--muted);
`;

const TL_MultiChip = styled.span`
  font-size: 11px;
  font-weight: 950;
  color: var(--text);
  padding: 3px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: rgba(0, 0, 0, 0.02);
  white-space: nowrap;
`;

const TL_MultiMore = styled.span`
  font-size: 11px;
  font-weight: 950;
  color: var(--muted);
  padding: 3px 6px;
`;

const TranslateLangSelect = styled.select`
  height: 34px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
  padding: 0 10px;
  outline: none;
  font-weight: 900;
  font-size: 12px;

  &:disabled {
    opacity: 0.55;
  }

  &:focus {
    border-color: rgba(239, 68, 68, 0.35);
    box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.1);
  }
`;