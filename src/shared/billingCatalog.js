// shared/billingCatalog.js
// JS-only (no TS). Safe to import in BOTH browser + Node.
//
// Purpose:
// - A shared, deterministic billing manifest + pure helpers for estimating media token usage.
// - The server should still be authoritative, but client + server can run the SAME math.
//
// Design goals:
// - Integer-first math (avoid float drift)
// - Explicit rounding policy
// - Pricing "version" so you can evolve rates safely
//
// IMPORTANT:
// - tokensPerMinute values below are INITIAL DEFAULTS.
//   You should tune them to match your real vendor costs + desired margins.
// - Keep this file public-safe (no vendor $ costs, no margin ratios).

// --------------------
// Core pricing settings
// --------------------
const PRICING_VERSION = "v1_2026-02-14";

// $10 ~= 2000 tokens => 200 tokens per $1
const TOKENS_PER_USD = 200;

// Rounding quantum for time-based billing.
// 1s = most precise, 5s/15s = simpler + fewer edge-case disputes.
const BILLING_QUANTUM_SECONDS = 1;

// Optional minimum billable time per item (protects against tiny files).
const MIN_BILLABLE_SECONDS = 1;

// If you ever add per-job overhead, keep it explicit and deterministic.
const TOKENS_OVERHEAD_PER_ITEM = 0;
const TOKENS_OVERHEAD_PER_RUN = 0;

// --------------------
// Model billing rates
// IMPORTANT: model ids must match shared/transcriptionCatalog.js MODELS[].id
// --------------------
const BILLING_MODELS = Object.freeze([
  {
    id: "deepgram_nova3",
    label: "Deepgram Nova-3",
    tokensPerMinute: 24,
    // notes: "Adjust after you lock vendor pricing + margin targets."
  },
  {
    id: "deepgram_whisper",
    label: "Deepgram Whisper",
    tokensPerMinute: 30,
  },
  {
    id: "upliftai_scribe",
    label: "UpliftAI Scribe",
    tokensPerMinute: 18,
  },
  {
    id: "upliftai_scribe_mini",
    label: "UpliftAI Scribe Mini",
    tokensPerMinute: 12,
  },
]);

// Handy for Stripe mapping / UI purchase options.
// You can expand later (subscriptions, larger packs, promos).
const TOKEN_PACKS = Object.freeze([
  { id: "pack_2000", label: "2000 media tokens", tokens: 2000, usd: 10 },
]);

// --------------------
// Tiny helpers (pure + deterministic)
// --------------------
function toInt(n, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.trunc(x);
}

function clampInt(n, min, max) {
  const x = toInt(n, min);
  if (x < min) return min;
  if (x > max) return max;
  return x;
}

// ceil(a / b) for positive integers
function ceilDiv(a, b) {
  const x = toInt(a, 0);
  const y = toInt(b, 1);
  if (y <= 0) return 0;
  if (x <= 0) return 0;
  return Math.floor((x + y - 1) / y);
}

function getBillingModelById(id) {
  const k = String(id || "");
  return BILLING_MODELS.find((m) => String(m.id) === k) || null;
}

function getTokensPerMinute(modelId) {
  const m = getBillingModelById(modelId);
  return m ? toInt(m.tokensPerMinute, 0) : 0;
}

// Billable seconds rounding:
// - round UP to the nearest quantum
// - enforce minimum
function billableSeconds(durationSeconds, opts) {
  const quantum = clampInt(opts?.quantumSeconds, 1, 60) || BILLING_QUANTUM_SECONDS;
  const minSec = clampInt(opts?.minBillableSeconds, 0, 3600) || MIN_BILLABLE_SECONDS;

  const dur = Math.max(0, Number(durationSeconds || 0));
  if (!Number.isFinite(dur) || dur <= 0) return 0;

  const raw = Math.ceil(dur);
  const q = Math.max(1, quantum);
  const rounded = Math.ceil(raw / q) * q;

  return Math.max(minSec, rounded);
}

// Estimate tokens for ONE media item
function estimateTokensForSeconds(durationSeconds, modelId, opts) {
  const tpm = getTokensPerMinute(modelId);
  if (!tpm) return 0;

  const sec = billableSeconds(durationSeconds, opts);
  if (!sec) return 0;

  // tokens = ceil((sec * tokensPerMinute) / 60)
  const base = ceilDiv(sec * tpm, 60);

  const overheadItem = toInt(opts?.tokensOverheadPerItem, TOKENS_OVERHEAD_PER_ITEM) || 0;
  return Math.max(0, base + overheadItem);
}

// Estimate tokens for a RUN consisting of multiple items
// items: [{ durationSeconds, modelId? }]  (modelId defaults to runModelId)
function estimateTokensForRun(items, runModelId, opts) {
  const list = Array.isArray(items) ? items : [];
  const overheadRun = toInt(opts?.tokensOverheadPerRun, TOKENS_OVERHEAD_PER_RUN) || 0;

  let sum = 0;
  for (const it of list) {
    const seconds = Number(it?.durationSeconds || 0);
    const mid = String(it?.modelId || runModelId || "");
    sum += estimateTokensForSeconds(seconds, mid, opts);
  }

  return Math.max(0, sum + overheadRun);
}

// Convenience: compute what a token balance means in USD (approx, for UI)
function tokensToUsd(tokens) {
  const t = Number(tokens || 0);
  if (!Number.isFinite(t) || t <= 0) return 0;
  return t / TOKENS_PER_USD;
}

function usdToTokens(usd) {
  const u = Number(usd || 0);
  if (!Number.isFinite(u) || u <= 0) return 0;
  return Math.round(u * TOKENS_PER_USD);
}

// Optional: lightweight manifest export (useful if you later serve this over an API)
function getPublicPricingManifest() {
  return {
    pricingVersion: PRICING_VERSION,
    tokensPerUsd: TOKENS_PER_USD,
    billingQuantumSeconds: BILLING_QUANTUM_SECONDS,
    minBillableSeconds: MIN_BILLABLE_SECONDS,
    tokensOverheadPerItem: TOKENS_OVERHEAD_PER_ITEM,
    tokensOverheadPerRun: TOKENS_OVERHEAD_PER_RUN,
    models: BILLING_MODELS.map((m) => ({
      id: m.id,
      label: m.label,
      tokensPerMinute: m.tokensPerMinute,
    })),
    packs: TOKEN_PACKS.slice(),
  };
}

module.exports = {
  // constants
  PRICING_VERSION,
  TOKENS_PER_USD,
  BILLING_QUANTUM_SECONDS,
  MIN_BILLABLE_SECONDS,
  TOKENS_OVERHEAD_PER_ITEM,
  TOKENS_OVERHEAD_PER_RUN,

  // data
  BILLING_MODELS,
  TOKEN_PACKS,

  // helpers
  getBillingModelById,
  getTokensPerMinute,
  billableSeconds,
  estimateTokensForSeconds,
  estimateTokensForRun,
  tokensToUsd,
  usdToTokens,
  getPublicPricingManifest,
};
