// contexts/AuthContext.js
import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
} from "react";
import { Client, Account } from "appwrite";

const AuthContext = createContext(null);

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function makeAppwrite() {
  const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT;
  const project = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID;

  if (!endpoint || !project) {
    throw new Error("Missing Appwrite env (NEXT_PUBLIC_APPWRITE_ENDPOINT/PROJECT_ID)");
  }

  const client = new Client();
  client.setEndpoint(endpoint);
  client.setProject(project);

  const account = new Account(client);
  return { client, account };
}

async function fetchTokensWithJwt(jwt) {
  if (!jwt) return null;

  const res = await fetch("/api/auth/tokens", {
    method: "GET",
    headers: { authorization: `Bearer ${jwt}` },
    credentials: "include",
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.message || "Failed to refresh tokens");
    err.statusCode = res.status;
    throw err;
  }
  return data;
}

async function fetchBillingSyncWithJwt(jwt, sessionId) {
  if (!jwt) return null;

  const res = await fetch("/api/billing/sync", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${jwt}`,
    },
    credentials: "include",
    body: JSON.stringify(sessionId ? { sessionId } : {}),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.message || "Billing sync failed");
    err.statusCode = res.status;
    throw err;
  }
  return data;
}

function sumObjNumbers(obj) {
  const o = obj && typeof obj === "object" ? obj : {};
  let total = 0;
  for (const v of Object.values(o)) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) total += n;
  }
  return total;
}

export function AuthProvider({ children }) {
  const appwriteRef = useRef(null);
  const jwtCacheRef = useRef({ jwt: null, at: 0 });

  // throttle / de-dupe refs
  const tokensFetchRef = useRef({ inflight: null, at: 0 });
  const billingSyncRef = useRef({ inflight: null, at: 0, key: "", lastData: null });

  const [user, setUser] = useState(null);
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [isAnonymous, setIsAnonymous] = useState(true);

  // ✅ indicates whether we have received at least one authoritative server token snapshot
  const [tokensHydrated, setTokensHydrated] = useState(false);

  // Authoritative server snapshot
  const [tokens, setTokens] = useState({
    mediaTokens: 0, // available
    mediaTokensBalance: 0,
    mediaTokensReserved: 0,
    provider: null,
    pricingVersion: null,
    serverTime: null,
  });

  // ✅ Billing / plan snapshot (from /billing/sync mainly)
  const [billing, setBilling] = useState({
    planKey: "free",
    planName: "free",
    monthlyFloor: 0,
    pricingVersion: null,

    hasSubscription: false,
    subscriptionId: null,
    subscriptionStatus: null,

    periodStart: null,
    periodEnd: null,

    serverTime: null,
  });

  // Client optimistic reservations
  const [optimisticReservedByKey, setOptimisticReservedByKey] = useState({});

  const optimisticReserved = useMemo(() => {
    return sumObjNumbers(optimisticReservedByKey);
  }, [optimisticReservedByKey]);

  const reserveMediaTokens = (key, amount) => {
    const k = String(key || "").trim();
    const n = Math.max(0, Number(amount || 0) || 0);
    if (!k || n <= 0) return;

    setOptimisticReservedByKey((prev) => {
      const cur = prev && typeof prev === "object" ? prev : {};
      if (Number(cur[k] || 0) === n) return prev;
      return { ...cur, [k]: n };
    });
  };

  const releaseMediaTokens = (key) => {
    const k = String(key || "").trim();
    if (!k) return;
    setOptimisticReservedByKey((prev) => {
      const cur = prev && typeof prev === "object" ? prev : {};
      if (!hasOwn(cur, k)) return prev;
      const next = { ...cur };
      delete next[k];
      return next;
    });
  };

  const clearAllMediaReservations = () => {
    setOptimisticReservedByKey({});
  };

const applyTokensSnapshot = useCallback((snap) => {
  if (!snap || typeof snap !== "object") return;

  const hasTokenFields =
    hasOwn(snap, "mediaTokens") ||
    hasOwn(snap, "mediaTokensBalance") ||
    hasOwn(snap, "mediaTokensReserved");

  setTokens((prev) => {
    const next = { ...(prev || {}) };
    if (hasOwn(snap, "mediaTokens")) next.mediaTokens = Number(snap.mediaTokens || 0) || 0;
    if (hasOwn(snap, "mediaTokensBalance")) next.mediaTokensBalance = Number(snap.mediaTokensBalance || 0) || 0;
    if (hasOwn(snap, "mediaTokensReserved")) next.mediaTokensReserved = Number(snap.mediaTokensReserved || 0) || 0;
    if (hasOwn(snap, "provider")) next.provider = snap.provider || null;
    if (hasOwn(snap, "pricingVersion")) next.pricingVersion = snap.pricingVersion || null;
    if (hasOwn(snap, "serverTime")) next.serverTime = snap.serverTime || null;
    return next;
  });

  if (snap.tokensHydrated === true || hasTokenFields) setTokensHydrated(true);
}, []);


  const applyBillingSnapshot = useCallback((snap) => {
    if (!snap || typeof snap !== "object") return;

    setBilling((prev) => {
      const next = { ...(prev || {}) };

      if (hasOwn(snap, "planKey")) next.planKey = String(snap.planKey || "").trim() || next.planKey;
      if (hasOwn(snap, "planName")) next.planName = String(snap.planName || "").trim() || next.planName;
      if (hasOwn(snap, "monthlyFloor")) next.monthlyFloor = Math.max(0, Number(snap.monthlyFloor || 0) || 0);
      if (hasOwn(snap, "pricingVersion")) next.pricingVersion = snap.pricingVersion || null;

      if (hasOwn(snap, "hasSubscription")) next.hasSubscription = !!snap.hasSubscription;
      if (hasOwn(snap, "subscriptionId")) next.subscriptionId = snap.subscriptionId || null;
      if (hasOwn(snap, "subscriptionStatus")) next.subscriptionStatus = snap.subscriptionStatus || null;

      if (hasOwn(snap, "periodStart")) next.periodStart = snap.periodStart || null;
      if (hasOwn(snap, "periodEnd")) next.periodEnd = snap.periodEnd || null;

      if (hasOwn(snap, "serverTime")) next.serverTime = snap.serverTime || null;

      return next;
    });
  }, []);

  const getAccount = useCallback(() => {
    if (!appwriteRef.current) appwriteRef.current = makeAppwrite();
    return appwriteRef.current.account;
  }, []);

  const ensureSession = useCallback(async () => {
  const account = getAccount();

  try {
    const u = await account.get();
    return u || null;
  } catch {
    // No session -> create anonymous session
    try {
      await account.createAnonymousSession();
      const u = await account.get();
      return u || null;
    } catch {
      return null;
    }
  }
}, [getAccount]);


  const refreshUser = useCallback(async () => {
    const account = getAccount();
    try {
      const u = await account.get();
      setUser(u || null);
      const s = await account.getSession("current").catch(() => null);
      const provider = String(s?.provider || "").toLowerCase().trim();
      const anon = provider === "anonymous";
      setIsAnonymous(anon || !u?.$id);

      return u || null;
    } catch {
      setUser(null);
      setIsAnonymous(true);
      return null;
    }
  }, [getAccount]);

const getJwt = useCallback(async ({ force } = {}) => {
  if (typeof window === "undefined") return null;

  const account = getAccount();
  const now = Date.now();

  const cached = jwtCacheRef.current || {};
  if (!force && cached.jwt && now - (cached.at || 0) < 3 * 60 * 1000) {
    return cached.jwt;
  }

  async function mint() {
    const r = await account.createJWT();
    const jwt = r?.jwt ? String(r.jwt) : null;
    jwtCacheRef.current = { jwt: jwt || null, at: Date.now() };
    return jwt || null;
  }

  try {
    return await mint();
  } catch {
    // ✅ no session -> create anonymous and retry
    try {
      await ensureSession(); // <-- uses createAnonymousSession if needed
      return await mint();
    } catch {
      jwtCacheRef.current = { jwt: null, at: Date.now() };
      return null;
    }
  }
}, [getAccount, ensureSession]);


  function getProviderFromSession(s) {
    return String(s?.provider || "").toLowerCase().trim();
  }

  const loginWithGoogle = useCallback(async () => {
    if (typeof window === "undefined") return;

    const account = getAccount();
    const origin = window.location.origin;

    try {
      const s = await account.getSession("current");
      if (getProviderFromSession(s) === "anonymous") {
        await account.deleteSession("current");
      }
    } catch {}

    account.createOAuth2Session("google", origin, origin);
  }, [getAccount]);

  // Throttled tokens refresh
const refreshTokens = useCallback(async ({ forceJwt, force } = {}) => {
  const now = Date.now();
  const state = tokensFetchRef.current || {};

  if (!force && state.inflight) return state.inflight;
  if (!force && state.at && now - state.at < 3000) return null;

  const p = (async () => {
    const jwt = await getJwt({ force: !!forceJwt });
    if (!jwt) return null;

    const data = await fetchTokensWithJwt(jwt);
    if (data && typeof data === "object") applyTokensSnapshot(data);
    return data;
  })();

  tokensFetchRef.current = { inflight: p, at: now };

  try {
    return await p;
  } finally {
    tokensFetchRef.current = { inflight: null, at: Date.now() };
  }
}, [getJwt, applyTokensSnapshot]);


  // Stripe billing sync (throttled)
  const syncBilling = useCallback(
    async ({ sessionId, force } = {}) => {
      if (isAnonymous) return null;

      const uid = String(user?.$id || "").trim();
      if (!uid) return null;

      const sid = String(sessionId || "").trim();
      const key = sid ? `sid:${sid}` : `uid:${uid}`;

      const now = Date.now();
      const state = billingSyncRef.current || {};

      if (!force && state.key === key && state.lastData && now - (state.at || 0) < 15000) {
        return state.lastData;
      }

      if (!force && state.inflight && state.key === key && now - (state.at || 0) < 15000) {
        return state.inflight;
      }

      const p = (async () => {
        const jwt = await getJwt({ force: true });
        if (!jwt) return null;

        const data = await fetchBillingSyncWithJwt(jwt, sid || "");
        if (data && typeof data === "object") {
          // billing contains plan info + (often) token snapshot too
          applyBillingSnapshot(data);

          const hasTokenFields =
            hasOwn(data, "mediaTokens") ||
            hasOwn(data, "mediaTokensBalance") ||
            hasOwn(data, "mediaTokensReserved");

          if (hasTokenFields) {
            applyTokensSnapshot(data);
          }

        }
        return data;
      })();

      billingSyncRef.current = { inflight: p, at: now, key, lastData: state.lastData || null };

      try {
        const out = await p;
        billingSyncRef.current = { inflight: null, at: Date.now(), key, lastData: out || null };
        return out;
      } catch (e) {
        billingSyncRef.current = { inflight: null, at: Date.now(), key, lastData: state.lastData || null };
        throw e;
      }
    },
    [isAnonymous, user?.$id, getJwt, applyBillingSnapshot, applyTokensSnapshot]
  );

  // Boot: restore session then sync billing (preferred), fallback to /tokens
  useEffect(() => {
  let alive = true;

  (async () => {
    setLoadingAuth(true);
    try {
      const account = getAccount();

      // Ensure we have *some* session (anonymous or real)
      await ensureSession();

      // ✅ actually set user + isAnonymous from Appwrite
      const u = await refreshUser();
      if (!alive) return;

      if (u?.$id) {
        // Optional: only try billing sync for non-anon
        let sync = null;
        if (!String((await account.getSession("current").catch(() => null))?.provider || "")
              .toLowerCase().includes("anonymous")) {
          try { sync = await syncBilling({ force: true }); } catch {}
        }

        if (!sync || sync.tokensHydrated !== true) {
          await refreshTokens({ forceJwt: true, force: true });
        }
      }
    } finally {
      if (alive) setLoadingAuth(false);
    }
  })();

  return () => { alive = false; };
}, []);


  // Post-auth sync
  const postAuthRef = useRef({ uid: "", at: 0 });
  useEffect(() => {
    const uid = String(user?.$id || "").trim();
    if (!uid) return;
    if (isAnonymous) return;

    const now = Date.now();
    if (postAuthRef.current.uid === uid && now - (postAuthRef.current.at || 0) < 15000) return;
    postAuthRef.current = { uid, at: now };

    (async () => {
      let sync = null;
      try {
        sync = await syncBilling({});
      } catch {}

      if (!sync || sync.tokensHydrated !== true) {
        await refreshTokens({ forceJwt: true }).catch(() => {});
      }
    })();
  }, [user?.$id, isAnonymous, syncBilling, refreshTokens]);

const logout = useCallback(async () => {
  const account = getAccount();

  try {
    await account.deleteSessions(); // kills google + anon, everything
  } catch {}

  // Clear client caches/state
  jwtCacheRef.current = { jwt: null, at: 0 };
  tokensFetchRef.current = { inflight: null, at: 0 };
  billingSyncRef.current = { inflight: null, at: 0, key: "", lastData: null };

  setUser(null);
  setIsAnonymous(true);
  setTokensHydrated(false);
  setOptimisticReservedByKey({});

  setTokens({
    mediaTokens: 0,
    mediaTokensBalance: 0,
    mediaTokensReserved: 0,
    provider: null,
    pricingVersion: null,
    serverTime: null,
  });

  setBilling({
    planKey: "free",
    planName: "free",
    monthlyFloor: 0,
    pricingVersion: null,
    hasSubscription: false,
    subscriptionId: null,
    subscriptionStatus: null,
    periodStart: null,
    periodEnd: null,
    serverTime: null,
  });

  // ✅ Create guest session right away
  await ensureSession();
  await refreshUser();

  // ✅ Hydrate tokens for the new guest user (works because getJwt self-heals)
  await refreshTokens({ forceJwt: true, force: true });
}, [getAccount, ensureSession, refreshUser, refreshTokens]);


  const tokenSnapshot = {
    mediaTokens: tokens.mediaTokens,
    mediaTokensBalance: tokens.mediaTokensBalance,
    mediaTokensReserved: tokens.mediaTokensReserved,
    provider: tokens.provider || null,
    pricingVersion: tokens.pricingVersion || null,
    serverTime: tokens.serverTime || null,
    tokensHydrated: !!tokensHydrated,
  };

  const value = useMemo(() => {
    const serverReserved = Number(tokens.mediaTokensReserved || 0) || 0;

    return {
      user,
      loading: loadingAuth,
      loadingAuth,
      isAnonymous,

      // ✅ plan/billing info
      billing,
      planKey: billing.planKey,
      planName: billing.planName,
      monthlyFloor: billing.monthlyFloor,

      // ✅ tokens hydration
      tokensHydrated,

      loginWithGoogle,

      getJwt,
      refreshUser,
      refreshTokens,
      syncBilling,
      applyTokensSnapshot,

      tokens,
      mediaTokens: tokens.mediaTokens,
      tokenSnapshot,

      pendingMediaTokens: Math.max(0, serverReserved + optimisticReserved),

      reserveMediaTokens,
      releaseMediaTokens,
      clearAllMediaReservations,

      optimisticReserved,

      logout,
    };
  }, [
    user,
    loadingAuth,
    isAnonymous,
    billing,
    tokensHydrated,
    tokens,
    optimisticReserved,
    loginWithGoogle,
    getJwt,
    refreshUser,
    refreshTokens,
    syncBilling,
    applyTokensSnapshot,
    logout,
  ]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider />");
  return ctx;
}
