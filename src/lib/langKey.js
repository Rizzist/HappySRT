// src/lib/langKey.js

function isPlainObject(x) {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

// Canonical form for comparing keys (case-insensitive, "_" -> "-")
export function normalizeLangKey(input) {
  const s = String(input ?? "").trim();
  if (!s) return "";
  return s.replace(/_/g, "-").toLowerCase();
}

// Returns a safe canonical lang key, or null if invalid.
// Default: rejects "auto" (good for targetLangs).
export function safeLangKey(input, { allowAuto = false } = {}) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;

  const norm = normalizeLangKey(raw);

  if (!allowAuto && norm === "auto") return null;
  if (allowAuto && norm === "auto") return "auto";

  // Very forgiving BCP47-ish check:
  //  - base: 2-3 letters (en, sv, zh)
  //  - subtags: 2-8 alnum (gb, hans, 419)
  // Examples: en, en-gb, zh-hans, es-419, pt-br
  const ok = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(norm);
  if (!ok) return null;

  return norm;
}

// Find the *actual* key inside obj that corresponds to `lang` (CI match).
// Returns the existing key string, or null.
export function getLangKeyCI(obj, lang) {
  const o = isPlainObject(obj) ? obj : null;
  const want = normalizeLangKey(lang);
  if (!o || !want) return null;

  // exact hit first
  if (Object.prototype.hasOwnProperty.call(o, lang)) return lang;

  // CI/normalized hit
  for (const k of Object.keys(o)) {
    if (normalizeLangKey(k) === want) return k;
  }

  return null;
}

export function getByLangCI(map, lang) {
  const o = isPlainObject(map) ? map : null;
  const k = getLangKeyCI(o, lang);
  return k ? o[k] : null;
}

// Remove a language entry from an object (CI/normalized match).
// Returns SAME object if nothing removed; returns a NEW object if removed.
export function deleteLangKey(map, lang) {
  const o = isPlainObject(map) ? map : {};
  const k = getLangKeyCI(o, lang);
  if (!k) return o;

  const next = { ...o };
  delete next[k];
  return next;
}

// Optional: default export for convenience if you ever want it.
export default {
  normalizeLangKey,
  safeLangKey,
  getLangKeyCI,
  getByLangCI,
  deleteLangKey,
};
