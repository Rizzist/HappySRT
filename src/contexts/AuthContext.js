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
    // Don't hard-crash SSR; just throw in client runtime usage
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

export function AuthProvider({ children }) {
  const appwriteRef = useRef(null);
  const jwtCacheRef = useRef({ jwt: null, at: 0 });

  const [user, setUser] = useState(null);
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [isAnonymous, setIsAnonymous] = useState(true);

  // Optional, but handy if you show tokens in UI
  const [tokens, setTokens] = useState({
    mediaTokens: 0,
    mediaTokensBalance: 0,
    mediaTokensReserved: 0,
    provider: null,
    pricingVersion: null,
    serverTime: null,
  });


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

    // Cache a JWT briefly to avoid spamming createJWT on every request.
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

  // ✅ This is the actual "3)" logic: call /api/auth/tokens after login/restore
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

  // Boot: restore session (auto-login) then refresh tokens once
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoadingAuth(true);
      try {
        const u = await refreshUser();
        if (!alive) return;

        if (u?.$id) {
          // will auto-grant to 50 for google after your server-side fix
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

  // If user changes from logged out -> logged in in-app, refresh tokens again
  useEffect(() => {
    if (!user?.$id) return;
    if (isAnonymous) return;

    refreshTokens({ forceJwt: true }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.$id, isAnonymous]);

  // Optional helpers (useful for UI buttons)
  const logout = async () => {
    try {
      const account = getAccount();
      await account.deleteSessions();
    } catch {}
    jwtCacheRef.current = { jwt: null, at: 0 };
    setUser(null);
    setIsAnonymous(true);
    setTokens({
      mediaTokens: 0,
      mediaTokensBalance: 0,
      mediaTokensReserved: 0,
      provider: null,
      pricingVersion: null,
      serverTime: null,
    });
  };

  const value = useMemo(() => {
    return {
      user,
      loadingAuth,
      isAnonymous,

      getJwt,
      refreshUser,
      refreshTokens,
      applyTokensSnapshot,

      // optional token state (if you want to show it in UI)
      tokens,
      mediaTokens: tokens.mediaTokens,

      logout,
    };
  }, [user, loadingAuth, isAnonymous, tokens]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider />");
  return ctx;
}
