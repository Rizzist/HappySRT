// shared/translationBillingCatalog.js
// JS-only. Safe in BOTH browser + Node.
//
// Purpose:
// - Deterministic estimation of translation cost.
// - Convert estimated LLM tokens -> USD -> "media tokens" using shared/billingCatalog TOKENS_PER_USD.
// - Apply markup (20x).
//
// Assumption requested (for now):
// - Treat BOTH input + output pricing as "Output: $2.00 / 1M tokens" (same rate).
// - Charge translation in MEDIA TOKENS (not some separate "text tokens").
// - Server remains authoritative; this is for gating + UI estimates.

const BillingImport = require("./billingCatalog");
const Billing = (BillingImport && (BillingImport.default || BillingImport)) || {};

// --------------------
// Config (v1)
// --------------------

// Base vendor price (your assumption): $2.00 per 1,000,000 tokens
const BASE_USD_CENTS_PER_1M_TOKENS = 200; // $2.00 => 200 cents

// Your markup requirement
const MARKUP_X = 20;

// Effective "sell" price in cents per 1M tokens
const EFFECTIVE_USD_CENTS_PER_1M_TOKENS = BASE_USD_CENTS_PER_1M_TOKENS * MARKUP_X; // 200 * 20 = 4000 cents = $40

// --------------------
// Estimation knobs (deterministic)
// --------------------
const EST_DEFAULTS = Object.freeze({
  charsPerToken: 4,
  promptOverheadTokens: 120,
  perTargetOverheadTokens: 40,
  outputRatio: 1.1,

  // ✅ NEW: duration -> text heuristics (tunable)
  // Typical speech ~130–170 wpm. Pick a stable deterministic default.
  wordsPerMinute: 150,

  // Rough chars per word (Latin-ish). Includes spaces/punctuation-ish.
  charsPerWord: 5.0,
});


// --------------------
// Tiny deterministic helpers
// --------------------
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

// --------------------
// Input normalization (text / srt / segments)
// --------------------
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

// Minimal SRT -> text extraction (deterministic; no heavy parsing)
function srtToPlainText(srt) {
  const raw = safeStr(srt).replace(/\r\n/g, "\n");
  if (!raw.trim()) return "";

  const lines = raw.split("\n");
  const out = [];

  for (const line of lines) {
    const l = line.trim();
    if (!l) continue;

    // index line
    if (/^\d+$/.test(l)) continue;

    // timecode line
    if (/^\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}/.test(l)) continue;

    out.push(l);
  }

  return normalizeWhitespace(out.join(" "));
}

// Accepts:
// - string (assume text)
// - { text }
// - { srt }
// - { segments: [] }
// - segments array directly
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

// --------------------
// Token estimation (LLM tokens, not media tokens)
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

  // words = seconds * (wpm / 60)
  const words = sec * (wpm / 60);
  const chars = Math.max(0, Math.round(words * cpw));

  return approxTokensFromText("x".repeat(Math.min(chars, 1000000)), o); // cap safety
}

// Estimate translation tokens from either transcript-like input OR duration.
// If input has no usable text, duration is used as fallback.
function estimateTranslationLlmTokensWithDurationFallback(input, durationSeconds, targetLangs, opts) {
  const text = inputToText(input);
  const hasText = !!String(text || "").trim();

  if (hasText) return estimateTranslationLlmTokens({ text }, targetLangs, opts);

  const baseInputTokens = approxTokensFromDurationSeconds(durationSeconds, opts);
  const o = opts && typeof opts === "object" ? opts : {};

  const targets = uniqStrings(targetLangs);
  const targetCount = targets.length;

  const promptOverhead = Math.max(0, toInt(o.promptOverheadTokens, EST_DEFAULTS.promptOverheadTokens) || 0);
  const perTargetOverhead = Math.max(0, toInt(o.perTargetOverheadTokens, EST_DEFAULTS.perTargetOverheadTokens) || 0);
  const outputRatio = clamp(
    o.outputRatio != null ? Number(o.outputRatio) : EST_DEFAULTS.outputRatio,
    0.1,
    3.0
  );

  if (!targetCount || (baseInputTokens + promptOverhead) <= 0) {
    return {
      inputTokensTotal: 0,
      outputTokensTotal: 0,
      billableTokensTotal: 0,
      _debug: { baseInputTokens, promptOverhead, perTargetOverhead, outputRatio, targetCount, used: "duration" },
    };
  }

  const perTargetInput = Math.max(0, baseInputTokens + promptOverhead + perTargetOverhead);
  const perTargetOutput = Math.max(0, Math.ceil(baseInputTokens * outputRatio));

  const inputTokensTotal = perTargetInput * targetCount;
  const outputTokensTotal = perTargetOutput * targetCount;

  return {
    inputTokensTotal,
    outputTokensTotal,
    billableTokensTotal: inputTokensTotal + outputTokensTotal,
    _debug: { baseInputTokens, promptOverhead, perTargetOverhead, outputRatio, targetCount, used: "duration" },
  };
}

