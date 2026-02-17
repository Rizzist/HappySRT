// shared/mediaTokensAvailable.js
// JS-only, safe both sides.

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

// Mirrors your ChatTimeline logic.
// Inputs: tokenSnapshot, mediaTokens, pendingMediaTokens
function computeAvailableUnusedMediaTokens({ tokenSnapshot, mediaTokens, pendingMediaTokens } = {}) {
  const availableRaw =
    tokenSnapshot && typeof tokenSnapshot.mediaTokens === "number"
      ? tokenSnapshot.mediaTokens
      : typeof mediaTokens === "number"
      ? mediaTokens
      : 0;

  const serverReserved =
    tokenSnapshot && typeof tokenSnapshot.mediaTokensReserved === "number"
      ? tokenSnapshot.mediaTokensReserved
      : 0;

  const pendingRaw = typeof pendingMediaTokens === "number" ? pendingMediaTokens : serverReserved;

  const baseAvailable = Math.max(0, num(availableRaw));
  const baseServerReserved = Math.max(0, num(serverReserved));
  const basePending = Math.max(0, num(pendingRaw));

  const optimisticRequested = Math.max(0, basePending - baseServerReserved);
  const optimisticEffective = Math.min(optimisticRequested, baseAvailable);

  return Math.max(0, baseAvailable - optimisticEffective);
}

module.exports = { computeAvailableUnusedMediaTokens };
module.exports.default = module.exports;
