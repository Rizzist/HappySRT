// shared/transcriptionCatalog.js
// JS-only (no TS). Safe to import in BOTH browser + Node.
// Contains ONLY data + tiny pure helpers.
//
// Design notes:
// - UI flow will be: choose language first -> then filter models that support it.
// - So this file exposes:
//   - LANGUAGES: unified language list for dropdown
//   - PROVIDERS/MODELS: models with supported language codes
//   - helpers: getModelsForLanguage(), getLanguageLabel(), etc.
//
// Sources:
// - Deepgram Nova-3 language codes + "multi": https://developers.deepgram.com/docs/models-languages-overview
// - Deepgram Whisper Cloud supported languages: https://developers.deepgram.com/docs/deepgram-whisper-cloud
// - UpliftAI Speech-to-Text language options (currently Urdu only): https://docs.upliftai.org/api-reference/endpoint/speech-to-text

function uniqByValue(list) {
  const seen = new Set();
  const out = [];
  for (const x of list) {
    const v = String(x?.value || "");
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(x);
  }
  return out;
}

function sortByLabel(list) {
  return list.slice().sort((a, b) => String(a.label || "").localeCompare(String(b.label || "")));
}

// --------------------
// Language dictionaries
// --------------------
const WHISPER_LANGUAGE_NAME_BY_CODE = Object.freeze({
  af: "Afrikaans",
  sq: "Albanian",
  am: "Amharic",
  ar: "Arabic",
  hy: "Armenian",
  as: "Assamese",
  az: "Azerbaijani",
  ba: "Bashkir",
  eu: "Basque",
  be: "Belarusian",
  bn: "Bengali",
  bs: "Bosnian",
  br: "Breton",
  bg: "Bulgarian",
  yue: "Cantonese",
  ca: "Catalan",
  zh: "Chinese",
  hr: "Croatian",
  cs: "Czech",
  da: "Danish",
  nl: "Dutch",
  en: "English",
  et: "Estonian",
  fo: "Faroese",
  fi: "Finnish",
  fr: "French",
  gl: "Galician",
  ka: "Georgian",
  de: "German",
  el: "Greek",
  gu: "Gujarati",
  ht: "Haitian Creole",
  ha: "Hausa",
  haw: "Hawaiian",
  he: "Hebrew",
  hi: "Hindi",
  hu: "Hungarian",
  is: "Icelandic",
  id: "Indonesian",
  it: "Italian",
  ja: "Japanese",
  jw: "Javanese",
  kn: "Kannada",
  kk: "Kazakh",
  km: "Khmer",
  ko: "Korean",
  lo: "Lao",
  la: "Latin",
  lv: "Latvian",
  ln: "Lingala",
  lt: "Lithuanian",
  lb: "Luxembourgish",
  mk: "Macedonian",
  mg: "Malagasy",
  ms: "Malay",
  ml: "Malayalam",
  mt: "Maltese",
  mi: "Maori",
  mr: "Marathi",
  mn: "Mongolian",
  my: "Myanmar",
  ne: "Nepali",
  no: "Norwegian",
  nn: "Norwegian Nynorsk",
  oc: "Occitan",
  ps: "Pashto",
  fa: "Persian",
  pl: "Polish",
  pt: "Portuguese",
  pa: "Punjabi",
  ro: "Romanian",
  ru: "Russian",
  sa: "Sanskrit",
  gd: "Scottish Gaelic",
  sr: "Serbian",
  sn: "Shona",
  sd: "Sindhi",
  si: "Sinhala",
  sk: "Slovak",
  sl: "Slovenian",
  so: "Somali",
  es: "Spanish",
  sw: "Swahili",
  sv: "Swedish",
  tl: "Tagalog",
  tg: "Tajik",
  ta: "Tamil",
  tt: "Tatar",
  te: "Telugu",
  th: "Thai",
  bo: "Tibetan",
  tr: "Turkish",
  tk: "Turkmen",
  uk: "Ukrainian",
  ur: "Urdu",
  uz: "Uzbek",
  vi: "Vietnamese",
  cy: "Welsh",
  yi: "Yiddish",
  yo: "Yoruba",
  su: "Sundanese",
});

const NOVA3_LANGUAGE_NAME_BY_CODE = Object.freeze({
  multi: "Multilingual (Deepgram multi)",

  "da-DK": "Danish (Denmark)",
  "nl-BE": "Dutch (Belgium)",
  "nl-NL": "Dutch (Netherlands)",
  "en-AU": "English (Australia)",
  "en-GB": "English (United Kingdom)",
  "en-IN": "English (India)",
  "en-NZ": "English (New Zealand)",
  "en-US": "English (United States)",
  "fr-CA": "French (Canada)",
  "fr-FR": "French (France)",
  "de-CH": "German (Switzerland)",
  "de-DE": "German (Germany)",
  hi: "Hindi",
  id: "Indonesian",
  it: "Italian",
  ja: "Japanese",
  ko: "Korean",
  no: "Norwegian",
  pl: "Polish",
  "pt-BR": "Portuguese (Brazil)",
  "pt-PT": "Portuguese (Portugal)",
  "es-419": "Spanish (Latin America)",
  "es-ES": "Spanish (Spain)",
  sv: "Swedish",
  ta: "Tamil",
  tr: "Turkish",
  uk: "Ukrainian",

  // Chinese variants
  zh: "Chinese",
  "zh-CN": "Chinese (Simplified, China)",
  "zh-TW": "Chinese (Traditional, Taiwan)",

  // Arabic variants
  "ar-AE": "Arabic (United Arab Emirates)",
  "ar-BH": "Arabic (Bahrain)",
  "ar-DZ": "Arabic (Algeria)",
  "ar-EG": "Arabic (Egypt)",
  "ar-IQ": "Arabic (Iraq)",
  "ar-JO": "Arabic (Jordan)",
  "ar-KW": "Arabic (Kuwait)",
  "ar-LB": "Arabic (Lebanon)",
  "ar-LY": "Arabic (Libya)",
  "ar-MA": "Arabic (Morocco)",
  "ar-OM": "Arabic (Oman)",
  "ar-PS": "Arabic (Palestine)",
  "ar-QA": "Arabic (Qatar)",
  "ar-SA": "Arabic (Saudi Arabia)",
  "ar-SD": "Arabic (Sudan)",
  "ar-SY": "Arabic (Syria)",
  "ar-TD": "Arabic (Chad)",
  "ar-TN": "Arabic (Tunisia)",
  "ar-YE": "Arabic (Yemen)",

  // listed in Deepgram docs; keep for completeness
  "ar-IR": "Arabic (Iran)",
});

