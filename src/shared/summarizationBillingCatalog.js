// shared/summarizationBillingCatalog.js
// ✅ JS-only. Safe in BOTH browser + Node.
// ✅ Deterministic estimation for summarization runs.
// ✅ Uses outputRatio = 1.1 (per your request)

const BillingImport = require("./billingCatalog");
const Billing = (BillingImport && (BillingImport.default || BillingImport)) || {};

// Same pricing assumptions as translationBillingCatalog (easy to change later)
const BASE_USD_CENTS_PER_1M_TOKENS = 200; // $2.00 => 200 cents
const MARKUP_X = 20;
const EFFECTIVE_USD_CENTS_PER_1M_TOKENS = BASE_USD_CENTS_PER_1M_TOKENS * MARKUP_X; // 4000 cents => $40

const EST_DEFAULTS = Object.freeze({
  charsPerToken: 4,
  promptOverheadTokens: 160,
  outputRatio: 1.1, // ✅ requested
  // ✅ NEW: duration -> text heuristics (deterministic), same concept as translationBillingCatalog
  // Typical speech ~130–170 wpm. Choose a stable default.
  wordsPerMinute: 150,
  // Rough chars per word (Latin-ish). Includes spaces/punct-ish.
  charsPerWord: 5.0,
});

function toInt(n, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.trunc(x);
}

function ceilDiv(a, b) {
  const x = toInt(a, 0);
  const y = toInt(b, 1);
  if (y <= 0) return 0;
  if (x <= 0) return 0;
  return Math.floor((x + y - 1) / y);
}

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.min(max, Math.max(min, x));
}

function safeStr(x) {
  return String(x == null ? "" : x);
}


 
// --------------------
// Duration -> token estimation (LLM tokens)
// --------------------
function approxTokensFromDurationSeconds(durationSeconds, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const sec = Number(durationSeconds);
  if (!Number.isFinite(sec) || sec <= 0) return 0;

  const wpm = Math.max(60, toInt(o.wordsPerMinute, EST_DEFAULTS.wordsPerMinute) || EST_DEFAULTS.wordsPerMinute);
  const cpw = clamp(
    o.charsPerWord != null ? Number(o.charsPerWord) : EST_DEFAULTS.charsPerWord,
    2.5,
    10.0
  );

  const cpt = Math.max(1, toInt(o.charsPerToken, EST_DEFAULTS.charsPerToken) || EST_DEFAULTS.charsPerToken);

  // words = seconds * (wpm / 60)
  const words = sec * (wpm / 60);
  const chars = Math.max(0, Math.round(words * cpw));
  if (chars <= 0) return 0;

  // ceil(chars / charsPerToken)
  return ceilDiv(chars, cpt);
}

function normalizeWhitespace(t) {
  return safeStr(t).replace(/\s+/g, " ").trim();
}

function segmentsToPlainText(segments) {
  const segs = Array.isArray(segments) ? segments : [];
  return normalizeWhitespace(
    segs
      .map((s) => normalizeWhitespace(s && s.text != null ? s.text : ""))
      .filter(Boolean)
      .join(" ")
  );
}

function srtToPlainText(srt) {
  const raw = safeStr(srt).replace(/\r\n/g, "\n");
  if (!raw.trim()) return "";

  const lines = raw.split("\n");
  const out = [];

  for (const line of lines) {
    const l = line.trim();
    if (!l) continue;
    if (/^\d+$/.test(l)) continue;
    if (/^\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}/.test(l)) continue;
    out.push(l);
  }

  return normalizeWhitespace(out.join(" "));
}

// Accepts:
// - string (text)
// - { text }
// - { srt }
// - { segments: [] }
// - segments[] directly
function inputToText(input) {
  if (!input) return "";
  if (typeof input === "string") return normalizeWhitespace(input);
  if (Array.isArray(input)) return segmentsToPlainText(input);

  if (typeof input === "object") {
    if (Array.isArray(input.segments)) return segmentsToPlainText(input.segments);
    if (typeof input.srt === "string") return srtToPlainText(input.srt);
    if (typeof input.text === "string") return normalizeWhitespace(input.text);
  }
  return "";
}

function approxTokensFromText(text, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const cpt = Math.max(1, toInt(o.charsPerToken, EST_DEFAULTS.charsPerToken) || EST_DEFAULTS.charsPerToken);

  const t = safeStr(text);
  const chars = t.length;
  if (chars <= 0) return 0;

  return ceilDiv(chars, cpt);
}

function estimateSummarizationLlmTokens(input, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const text = inputToText(input);
  const baseInputTokens = approxTokensFromText(text, o);

  const promptOverhead = Math.max(0, toInt(o.promptOverheadTokens, EST_DEFAULTS.promptOverheadTokens) || 0);
  const outputRatio = clamp(
    o.outputRatio != null ? Number(o.outputRatio) : EST_DEFAULTS.outputRatio,
    0.1,
    3.0
  );

  if ((baseInputTokens + promptOverhead) <= 0) {
    return {
      inputTokensTotal: 0,
      outputTokensTotal: 0,
      billableTokensTotal: 0,
      _debug: { baseInputTokens, promptOverhead, outputRatio },
    };
  }

  const inputTokensTotal = baseInputTokens + promptOverhead;
  const outputTokensTotal = Math.max(0, Math.ceil(baseInputTokens * outputRatio));

  return {
    inputTokensTotal,
    outputTokensTotal,
    billableTokensTotal: inputTokensTotal + outputTokensTotal,
    _debug: { baseInputTokens, promptOverhead, outputRatio },
  };
}

