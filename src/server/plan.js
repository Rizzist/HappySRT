// server/plan.js
export function getUserPlan(appwriteUser) {
  // appwriteUser.prefs.plan could be set later by Stripe/webhooks
  const plan = String(appwriteUser?.prefs?.plan || "").toLowerCase();

  // default mapping:
  if (plan === "paid") return "paid";
  if (plan === "free") return "free";

  // if not specified: if they have an email -> treat as free, else guest
  // (anonymous users have empty email in your logs)
  const hasEmail = Boolean((appwriteUser?.email || "").trim());
  return hasEmail ? "free" : "guest";
}

export function getThreadLimitForPlan(plan) {
  if (plan === "paid") return 100;
  if (plan === "free") return 3;
  return 1; // guest
}
