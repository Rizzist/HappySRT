// pages/api/auth/tokens.js
import { pool } from "../../../server/crdb";
import { requireAppwriteUser } from "../../../server/appwriteAuth";
import Billing from "../../../shared/billingCatalog";

const PRICING_VERSION = Billing?.PRICING_VERSION || "v1_2026-02-14";

function normalizeProvider(p) {
  const s = String(p || "").toLowerCase().trim();
  if (!s) return "";
  if (s === "google" || s.includes("google")) return "google";
  return s;
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  try {
    const { userId, provider, mediaTokensMin } = await requireAppwriteUser(req);
    const uid = String(userId || "");
    if (!uid) return res.status(401).json({ message: "Unauthorized" });

    const providerNorm = normalizeProvider(provider);
    const desiredMin = Number(mediaTokensMin || 0) || (providerNorm === "google" ? 50 : 5);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `INSERT INTO account_tokens (user_id, pricing_version, bootstrap_min)
         VALUES ($1, $2, 0)
         ON CONFLICT (user_id) DO NOTHING`,
        [uid, PRICING_VERSION]
      );

      const r = await client.query(
        `SELECT media_balance, media_reserved, pricing_version, bootstrap_min
         FROM account_tokens
         WHERE user_id = $1
         FOR UPDATE`,
        [uid]
      );

      const row = r.rows[0] || {};
      let balance = Number(row.media_balance || 0) || 0;
      let reserved = Number(row.media_reserved || 0) || 0;
      const bootstrapMin = Number(row.bootstrap_min || 0) || 0;

      if (!Number.isFinite(reserved) || reserved < 0 || reserved > balance) {
        reserved = 0;
        await client.query(
          `UPDATE account_tokens
           SET media_reserved = 0, updated_at = now()
           WHERE user_id = $1`,
          [uid]
        );
      }

      if (desiredMin > bootstrapMin) {
        const target = desiredMin;

        if (balance < target) {
          const delta = target - balance;

          await client.query(
            `UPDATE account_tokens
             SET media_balance = media_balance + $2,
                 bootstrap_min = $3,
                 pricing_version = $4,
                 updated_at = now()
             WHERE user_id = $1`,
            [uid, delta, target, PRICING_VERSION]
          );

          await client.query(
            `INSERT INTO token_ledger (user_id, delta, kind, ref_type, ref_id, meta)
             VALUES ($1, $2, 'grant', 'bootstrap', NULL, $3::jsonb)`,
            [
              uid,
              delta,
              JSON.stringify({
                reason: "min_default_upgrade",
                provider: providerNorm,
                desiredMin: target,
                prevBootstrapMin: bootstrapMin,
              }),
            ]
          );

          balance = target;
        } else {
          await client.query(
            `UPDATE account_tokens
             SET bootstrap_min = $2,
                 pricing_version = $3,
                 updated_at = now()
             WHERE user_id = $1`,
            [uid, target, PRICING_VERSION]
          );
        }
      } else {
        await client.query(
          `UPDATE account_tokens
           SET pricing_version = $2,
               updated_at = now()
           WHERE user_id = $1 AND pricing_version <> $2`,
          [uid, PRICING_VERSION]
        );
      }

      await client.query("COMMIT");

      const available = Math.max(0, balance - reserved);

      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({
        ok: true,
        tokensHydrated: true,

        userId: uid,
        provider: providerNorm || null,
        pricingVersion: PRICING_VERSION,

        desiredMin,
        bootstrapMin: Math.max(bootstrapMin, desiredMin),

        mediaTokens: available,
        mediaTokensBalance: balance,
        mediaTokensReserved: reserved,

        serverTime: new Date().toISOString(),
      });
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {}
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    const code = e.statusCode || 500;
    return res.status(code).json({ message: e?.message || "Server error" });
  }
}
