// /shared/plans.js
// JS-only (no TS). Safe to import in BOTH browser + Node.
//
// Purpose:
// - Single source of truth for plan + add-on entitlements.
// - Used by:
//   - UI (show plan benefits)
//   - Server (derive effective limits + monthly token floors)
// - Stripe price ids are included but left empty for now.
//
// Notes:
// - All caps/limits are expressed in BYTES + INTS for deterministic math.
// - You can tune numbers later without touching Stripe, by bumping PRICING_VERSION.

const BillingImport = require("./billingCatalog");
const Billing = (BillingImport && (BillingImport.default || BillingImport)) || {};

const PRICING_VERSION = Billing.PRICING_VERSION || "v1_2026-02-14";

// --------------------
// Byte helpers (integers)
// --------------------
const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;
const TB = 1024 * GB;

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

function kb(n) {
  return Math.max(0, toInt(n, 0)) * KB;
}
function gb(n) {
  return Math.max(0, toInt(n, 0)) * GB;
}
function tb(n) {
  return Math.max(0, toInt(n, 0)) * TB;
}
function mb(n) {
  return Math.max(0, toInt(n, 0)) * MB;
}

function formatBytes(bytes) {
  const b = Math.max(0, Number(bytes || 0) || 0);
  if (b >= TB) return `${Math.round((b / TB) * 10) / 10} TB`;
  if (b >= GB) return `${Math.round((b / GB) * 10) / 10} GB`;
  if (b >= MB) return `${Math.round((b / MB) * 10) / 10} MB`;
  if (b >= KB) return `${Math.round((b / KB) * 10) / 10} KB`;
  return `${Math.round(b)} B`;
}

// --------------------
// Plan catalog
// --------------------
// Keys should be stable; treat them like API enums.
const PLAN_KEYS = Object.freeze({
  free: "free",
  hobby: "hobby",
  business: "business",
  agency: "agency",
});

// Entitlements model:
// - monthlyFloorMediaTokens: "added for that month (expires at the end of that month)"
// - maxFileBytes: maximum size of a single upload
// - monthlyUploadBytesCap: sum of bytes uploaded in current month
// - activeStorageBytesCap: sum of bytes stored (active + not deleted)
// - retentionDays: optional cleanup window for older media
// - savedItemCountCap: max number of "saved" items (e.g. saved chats/prompts/runs)
// - maxSavedItemBytes: max size of a single saved payload (serialized bytes)
// - monthlySaveBytesCap: sum of bytes written via "save" operations in current month
// - savedStorageBytesCap: sum of bytes stored for saved items (active + not deleted)
// - threadLimit: maximum threads allowed (or whatever your UI/DB expects)
//
// Stripe:
// - priceIdMonthly: Stripe recurring price id (empty for now)
// - productId: optional (empty for now)

const PLANS = Object.freeze([
  {
    key: PLAN_KEYS.free,
    label: "Free",
    priceUsdMonthly: 0,
    stripe: {
      productId: "",
      priceIdMonthly: "",
    },
    entitlements: {
      // Keep this small; your existing /api/auth/tokens bootstrap_min can still apply on top.
      monthlyFloorMediaTokens: 100,
        threadLimit: 2,
      maxFileBytes: mb(100),
      monthlyUploadBytesCap: mb(512),
      activeStorageBytesCap: gb(2),
      retentionDays: 14,

      savedItemCountCap: 50,
      maxSavedItemBytes: kb(256),
      monthlySaveBytesCap: mb(25),
      savedStorageBytesCap: mb(250),

      // Optional knobs if you later want limits by concurrency, etc.
      // maxConcurrentRuns: 1,
    },
    flags: {
      canBuyAddons: false,
    },
  },

  {
    key: PLAN_KEYS.hobby,
    label: "Hobby",
    priceUsdMonthly: 5,
    stripe: {
      productId: "prod_U04qd2i5nFkasY",
      priceIdMonthly: "price_1T24gZQ4bzRqryvEUcJhjgyT",
    },
    entitlements: {
      monthlyFloorMediaTokens: 1000,
        threadLimit: 20,
      maxFileBytes: mb(500),
      monthlyUploadBytesCap: gb(10),
      activeStorageBytesCap: gb(50),
      retentionDays: 90,
      savedItemCountCap: 2_000,
      maxSavedItemBytes: mb(2),
      monthlySaveBytesCap: gb(1),
      savedStorageBytesCap: gb(5),
    },
    flags: {
      canBuyAddons: true,
      maxAddons: {
        mediaTokens11: 1, // keep simple; change anytime
      },
    },
  },

  {
    key: PLAN_KEYS.business,
    label: "Business",
    priceUsdMonthly: 50,
    stripe: {
      productId: "prod_U09uZEqoQOX9Y1",
      priceIdMonthly: "price_1T29b6Q4bzRqryvEDLOJezW5",
    },
    entitlements: {
      monthlyFloorMediaTokens: 10000,
        threadLimit: 200,
      maxFileBytes: gb(2), // 2 GB
      monthlyUploadBytesCap: gb(50),
      activeStorageBytesCap: tb(1), // 1 TB
      retentionDays: 180,
      savedItemCountCap: 20_000,
      maxSavedItemBytes: mb(10),
      monthlySaveBytesCap: gb(10),
      savedStorageBytesCap: gb(50),
    },
    flags: {
      canBuyAddons: true,
      maxAddons: {
        mediaTokens11: 3,
      },
    },
  },

  {
    key: PLAN_KEYS.agency,
    label: "Agency",
    priceUsdMonthly: 500,
    stripe: {
      productId: "prod_U09vq9xRZkvtZ7",
      priceIdMonthly: "price_1T29bxQ4bzRqryvENIiPoFNA",
    },
    entitlements: {
      monthlyFloorMediaTokens: 500000,
        threadLimit: 2000,
      maxFileBytes: gb(10),
      monthlyUploadBytesCap: tb(1),
      activeStorageBytesCap: tb(5),
      retentionDays: 365,
      savedItemCountCap: 200_000,
      maxSavedItemBytes: mb(50),
      monthlySaveBytesCap: gb(100),
      savedStorageBytesCap: gb(500),
    },
    flags: {
      canBuyAddons: true,
      maxAddons: {
        mediaTokens11: 10,
      },
    },
  },
]);

