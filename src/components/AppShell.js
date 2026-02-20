// components/AppShell.js
import { useEffect, useState, useCallback } from "react";
import styled from "styled-components";
import Sidebar from "./Sidebar";
import ThreadView from "./ThreadView";
import { useThreads } from "../contexts/threadsContext";
import { Toaster, toast } from "sonner";
import useMediaQuery from "../hooks/useMediaQuery";

import UpgradePlansModal from "./UpgradePlansModal";
import { onUpgradeRequested } from "../lib/upgradeBus";

export default function AppShell({
  user,
  isAnonymous,

  mediaTokens,
  tokenSnapshot,
  pendingMediaTokens,

  onGoogleLogin,
  onLogout,

  onStartCheckout,
}) {
  const {
    threads,
    activeId,
    setActiveId,
    activeThread,
    loadingThreads,
    createThread,
    creatingThread,
  } = useThreads();

  const isMobile = useMediaQuery("(max-width: 860px)");

  // desktop-only collapse (58px)
  const [collapsed, setCollapsed] = useState(false);

  // mobile drawer open/close
  const [sidebarOpen, setSidebarOpen] = useState(!isMobile);

  // ✅ Modal state lives here (NOT inside Sidebar/UserBadge)
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [busyPlanKey, setBusyPlanKey] = useState("");

  useEffect(() => {
    if (isMobile) {
      setSidebarOpen(false);
      setCollapsed(false);
    } else {
      setSidebarOpen(true);
    }
  }, [isMobile]);

  const openSidebar = () => setSidebarOpen(true);
  const closeSidebar = () => setSidebarOpen(false);

  const handleSelectThread = (id) => {
    setActiveId(id);
    if (isMobile) closeSidebar();
  };

  const handleCreateThread = async () => {
    await createThread();
    if (isMobile) closeSidebar();
  };

  // ✅ Single “open upgrade” entry point
  const openUpgrade = useCallback(() => {
    if (isAnonymous) {
      toast.error("Sign in to upgrade.");
      return;
    }
    // optional: close sidebar on mobile so the sheet feels native
    if (isMobile) closeSidebar();
    setUpgradeOpen(true);
  }, [isAnonymous, isMobile]);

  const closeUpgrade = useCallback(() => {
    setUpgradeOpen(false);
    setBusyPlanKey("");
  }, []);

  // ✅ Start checkout from the modal (centralized)
  const handleSelectPlan = useCallback(
    async (pk) => {
      if (typeof onStartCheckout !== "function") {
        toast("Checkout hook not wired yet (onStartCheckout).");
        return;
      }

      try {
        setBusyPlanKey(String(pk || ""));
        await onStartCheckout(pk);
        setUpgradeOpen(false);
      } catch (e) {
        toast(e?.message || "Failed to start checkout");
      } finally {
        setBusyPlanKey("");
      }
    },
    [onStartCheckout]
  );

  // ✅ Optional but recommended: listen for upgrade requests globally (upgradeBus)
  useEffect(() => {
    return onUpgradeRequested(() => openUpgrade());
  }, [openUpgrade]);

  const sidebarVisible = !isMobile || sidebarOpen;
  const desktopCollapsed = !isMobile && collapsed;
  const showMobileHeaderActions = isMobile && !sidebarOpen;

  return (
    <Shell>
      <Toaster position="bottom-right" richColors />

      <Sidebar
        mobile={isMobile}
        open={sidebarVisible}
        onClose={closeSidebar}
        collapsed={desktopCollapsed}
        onToggle={() => setCollapsed((v) => !v)}
        threads={threads}
        activeId={activeId}
        onSelect={handleSelectThread}
        onCreateThread={handleCreateThread}
        creatingThread={creatingThread}
        user={user}
        isAnonymous={isAnonymous}
        mediaTokens={mediaTokens}
        tokenSnapshot={tokenSnapshot}
        pendingMediaTokens={pendingMediaTokens}
        onGoogleLogin={onGoogleLogin}
        onLogout={onLogout}
        onStartCheckout={onStartCheckout}

        // ✅ NEW: open modal from anywhere
        onOpenUpgrade={openUpgrade}
      />

      {isMobile && sidebarOpen && (
        <Scrim type="button" onClick={closeSidebar} aria-label="Close sidebar" />
      )}

      <Main>
        <ThreadView
          thread={activeThread}
          loading={loadingThreads}
          showMobileHeaderActions={showMobileHeaderActions}
          onOpenSidebar={openSidebar}
          onCreateThread={handleCreateThread}
          creatingThread={creatingThread}
        />
      </Main>

      {/* ✅ Render modal ONCE at app root */}
      <UpgradePlansModal
        open={!!upgradeOpen}
        onClose={closeUpgrade}
        onSelectPlan={handleSelectPlan}
        busyPlanKey={busyPlanKey}
        onLogout={onLogout}
      />
    </Shell>
  );
}

const Shell = styled.div`
  height: 100vh;
  width: 100%;
  display: flex;
  overflow: hidden;
  background: var(--bg);
`;

const Main = styled.main`
  flex: 1;
  min-width: 0;
  display: flex;
  background: var(--bg);
`;

const Scrim = styled.button`
  position: fixed;
  inset: 0;
  border: 0;
  padding: 0;
  background: rgba(0, 0, 0, 0.35);
  z-index: 40;
`;
