// server/appwriteAuth.js
function cleanJwtFromAuthHeader(req) {
  const auth = req.headers.authorization || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

async function appwriteFetch({ endpoint, project, jwt, path }) {
  const res = await fetch(`${endpoint}${path}`, {
    headers: {
      "X-Appwrite-Project": project,
      "X-Appwrite-JWT": jwt,
    },
  });
  return res;
}

function normalizeProvider(p) {
  const s = String(p || "").toLowerCase().trim();
  if (!s) return "";
  // treat any "google*" as google
  if (s === "google" || s.includes("google")) return "google";
  return s;
}

function pickMinTokensFromProvider(provider) {
  return normalizeProvider(provider) === "google" ? 50 : 5;
}

async function detectProvider({ endpoint, project, jwt }) {
  // 1) sessions/current
  try {
    const r = await appwriteFetch({ endpoint, project, jwt, path: "/account/sessions/current" });
    if (r.ok) {
      const session = await r.json();
      const p = normalizeProvider(session?.provider);
      if (p) return { provider: p, session };
    }
  } catch {}

  // 2) identities (best fallback for oauth)
  try {
    const r = await appwriteFetch({ endpoint, project, jwt, path: "/account/identities" });
    if (r.ok) {
      const data = await r.json();
      const list = Array.isArray(data?.identities) ? data.identities : Array.isArray(data) ? data : [];
      // prefer google identity if present
      const google = list.find((x) => normalizeProvider(x?.provider) === "google");
      if (google) return { provider: "google", session: null };

      // otherwise any provider we can normalize
      const any = list.find((x) => normalizeProvider(x?.provider));
      if (any) return { provider: normalizeProvider(any.provider), session: null };
    }
  } catch {}

  // 3) sessions list fallback (sometimes current endpoint flakes)
  try {
    const r = await appwriteFetch({ endpoint, project, jwt, path: "/account/sessions" });
    if (r.ok) {
      const data = await r.json();
      const sessions = Array.isArray(data?.sessions) ? data.sessions : Array.isArray(data) ? data : [];
      const cur = sessions.find((s) => s?.current) || sessions[0];
      const p = normalizeProvider(cur?.provider);
      if (p) return { provider: p, session: cur || null };
    }
  } catch {}

  return { provider: "", session: null };
}

export async function requireAppwriteUser(req) {
  const jwt = cleanJwtFromAuthHeader(req);

  if (!jwt) {
    const err = new Error("Missing Authorization Bearer token");
    err.statusCode = 401;
    throw err;
  }

  const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT;
  const project = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID;

  if (!endpoint || !project) {
    const err = new Error("Missing Appwrite env (NEXT_PUBLIC_APPWRITE_ENDPOINT/PROJECT_ID)");
    err.statusCode = 500;
    throw err;
  }

  // 1) Account
  const accountRes = await appwriteFetch({ endpoint, project, jwt, path: "/account" });

  if (!accountRes.ok) {
    const err = new Error("Invalid Appwrite session");
    err.statusCode = 401;
    throw err;
  }

  const user = await accountRes.json();

  // 2) Provider (robust)
  const { provider, session } = await detectProvider({ endpoint, project, jwt });

  const mediaTokensMin = pickMinTokensFromProvider(provider);

  return {
    user,
    userId: user.$id,
    session,
    provider,       // "google" if any google-ish identity/session
    mediaTokensMin, // google => 50, else 5
  };
}
