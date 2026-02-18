// lib/upgradeBus.js
export const UPGRADE_EVENT = "app:open-upgrade";

export function requestUpgrade(detail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(UPGRADE_EVENT, { detail: detail || {} }));
}

export function onUpgradeRequested(handler) {
  if (typeof window === "undefined") return () => {};
  const fn = (e) => handler((e && e.detail) || {});
  window.addEventListener(UPGRADE_EVENT, fn);
  return () => window.removeEventListener(UPGRADE_EVENT, fn);
}
