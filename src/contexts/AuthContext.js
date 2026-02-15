// contexts/AuthContext.js
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
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

  const [user, setUser] = useState(null);
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [isAnonymous, setIsAnonymous] = useState(true);

  // Authoritative server snapshot
  const [tokens, setTokens] = useState({
    mediaTokens: 0, // available
    mediaTokensBalance: 0,
    mediaTokensReserved: 0, // server reserved
    provider: null,
    pricingVersion: null,
    serverTime: null,
  });

  // ✅ Client optimistic reservations (blue “potential used”)
  // key -> token amount
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
      // avoid churn if same
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

  // ✅ allow WS (and other sources) to update token state safely with partial payloads
  const applyTokensSnapshot = (snap) => {
    if (!snap || typeof snap !== "object") return;

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
  };

  const getAccount = () => {
    if (!appwriteRef.current) appwriteRef.current = makeAppwrite();
    return appwriteRef.current.account;
  };

  const refreshUser = async () => {
    const account = getAccount();
    try {
      const u = await account.get();
      setUser(u || null);
      setIsAnonymous(!u?.$id);
      return u || null;
    } catch {
      setUser(null);
      setIsAnonymous(true);
      return null;
    }
  };

  const getJwt = async ({ force } = {}) => {
    if (typeof window === "undefined") return null;
    const account = getAccount();

    const now = Date.now();
    const cached = jwtCacheRef.current || {};
    if (!force && cached.jwt && now - (cached.at || 0) < 3 * 60 * 1000) {
      return cached.jwt;
    }

    try {
      const r = await account.createJWT();
      const jwt = r?.jwt ? String(r.jwt) : null;
      jwtCacheRef.current = { jwt: jwt || null, at: now };
      return jwt || null;
    } catch {
      jwtCacheRef.current = { jwt: null, at: now };
      return null;
    }
  };

  const refreshTokens = async ({ forceJwt } = {}) => {
    if (isAnonymous) return null;

    const jwt = await getJwt({ force: !!forceJwt });
    if (!jwt) return null;

    const data = await fetchTokensWithJwt(jwt);
    if (data && typeof data === "object") {
      applyTokensSnapshot({
        mediaTokens: data.mediaTokens,
        mediaTokensBalance: data.mediaTokensBalance,
        mediaTokensReserved: data.mediaTokensReserved,
        provider: data.provider || null,
        pricingVersion: data.pricingVersion || null,
        serverTime: data.serverTime || null,
      });
    }
    return data;
  };

  // Boot: restore session then refresh tokens once
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoadingAuth(true);
      try {
        const u = await refreshUser();
        if (!alive) return;

        if (u?.$id) {
          await refreshTokens({ forceJwt: true });
        }
      } finally {
        if (alive) setLoadingAuth(false);
      }
    })();

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!user?.$id) return;
    if (isAnonymous) return;

    refreshTokens({ forceJwt: true }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.$id, isAnonymous]);

  const logout = async () => {
    try {
      const account = getAccount();
      await account.deleteSessions();
    } catch {}

    jwtCacheRef.current = { jwt: null, at: 0 };
    setUser(null);
    setIsAnonymous(true);
    setOptimisticReservedByKey({});
    setTokens({
      mediaTokens: 0,
      mediaTokensBalance: 0,
      mediaTokensReserved: 0,
      provider: null,
      pricingVersion: null,
      serverTime: null,
    });
  };

  const tokenSnapshot = {
    mediaTokens: tokens.mediaTokens,
    mediaTokensBalance: tokens.mediaTokensBalance,
    mediaTokensReserved: tokens.mediaTokensReserved,
    provider: tokens.provider || null,
    pricingVersion: tokens.pricingVersion || null,
    serverTime: tokens.serverTime || null,
  };

  const value = useMemo(() => {
    const serverReserved = Number(tokens.mediaTokensReserved || 0) || 0;

    return {
      user,
      loading: loadingAuth,
      loadingAuth,
      isAnonymous,

      getJwt,
      refreshUser,
      refreshTokens,
      applyTokensSnapshot,

      // server snapshot
      tokens,
      mediaTokens: tokens.mediaTokens,
      tokenSnapshot,

      // ✅ pending = server reserved + optimistic reserved (“blue potential used”)
      pendingMediaTokens: Math.max(0, serverReserved + optimisticReserved),

      // ✅ optimistic reservation API (client-side)
      reserveMediaTokens,
      releaseMediaTokens,
      clearAllMediaReservations,

      // helpful for debugging UI
      optimisticReserved,

      logout,
    };
  }, [user, loadingAuth, isAnonymous, tokens, optimisticReserved]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider />");
  return ctx;
}
