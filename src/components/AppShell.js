// components/AppShell.js
import { useState } from "react";
import styled from "styled-components";
import Sidebar from "./Sidebar";
import ThreadView from "./ThreadView";
import { useThreads } from "../contexts/threadsContext";

export default function AppShell({
  user,
  isAnonymous,

  mediaTokens,
  tokenSnapshot,
  pendingMediaTokens,

  onGoogleLogin,
  onLogout,
}) {
  const { threads, activeId, setActiveId, activeThread, loadingThreads, createThread } = useThreads();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <Shell>
      <Sidebar
        collapsed={collapsed}
        onToggle={() => setCollapsed((v) => !v)}
        threads={threads}
        activeId={activeId}
        onSelect={setActiveId}
        onCreateThread={createThread}
        user={user}
        isAnonymous={isAnonymous}
        mediaTokens={mediaTokens}
        tokenSnapshot={tokenSnapshot}
        pendingMediaTokens={pendingMediaTokens}
        onGoogleLogin={onGoogleLogin}
        onLogout={onLogout}
      />

      <Main>
        <ThreadView thread={activeThread} loading={loadingThreads} />
      </Main>
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
