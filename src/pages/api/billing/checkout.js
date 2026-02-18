// pages/api/billing/checkout.js
import Stripe from "stripe";
import { Client, Account } from "appwrite";
import { requireAppwriteUser } from "../../../server/appwriteAuth";

import PlansImport from "../../../shared/plans";
const Plans = (PlansImport && (PlansImport.default || PlansImport)) || {};
const { getPlanByKey, PLAN_KEYS, PRICING_VERSION } = Plans;

const stripeSecret = process.env.STRIPE_SECRET_KEY || "";
const stripe = stripeSecret ? new Stripe(stripeSecret) : null;

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

function jsonBody(req) {
  const b = req && req.body;
  return b && typeof b === "object" ? b : {};
}

function getBearerJwt(req) {
  const raw = String(req?.headers?.authorization || "");
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m ? String(m[1] || "").trim() : "";
}

function looksLikeEmail(s) {
  const e = String(s || "").trim();
  if (!e) return false;
  if (e.length > 254) return false;
  // pragmatic email check (not strict RFC)
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

async function fetchAppwriteAccountFromJwt(jwt) {
  const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT || process.env.APPWRITE_ENDPOINT || "";
  const project = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID || process.env.APPWRITE_PROJECT_ID || "";
  if (!endpoint || !project || !jwt) return null;

  const client = new Client();
  client.setEndpoint(endpoint);
  client.setProject(project);

  // Node Appwrite SDK supports setJWT
  if (typeof client.setJWT === "function") client.setJWT(jwt);

  const account = new Account(client);
  try {
    const u = await account.get();
    return u && typeof u === "object" ? u : null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ message: "Method not allowed" });
  }

  if (!stripe) {
    return res.status(500).json({
      message: "Stripe not configured (missing STRIPE_SECRET_KEY).",
    });
  }

  try {
    // Auth (Appwrite)
    const auth = await requireAppwriteUser(req);
    const uid = String(auth?.userId || "");
    if (!uid) return res.status(401).json({ message: "Unauthorized" });

    const body = jsonBody(req);
    const planKey = String(body?.planKey || "").trim();

    // Validate plan
    const plan = typeof getPlanByKey === "function" ? getPlanByKey(planKey) : null;
    if (!plan || !plan.key) return res.status(400).json({ message: "Invalid planKey." });

    if (plan.key === (PLAN_KEYS && PLAN_KEYS.free)) {
      return res.status(400).json({ message: "Free plan cannot be purchased." });
    }

    const priceIdMonthly = plan?.stripe?.priceIdMonthly ? String(plan.stripe.priceIdMonthly) : "";
    if (!priceIdMonthly) {
      return res.status(400).json({
        message: "This plan is not purchasable yet (missing stripe.priceIdMonthly).",
      });
    }

    const origin = pickOrigin(req);
    const successUrl = `${origin}/billing/success?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${origin}/billing/fail?reason=cancel`;


    // ✅ Grab email/name reliably from Appwrite using the same JWT
    const jwt = getBearerJwt(req);
    const acct = await fetchAppwriteAccountFromJwt(jwt);

    const email =
      (looksLikeEmail(auth?.email) && String(auth.email).trim()) ||
      (looksLikeEmail(acct?.email) && String(acct.email).trim()) ||
      "";

    const name =
      (auth?.name && String(auth.name).trim()) ||
      (acct?.name && String(acct.name).trim()) ||
      "";

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceIdMonthly, quantity: 1 }],

      success_url: successUrl,
      cancel_url: cancelUrl,

      // ✅ Appwrite user id as client_reference_id
      client_reference_id: uid,

      metadata: {
        userId: uid,
        planKey: String(plan.key),
        pricingVersion: String(PRICING_VERSION || ""),
      },

      subscription_data: {
        metadata: {
          userId: uid,
          planKey: String(plan.key),
          pricingVersion: String(PRICING_VERSION || ""),
        },
      },

      allow_promotion_codes: true,
      billing_address_collection: "auto",

      // ✅ This is what makes Stripe prefill the email field
      ...(email ? { customer_email: email } : {}),

      // Optional: prefill name on the customer object Stripe creates
      // (Stripe may or may not show a name input depending on settings)
      ...(name
        ? {
            custom_fields: [
              {
                key: "name_prefill",
                label: { type: "custom", custom: "Name" },
                type: "text",
                optional: true,
              },
            ],
          }
        : {}),
    });

    if (!session?.url) {
      return res.status(500).json({ message: "Failed to create checkout session." });
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      url: session.url,
      sessionId: session.id,
      planKey: String(plan.key),
      emailPrefilled: !!email,
    });
  } catch (e) {
    const status = e?.statusCode || 500;
    return res.status(status).json({ message: e?.message || "Server error" });
  }
}