const UPLIFTAI_LANGUAGE_NAME_BY_CODE = Object.freeze({
  ur: "Urdu",
});

// --------------------
// Providers + models
// --------------------
const PROVIDERS = Object.freeze({
  deepgram: "deepgram",
  upliftai: "upliftai",
});

const MODELS = Object.freeze([
  {
    id: "deepgram_nova3",
    provider: PROVIDERS.deepgram,
    model: "nova-3",
    label: "Deepgram Nova-3",
    output: ["srt"],
    languageCodes: Object.freeze(Object.keys(NOVA3_LANGUAGE_NAME_BY_CODE)),
  },
  {
    id: "deepgram_whisper",
    provider: PROVIDERS.deepgram,
    model: "whisper",
    label: "Deepgram Whisper",
    output: ["srt"],
    languageCodes: Object.freeze(Object.keys(WHISPER_LANGUAGE_NAME_BY_CODE)),
  },
  {
    id: "upliftai_scribe",
    provider: PROVIDERS.upliftai,
    model: "scribe",
    label: "UpliftAI Scribe",
    output: ["srt"],
    languageCodes: Object.freeze(Object.keys(UPLIFTAI_LANGUAGE_NAME_BY_CODE)),
  },
  {
    id: "upliftai_scribe_mini",
    provider: PROVIDERS.upliftai,
    model: "scribe-mini",
    label: "UpliftAI Scribe Mini",
    output: ["srt"],
    languageCodes: Object.freeze(Object.keys(UPLIFTAI_LANGUAGE_NAME_BY_CODE)),
  },
]);

// --------------------
// Unified language options for dropdown
// - UI wants: choose language first
// - So include "auto" + Deepgram "multi" + all others
// --------------------
const LANGUAGES = Object.freeze(
  (() => {
    const base = [
      { value: "auto", label: "Auto detect" },
      { value: "multi", label: NOVA3_LANGUAGE_NAME_BY_CODE.multi },
    ];

    const whisper = Object.entries(WHISPER_LANGUAGE_NAME_BY_CODE).map(([value, label]) => ({ value, label }));
    const nova3 = Object.entries(NOVA3_LANGUAGE_NAME_BY_CODE)
      .filter(([code]) => code !== "multi")
      .map(([value, label]) => ({ value, label }));
    const uplift = Object.entries(UPLIFTAI_LANGUAGE_NAME_BY_CODE).map(([value, label]) => ({ value, label }));

    const merged = uniqByValue([...base, ...whisper, ...nova3, ...uplift]);

    const pinned = merged.filter((x) => x.value === "auto" || x.value === "multi");
    const rest = sortByLabel(merged.filter((x) => x.value !== "auto" && x.value !== "multi"));

    return [...pinned, ...rest];
  })()
);

// --------------------
// Helpers for “language first -> models second”
// --------------------
function getLanguageLabel(code) {
  const c = String(code || "");
  if (!c) return "";
  if (c === "auto") return "Auto detect";
  return (
    NOVA3_LANGUAGE_NAME_BY_CODE[c] ||
    WHISPER_LANGUAGE_NAME_BY_CODE[c] ||
    UPLIFTAI_LANGUAGE_NAME_BY_CODE[c] ||
    c
  );
}

function getModelById(id) {
  const k = String(id || "");
  return MODELS.find((m) => String(m.id) === k) || null;
}

function getModelsForLanguage(languageCode) {
  const lc = String(languageCode || "");
  if (!lc) return [];

  // auto means “we can pick any model that can auto-detect (for now: allow all)”
  if (lc === "auto") return MODELS.slice();

  // "multi" is specifically Deepgram Nova-3 multi
  if (lc === "multi") return MODELS.filter((m) => m.id === "deepgram_nova3");

  return MODELS.filter((m) => Array.isArray(m.languageCodes) && m.languageCodes.includes(lc));
}

// Optional: if you want provider grouping later
function groupModelsByProvider(models) {
  const out = {};
  for (const m of models || []) {
    const p = String(m.provider || "unknown");
    if (!out[p]) out[p] = [];
    out[p].push(m);
  }
  return out;
}

module.exports = {
  // data
  PROVIDERS,
  MODELS,
  LANGUAGES,

  // dictionaries (sometimes handy)
  WHISPER_LANGUAGE_NAME_BY_CODE,
  NOVA3_LANGUAGE_NAME_BY_CODE,
  UPLIFTAI_LANGUAGE_NAME_BY_CODE,

  // helpers
  getLanguageLabel,
  getModelById,
  getModelsForLanguage,
  groupModelsByProvider,
};
