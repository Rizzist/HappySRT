// shared/summarizationCatalog.js
// ✅ Shared on server + client
// ✅ JS only (no TS)
// ✅ Keeps summarization “text-only” (not segments)

function safeStr(x) {
  return String(x == null ? "" : x);
}

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
  targetLang: "English",
  source: "auto",
  maxBullets: 10,
});

function getModels() {
  return MODELS.slice();
}

function getModelById(id) {
  const want = safeStr(id).trim();
  if (!want) return null;
  return MODELS.find((m) => safeStr(m.id) === want) || null;
}






const api = {
  MODELS,
  DEFAULTS,

  getModels,
  getModelById,
};

module.exports = api;
module.exports.default = api;
