// pages/index.js
import { useEffect, useRef } from "react";
import AppShell from "../components/AppShell";
import BootScreen from "../components/BootScreen";
import { useAuth } from "../contexts/AuthContext";
import { useFfmpeg } from "../contexts/FfmpegContext";
import { useThreads } from "../contexts/threadsContext";
import { toast } from "sonner";

export default function Home() {
  const {
    user,
    loading: authLoading,
    isAnonymous,
    mediaTokens,
    tokenSnapshot,
    pendingMediaTokens,
    loginWithGoogle,
    logout,
    getJwt,
    syncBilling, // ✅
  } = useAuth();

  const { ffmpegReady, ffmpegLoading, ffmpegError } = useFfmpeg();
  const { loadingThreads, syncError } = useThreads();

  const threadsBootLoading = !authLoading && loadingThreads;
  const showBoot = authLoading || ffmpegLoading || threadsBootLoading;
  const bootError = ffmpegError || syncError || null;

  // ✅ Ensure billing sync runs at least once on homepage after auth
  const didHomeSyncRef = useRef(false);
  useEffect(() => {
    if (authLoading) return;
    if (isAnonymous) return;
    if (!user?.$id) return;

    if (didHomeSyncRef.current) return;
    didHomeSyncRef.current = true;

    // fire & forget (syncBilling is throttled + backend is idempotent)
    Promise.resolve(syncBilling?.({})).catch(() => {});
  }, [authLoading, isAnonymous, user?.$id, syncBilling]);

  const startCheckout = async (planKey) => {
    const jwt = await getJwt({ force: true });
    if (!jwt) {
      toast("Please sign in again.");
      return;
    }

    const res = await fetch("/api/billing/checkout", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${jwt}`,
      },
      credentials: "include",
      body: JSON.stringify({ planKey }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.message || "Checkout failed");
    }

    const url = data?.url ? String(data.url) : "";
    if (!url) throw new Error("Missing checkout URL");

    window.location.href = url;
  };

  const steps = [
    { label: "Checking sign-in…", state: authLoading ? "doing" : "done" },
    { label: "Loading FFmpeg engine…", state: ffmpegReady ? "done" : ffmpegLoading ? "doing" : "pending" },
    { label: "Fetching / syncing threads history…", state: authLoading ? "pending" : loadingThreads ? "doing" : "done" },
  ];

  return (
    <>
      <BootScreen show={showBoot} steps={steps} error={bootError} />

      {!showBoot && (
        <AppShell
          user={user}
          isAnonymous={isAnonymous}
          mediaTokens={mediaTokens}
          tokenSnapshot={tokenSnapshot}
          pendingMediaTokens={pendingMediaTokens}
          onGoogleLogin={loginWithGoogle}
          onLogout={logout}
          onStartCheckout={startCheckout}
        />
      )}
    </>
  );
}
