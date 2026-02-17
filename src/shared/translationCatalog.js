// shared/translationCatalog.js
// ✅ Shared on server + client
// ✅ JS only (no TS types)
// ✅ For now: only GPT-4o mini translation model
// ✅ Includes language lists for UI

function safeStr(x) {
  return String(x == null ? "" : x);
}

function normLang(v) {
  return safeStr(v).trim().toLowerCase();
}

// Keep this list “UI friendly” and stable.
// You can expand later without breaking anything.
const LANGUAGES = Object.freeze([
  { value: "auto", label: "Auto-detect" },

  { value: "en", label: "English" },
  { value: "fr", label: "French" },
  { value: "es", label: "Spanish" },
  { value: "de", label: "German" },
  { value: "it", label: "Italian" },
  { value: "pt", label: "Portuguese" },
  { value: "pt-BR", label: "Portuguese (Brazil)" },
  { value: "nl", label: "Dutch" },

  { value: "sv", label: "Swedish" },
  { value: "no", label: "Norwegian" },
  { value: "da", label: "Danish" },
  { value: "fi", label: "Finnish" },

  { value: "pl", label: "Polish" },
  { value: "cs", label: "Czech" },
  { value: "hu", label: "Hungarian" },
  { value: "ro", label: "Romanian" },
  { value: "bg", label: "Bulgarian" },
  { value: "el", label: "Greek" },

  { value: "ru", label: "Russian" },
  { value: "uk", label: "Ukrainian" },
  { value: "tr", label: "Turkish" },

  { value: "ar", label: "Arabic" },
  { value: "he", label: "Hebrew" },
  { value: "fa", label: "Persian" },
  { value: "ur", label: "Urdu" },

  { value: "hi", label: "Hindi" },
  { value: "bn", label: "Bengali" },
  { value: "ta", label: "Tamil" },
  { value: "te", label: "Telugu" },
  { value: "mr", label: "Marathi" },

  { value: "zh", label: "Chinese" },
  { value: "zh-Hans", label: "Chinese (Simplified)" },
  { value: "zh-Hant", label: "Chinese (Traditional)" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },

  { value: "th", label: "Thai" },
  { value: "vi", label: "Vietnamese" },
  { value: "id", label: "Indonesian" },
  { value: "ms", label: "Malay" },
  { value: "fil", label: "Filipino" },
]);

const MODELS = Object.freeze([
  {
    id: "gpt-4o-mini",
    label: "GPT-4o mini",
    provider: "openai",
    kind: "llm",
  },
]);

const DEFAULTS = Object.freeze({
  modelId: "gpt-4o-mini",
  sourceLang: "auto",
    targetLangs: ["en"], // ✅ always array
});

function getModels() {
  return MODELS.slice();
}

function getModelById(id) {
  const want = safeStr(id).trim();
  if (!want) return null;
  return MODELS.find((m) => safeStr(m.id) === want) || null;
}

function getLanguageByValue(value) {
  const v = safeStr(value).trim();
  if (!v) return null;
  return LANGUAGES.find((l) => safeStr(l.value) === v) || null;
}

function getSourceLanguages() {
  // source can be auto
  return LANGUAGES.slice();
}

function getTargetLanguages() {
  // target cannot be auto
  return LANGUAGES.filter((l) => normLang(l.value) !== "auto");
}

function isValidLanguage(value) {
  return !!getLanguageByValue(value);
}

function isValidTargetLanguage(value) {
  const v = normLang(value);
  if (!v || v === "auto") return false;
  return !!getLanguageByValue(value);
}

const api = {
  LANGUAGES,
  MODELS,
  DEFAULTS,

  getModels,
  getModelById,

  getLanguageByValue,
  getSourceLanguages,
  getTargetLanguages,

  isValidLanguage,
  isValidTargetLanguage,
};

module.exports = api;
// ✅ helps ESM import interop in the client
module.exports.default = api;
