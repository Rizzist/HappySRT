// pages/api/billing/portal.js
import Stripe from "stripe";
import { requireAppwriteUser } from "../../../server/appwriteAuth";

const stripeSecret = process.env.STRIPE_SECRET_KEY || "";
const stripe = stripeSecret ? new Stripe(stripeSecret) : null;

function jsonBody(req) {
  const b = req && req.body;
  return b && typeof b === "object" ? b : {};
}

function pickOrigin(req) {
  const h = req?.headers || {};
  const origin =
    (typeof h.origin === "string" && h.origin) ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_URL ||
    "http://localhost:3000";

  try {
    return new URL(origin).origin;
  } catch {
    return "http://localhost:3000";
  }
}

function safeStripeQueryValue(v) {
  return String(v || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// Same “best subscription” logic you already use in /billing/sync
async function searchBestSubscriptionForUser(uid) {
  const u = safeStripeQueryValue(uid);
  const statuses = ["active", "trialing", "past_due", "unpaid"];

  let best = null;

  for (const st of statuses) {
    const query = `metadata["userId"]:"${u}" AND status:"${st}"`;
    const r = await stripe.subscriptions.search({ query, limit: 10 });

    const subs = (r && Array.isArray(r.data) ? r.data : []).filter(Boolean);
    for (const s of subs) {
      const end = Number(s.current_period_end || 0) || 0;
      const bestEnd = Number(best?.current_period_end || 0) || 0;
      if (!best || end > bestEnd) best = s;
    }

    if (best) break;
  }

  return best;
}

function safeReturnUrl(origin, returnTarget) {
  const base = new URL(origin).origin;
  const raw = String(returnTarget || "").trim();

  // default -> home
  if (!raw) return new URL("/", base).toString();

  // allow absolute URLs ONLY if same-origin
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      if (u.origin === base) return u.toString();
    } catch {}
    return new URL("/", base).toString();
  }

  // allow same-origin paths
  if (raw.startsWith("/")) return new URL(raw, base).toString();

  return new URL("/", base).toString();
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ message: "Method not allowed" });
  }

  if (!stripe) {
    return res.status(500).json({ message: "Stripe not configured (missing STRIPE_SECRET_KEY)." });
  }

  try {
    const auth = await requireAppwriteUser(req);
    const uid = String(auth?.userId || "").trim();
    if (!uid) return res.status(401).json({ message: "Unauthorized" });

    const sub = await searchBestSubscriptionForUser(uid);
    if (!sub) return res.status(404).json({ message: "No subscription found for this user." });

    const customerId =
      (typeof sub.customer === "string" && sub.customer) ||
      (sub.customer && typeof sub.customer === "object" && sub.customer.id) ||
      "";

    if (!customerId) {
      return res.status(500).json({ message: "Subscription has no customer id." });
    }

  const origin = pickOrigin(req);
  const body = jsonBody(req);

  // ✅ accept both names
  const returnTarget = body.returnPath || body.returnUrl || "/";

  const portalSession = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: safeReturnUrl(origin, returnTarget),
  });

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ ok: true, url: portalSession.url });
  } catch (e) {
    const status = e?.statusCode || 500;
    return res.status(status).json({ message: e?.message || "Server error" });
  }
}
