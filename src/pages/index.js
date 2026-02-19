// pages/index.js
import { useEffect, useRef } from "react";
import AppShell from "../components/AppShell";
import BootScreen from "../components/BootScreen";
import { useAuth } from "../contexts/AuthContext";
import { useFfmpeg } from "../contexts/FfmpegContext";
import { useThreads } from "../contexts/threadsContext";
import { toast } from "sonner";
import SEOHead from "@/components/SEOHead";

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
      <SEOHead
    title="AI Transcription, Translation & Summarization"
    description="HappySRT is an open-source AI transcription, translation, and summarization app. Upload audio/video and get transcripts, translations, and summaries fast."
    path="/"
  />

  {/* Optional but recommended: visible SSR text for crawlers */}
  <main style={{ position: "absolute", left: -9999, top: "auto", width: 1, height: 1, overflow: "hidden" }}>
    <h1>HappySRT — AI transcription, translation, and summarization</h1>
    <p>
      Open-source web app to transcribe audio/video, translate into multiple languages, and generate summaries.
    </p>
  </main>

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