// ✅ Estimate summarization tokens from either transcript-like input OR duration.
// If input has no usable text, duration is used as fallback.
function estimateSummarizationLlmTokensWithDurationFallback(input, durationSeconds, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const text = inputToText(input);
  const hasText = !!String(text || "").trim();

  if (hasText) return estimateSummarizationLlmTokens({ text }, o);

  const baseInputTokens = approxTokensFromDurationSeconds(durationSeconds, o);

  const promptOverhead = Math.max(0, toInt(o.promptOverheadTokens, EST_DEFAULTS.promptOverheadTokens) || 0);
  const outputRatio = clamp(
    o.outputRatio != null ? Number(o.outputRatio) : EST_DEFAULTS.outputRatio,
    0.1,
    3.0
  );

  if ((baseInputTokens + promptOverhead) <= 0) {
    return {
      inputTokensTotal: 0,
      outputTokensTotal: 0,
      billableTokensTotal: 0,
      _debug: { baseInputTokens, promptOverhead, outputRatio, used: "duration" },
    };
  }

  const inputTokensTotal = baseInputTokens + promptOverhead;
  const outputTokensTotal = Math.max(0, Math.ceil(baseInputTokens * outputRatio));

  return {
    inputTokensTotal,
    outputTokensTotal,
    billableTokensTotal: inputTokensTotal + outputTokensTotal,
    _debug: { baseInputTokens, promptOverhead, outputRatio, used: "duration" },
  };
}


function estimateUsdCentsFromBillableTokens(billableTokens) {
  const t = Math.max(0, toInt(billableTokens, 0) || 0);
  if (!t) return 0;
  return ceilDiv(t * EFFECTIVE_USD_CENTS_PER_1M_TOKENS, 1000000);
}

function estimateMediaTokensFromUsdCents(usdCents) {
  const cents = Math.max(0, toInt(usdCents, 0) || 0);
  if (!cents) return 0;

  const tpu = Math.max(0, toInt(Billing.TOKENS_PER_USD, 0) || 0);
  if (!tpu) return 0;

  return ceilDiv(cents * tpu, 100);
}

function formatUsdFromCents(cents) {
  const c = Math.max(0, toInt(cents, 0) || 0);
  const dollars = Math.floor(c / 100);
  const rem = c % 100;
  return `$${dollars}.${String(rem).padStart(2, "0")}`;
}

function estimateSummarizationRun(input, opts) {
  const tok = estimateSummarizationLlmTokens(input, opts);
  const usdCents = estimateUsdCentsFromBillableTokens(tok.billableTokensTotal);
  const mediaTokens = estimateMediaTokensFromUsdCents(usdCents);

  return {
    ...tok,
    usdCents,
    usdFormatted: formatUsdFromCents(usdCents),
    mediaTokens,
    pricing: {
      baseUsdCentsPer1MTokens: BASE_USD_CENTS_PER_1M_TOKENS,
      markupX: MARKUP_X,
      effectiveUsdCentsPer1MTokens: EFFECTIVE_USD_CENTS_PER_1M_TOKENS,
      tokensPerUsd: Math.max(0, toInt(Billing.TOKENS_PER_USD, 0) || 0),
    },
  };
}

// One-stop estimate with duration fallback (like translation)
function estimateSummarizationRunWithDurationFallback(input, durationSeconds, opts) {
  const tok = estimateSummarizationLlmTokensWithDurationFallback(input, durationSeconds, opts);
  const usdCents = estimateUsdCentsFromBillableTokens(tok.billableTokensTotal);
  const mediaTokens = estimateMediaTokensFromUsdCents(usdCents);

  return {
    ...tok,
    usdCents,
    usdFormatted: formatUsdFromCents(usdCents),
    mediaTokens,
    pricing: {
      baseUsdCentsPer1MTokens: BASE_USD_CENTS_PER_1M_TOKENS,
      markupX: MARKUP_X,
      effectiveUsdCentsPer1MTokens: EFFECTIVE_USD_CENTS_PER_1M_TOKENS,
      tokensPerUsd: Math.max(0, toInt(Billing.TOKENS_PER_USD, 0) || 0),
    },
  };
}

function estimateSummarizationRunFromDurationSeconds(durationSeconds, opts) {
  return estimateSummarizationRunWithDurationFallback(null, durationSeconds, opts);
}

module.exports = {
  BASE_USD_CENTS_PER_1M_TOKENS,
  MARKUP_X,
  EFFECTIVE_USD_CENTS_PER_1M_TOKENS,
  EST_DEFAULTS,

  inputToText,
  approxTokensFromText,
  estimateSummarizationLlmTokens,

  // ✅ duration fallback exports
  approxTokensFromDurationSeconds,
  estimateSummarizationLlmTokensWithDurationFallback,
 
   estimateUsdCentsFromBillableTokens,
   estimateMediaTokensFromUsdCents,
   formatUsdFromCents,
 
   estimateSummarizationRun,
  estimateSummarizationRunWithDurationFallback,
  estimateSummarizationRunFromDurationSeconds,
 };

module.exports.default = module.exports;
