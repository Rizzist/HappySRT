// pages/index.js
import AppShell from "../components/AppShell";
import BootScreen from "../components/BootScreen";
import { useAuth } from "../contexts/AuthContext";
import { useFfmpeg } from "../contexts/FfmpegContext";
import { useThreads } from "../contexts/threadsContext";

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
  } = useAuth();

  const { ffmpegReady, ffmpegLoading, ffmpegError } = useFfmpeg();

  // threads boot/sync
  const { loadingThreads, syncError } = useThreads();

  // Threads sync should only block boot AFTER auth finishes
  const threadsBootLoading = !authLoading && loadingThreads;

  const showBoot = authLoading || ffmpegLoading || threadsBootLoading;

  const bootError = ffmpegError || syncError || null;

  const steps = [
    {
      label: "Checking sign-in…",
      state: authLoading ? "doing" : "done",
    },
    {
      label: "Loading FFmpeg engine…",
      state: ffmpegReady ? "done" : ffmpegLoading ? "doing" : "pending",
    },
    {
      label: "Fetching / syncing threads history…",
      // not started until auth done
      state: authLoading ? "pending" : loadingThreads ? "doing" : "done",
    },
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
        />
      )}
    </>
  );
}