// --------------------
// Add-ons catalog
// --------------------
// Add-ons should also have stable keys.
// Stripe price ids empty for now.
//
// Design:
// - Each add-on adds to floors/caps.
// - Keep stacking logic in one place (computeEffectiveEntitlements).
const ADDON_KEYS = Object.freeze({
  mediaTokens11: "mediaTokens11",
});

const ADDONS = Object.freeze([
  {
    key: ADDON_KEYS.mediaTokens11,
    label: "Media Tokens Add-on",
    priceUsdMonthly: 11,
    stripe: {
      productId: "",
      priceIdMonthly: "",
    },
    entitlementsDelta: {
      monthlyFloorMediaTokens: 3000,
      monthlyUploadBytesCap: gb(25),
      activeStorageBytesCap: gb(100),
      // maxFileBytes: 0, // usually don't change max file size via addon
      // retentionDays: 0,
    },
  },
]);

// --------------------
// Indexes
// --------------------
const PLANS_BY_KEY = Object.freeze(
  PLANS.reduce((acc, p) => {
    acc[String(p.key)] = p;
    return acc;
  }, {})
);

const ADDONS_BY_KEY = Object.freeze(
  ADDONS.reduce((acc, a) => {
    acc[String(a.key)] = a;
    return acc;
  }, {})
);