// One-stop estimate with duration fallback
function estimateTranslationRunWithDurationFallback(input, durationSeconds, targetLangs, opts) {
  const tok = estimateTranslationLlmTokensWithDurationFallback(input, durationSeconds, targetLangs, opts);
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


function approxTokensFromText(text, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const cpt = Math.max(1, toInt(o.charsPerToken, EST_DEFAULTS.charsPerToken) || EST_DEFAULTS.charsPerToken);

  const t = safeStr(text);
  const chars = t.length;
  if (chars <= 0) return 0;

  // ceil(chars / charsPerToken)
  return ceilDiv(chars, cpt);
}

// Estimate a translation RUN.
// Assumes you do one request per target language (common pattern).
//
// Returns:
// - inputTokensTotal: input tokens billed across all target requests
// - outputTokensTotal: output tokens billed across all target requests
// - billableTokensTotal: input + output
function estimateTranslationLlmTokens(input, targetLangs, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const targets = uniqStrings(targetLangs);
  const targetCount = targets.length;

  const text = inputToText(input);
  const baseInputTokens = approxTokensFromText(text, o);

  const promptOverhead = Math.max(0, toInt(o.promptOverheadTokens, EST_DEFAULTS.promptOverheadTokens) || 0);
  const perTargetOverhead = Math.max(0, toInt(o.perTargetOverheadTokens, EST_DEFAULTS.perTargetOverheadTokens) || 0);

  const outputRatio = clamp(
    o.outputRatio != null ? Number(o.outputRatio) : EST_DEFAULTS.outputRatio,
    0.1,
    3.0
  );

  if (!targetCount || (baseInputTokens + promptOverhead) <= 0) {
    return {
      inputTokensTotal: 0,
      outputTokensTotal: 0,
      billableTokensTotal: 0,
      _debug: { baseInputTokens, promptOverhead, perTargetOverhead, outputRatio, targetCount },
    };
  }

  // per-target request:
  // input billed each time (prompt + source text + per-target overhead)
  const perTargetInput = Math.max(0, baseInputTokens + promptOverhead + perTargetOverhead);

  // output per target:
  const perTargetOutput = Math.max(0, Math.ceil(baseInputTokens * outputRatio));

  const inputTokensTotal = perTargetInput * targetCount;
  const outputTokensTotal = perTargetOutput * targetCount;

  return {
    inputTokensTotal,
    outputTokensTotal,
    billableTokensTotal: inputTokensTotal + outputTokensTotal,
    _debug: { baseInputTokens, promptOverhead, perTargetOverhead, outputRatio, targetCount },
  };
}

// --------------------
// Convert LLM tokens -> USD cents -> MEDIA TOKENS
// --------------------
function estimateUsdCentsFromBillableTokens(billableTokens) {
  const t = Math.max(0, toInt(billableTokens, 0) || 0);
  if (!t) return 0;

  // cents = ceil(tokens * centsPer1M / 1,000,000)
  return ceilDiv(t * EFFECTIVE_USD_CENTS_PER_1M_TOKENS, 1000000);
}

function estimateMediaTokensFromUsdCents(usdCents) {
  const cents = Math.max(0, toInt(usdCents, 0) || 0);
  if (!cents) return 0;

  // Billing.TOKENS_PER_USD means: media tokens per $1
  const tpu = Math.max(0, toInt(Billing.TOKENS_PER_USD, 0) || 0);
  if (!tpu) return 0;

  // mediaTokens = ceil(cents * TOKENS_PER_USD / 100)
  return ceilDiv(cents * tpu, 100);
}

function formatUsdFromCents(cents) {
  const c = Math.max(0, toInt(cents, 0) || 0);
  const dollars = Math.floor(c / 100);
  const rem = c % 100;
  return `$${dollars}.${String(rem).padStart(2, "0")}`;
}

// One-stop estimate for a translate run
function estimateTranslationRun(input, targetLangs, opts) {
  const tok = estimateTranslationLlmTokens(input, targetLangs, opts);
  const usdCents = estimateUsdCentsFromBillableTokens(tok.billableTokensTotal);
  const mediaTokens = estimateMediaTokensFromUsdCents(usdCents);

  return {
    ...tok,
    usdCents,
    usdFormatted: formatUsdFromCents(usdCents),
    mediaTokens, // THIS is what you charge / reserve / gate against
    pricing: {
      baseUsdCentsPer1MTokens: BASE_USD_CENTS_PER_1M_TOKENS,
      markupX: MARKUP_X,
      effectiveUsdCentsPer1MTokens: EFFECTIVE_USD_CENTS_PER_1M_TOKENS,
      tokensPerUsd: Math.max(0, toInt(Billing.TOKENS_PER_USD, 0) || 0),
    },
  };
}

function estimateTranslationRunFromDurationSeconds(durationSeconds, targetLangs, opts) {
  return estimateTranslationRunWithDurationFallback(null, durationSeconds, targetLangs, opts);
}

module.exports = {
  // config
  BASE_USD_CENTS_PER_1M_TOKENS,
  MARKUP_X,
  EFFECTIVE_USD_CENTS_PER_1M_TOKENS,
  EST_DEFAULTS,

  // helpers
  inputToText,
  approxTokensFromText,
  estimateTranslationLlmTokens,
  estimateUsdCentsFromBillableTokens,
  estimateMediaTokensFromUsdCents,
  formatUsdFromCents,
  estimateTranslationRun,
    approxTokensFromDurationSeconds,
  estimateTranslationLlmTokensWithDurationFallback,
  estimateTranslationRunWithDurationFallback,
  estimateTranslationRunFromDurationSeconds
};

// ESM interop
module.exports.default = module.exports;