// --------------------
// Entitlement computation
// --------------------
//
// basePlanKey: "free" | "hobby" | "business" | "agency"
// addons: { mediaTokens11: number, ... } (counts)
//
// Returns:
// - plan
// - addonsApplied: normalized counts
// - entitlements: merged totals
function computeEffectiveEntitlements(basePlanKey, addons) {
  const plan = getPlanByKey(basePlanKey) || getPlanByKey(PLAN_KEYS.free);

  const base = plan.entitlements || {};
  const counts = normalizeAddonCounts(addons);

  // Enforce per-plan addon limits (if present)
  const maxAddons = (plan.flags && plan.flags.maxAddons) || {};
  const canBuyAddons = !!(plan.flags && plan.flags.canBuyAddons);

  const applied = {};
  for (const [k, n] of Object.entries(counts)) {
    const want = Math.max(0, toInt(n, 0));
    if (!canBuyAddons) {
      applied[k] = 0;
      continue;
    }
    const cap = maxAddons && Object.prototype.hasOwnProperty.call(maxAddons, k) ? toInt(maxAddons[k], 0) : want;
    applied[k] = Math.max(0, Math.min(want, Math.max(0, cap)));
  }

  // Start with base entitlements
  const out = {
    monthlyFloorMediaTokens: toInt(base.monthlyFloorMediaTokens, 0),
    threadLimit: toInt(base.threadLimit, 0),
    maxFileBytes: toInt(base.maxFileBytes, 0),
    monthlyUploadBytesCap: toInt(base.monthlyUploadBytesCap, 0),
    activeStorageBytesCap: toInt(base.activeStorageBytesCap, 0),
    retentionDays: toInt(base.retentionDays, 0),
    savedItemCountCap: toInt(base.savedItemCountCap, 0),
    maxSavedItemBytes: toInt(base.maxSavedItemBytes, 0),
    monthlySaveBytesCap: toInt(base.monthlySaveBytesCap, 0),
    savedStorageBytesCap: toInt(base.savedStorageBytesCap, 0),
  };

  // Add deltas
  for (const [addonKey, count] of Object.entries(applied)) {
    const addon = ADDONS_BY_KEY[String(addonKey)];
    if (!addon) continue;
    const c = Math.max(0, toInt(count, 0));
    if (!c) continue;

    const d = addon.entitlementsDelta || {};
    out.monthlyFloorMediaTokens += toInt(d.monthlyFloorMediaTokens, 0) * c;
    out.monthlyUploadBytesCap += toInt(d.monthlyUploadBytesCap, 0) * c;
    out.activeStorageBytesCap += toInt(d.activeStorageBytesCap, 0) * c;
    out.monthlySaveBytesCap += toInt(d.monthlySaveBytesCap, 0) * c;
    out.savedStorageBytesCap += toInt(d.savedStorageBytesCap, 0) * c;
    out.savedItemCountCap += toInt(d.savedItemCountCap, 0) * c;
    // Usually keep maxFileBytes + retentionDays at plan-level,
    // but you can enable deltas later if you want:
    // out.maxFileBytes = Math.max(out.maxFileBytes, toInt(d.maxFileBytes, 0));
    // out.retentionDays = Math.max(out.retentionDays, toInt(d.retentionDays, 0));
    // out.maxSavedItemBytes = Math.max(out.maxSavedItemBytes, toInt(d.maxSavedItemBytes, 0));
   }

  // Final sanity clamps (optional but helps avoid nonsense)
  out.monthlyFloorMediaTokens = clampInt(out.monthlyFloorMediaTokens, 0, 10_000_000_000);
  out.maxFileBytes = clampInt(out.maxFileBytes, 0, 1000 * TB);
  out.monthlyUploadBytesCap = clampInt(out.monthlyUploadBytesCap, 0, 10000 * TB);
  out.activeStorageBytesCap = clampInt(out.activeStorageBytesCap, 0, 100000 * TB);
  out.retentionDays = clampInt(out.retentionDays, 0, 3650);
  out.savedItemCountCap = clampInt(out.savedItemCountCap, 0, 1_000_000_000);
  out.maxSavedItemBytes = clampInt(out.maxSavedItemBytes, 0, 1000 * TB);
  out.monthlySaveBytesCap = clampInt(out.monthlySaveBytesCap, 0, 10000 * TB);
  out.savedStorageBytesCap = clampInt(out.savedStorageBytesCap, 0, 100000 * TB);
 
  return {
    pricingVersion: PRICING_VERSION,
    plan,
    addonsApplied: applied,
    entitlements: out,
  };
}

function normalizeAddonCounts(addons) {
  const a = addons && typeof addons === "object" ? addons : {};
  const out = {};
  for (const k of Object.keys(ADDONS_BY_KEY)) {
    if (!Object.prototype.hasOwnProperty.call(a, k)) continue;
    out[k] = Math.max(0, toInt(a[k], 0));
  }
  return out;
}

// --------------------
// Lookups
// --------------------
function getPlanByKey(key) {
  const k = String(key || "");
  return PLANS_BY_KEY[k] || null;
}

function getAddonByKey(key) {
  const k = String(key || "");
  return ADDONS_BY_KEY[k] || null;
}

function listPlans() {
  return PLANS.slice();
}

function listAddons() {
  return ADDONS.slice();
}

// Optional: useful for UI
function getPublicPlanSummary(planKey, addons) {
  const eff = computeEffectiveEntitlements(planKey, addons);
  const e = eff.entitlements;

  return {
    pricingVersion: eff.pricingVersion,
    planKey: eff.plan.key,
    planLabel: eff.plan.label,

    monthlyFloorMediaTokens: e.monthlyFloorMediaTokens,
    approxUsdValueAtPeg:
      Billing && Number(Billing.TOKENS_PER_USD) > 0
        ? Math.round((e.monthlyFloorMediaTokens / Number(Billing.TOKENS_PER_USD)) * 100) / 100
        : null,

    maxFileSize: formatBytes(e.maxFileBytes),
    monthlyUploadCap: formatBytes(e.monthlyUploadBytesCap),
    activeStorageCap: formatBytes(e.activeStorageBytesCap),
    retentionDays: e.retentionDays,

   savedItemCountCap: e.savedItemCountCap,
    maxSavedItemSize: formatBytes(e.maxSavedItemBytes),
    monthlySaveCap: formatBytes(e.monthlySaveBytesCap),
    savedStorageCap: formatBytes(e.savedStorageBytesCap),

    addonsApplied: eff.addonsApplied,
  };
}

module.exports = {
  PRICING_VERSION,

  // keys
  PLAN_KEYS,
  ADDON_KEYS,

  // catalogs
  PLANS,
  ADDONS,

  // helpers
  getPlanByKey,
  getAddonByKey,
  listPlans,
  listAddons,

  computeEffectiveEntitlements,
  getPublicPlanSummary,

  // bytes helpers (handy elsewhere)
  kb,
  KB,
  MB,
  GB,
  TB,
  formatBytes,
};

module.exports.default = module.exports;
