// components/Sidebar.js
import styled from "styled-components";
import UserBadge from "./UserBadge";

export default function Sidebar({
  collapsed,
  onToggle,
  threads,
  activeId,
  onSelect,
  onCreateThread,
  creatingThread,
  user,
  isAnonymous,

  // existing
  mediaTokens,

  // step 3
  tokenSnapshot,
  pendingMediaTokens,

  onGoogleLogin,
  onLogout,
}) {
  // ---- base available (server snapshot preferred) ----
  const availableRaw =
    tokenSnapshot && typeof tokenSnapshot.mediaTokens === "number"
      ? tokenSnapshot.mediaTokens
      : typeof mediaTokens === "number"
      ? mediaTokens
      : 0;

  // ---- server reserved (authoritative) ----
  const serverReserved =
    tokenSnapshot && typeof tokenSnapshot.mediaTokensReserved === "number"
      ? tokenSnapshot.mediaTokensReserved
      : tokenSnapshot && typeof tokenSnapshot.pendingMediaTokens === "number"
      ? tokenSnapshot.pendingMediaTokens
      : 0;

  // ---- pending = server reserved + optimistic reserved (from AuthContext) ----
  const pendingRaw =
    typeof pendingMediaTokens === "number"
      ? pendingMediaTokens
      : tokenSnapshot && typeof tokenSnapshot.mediaTokensReserved === "number"
      ? tokenSnapshot.mediaTokensReserved
      : tokenSnapshot && typeof tokenSnapshot.pendingMediaTokens === "number"
      ? tokenSnapshot.pendingMediaTokens
      : 0;

  // normalize
  const baseAvailable = Math.max(0, Number(availableRaw || 0));
  const baseServerReserved = Math.max(0, Number(serverReserved || 0));
  const basePendingRaw = Math.max(0, Number(pendingRaw || 0));

  // optimistic portion = pending - serverReserved
  const optimisticRequested = Math.max(0, basePendingRaw - baseServerReserved);

  // ✅ CAP optimistic so UI cannot "create tokens" when user tries to spend > available
  const optimisticEffective = Math.min(optimisticRequested, baseAvailable);

  // ✅ derive display values (never inflate total)
  const available = Math.max(0, baseAvailable - optimisticEffective);
  const pending = Math.max(0, baseServerReserved + optimisticEffective);

  // ✅ authoritative total should never go up from optimistic moves
  const total = Math.max(0, baseAvailable + baseServerReserved);

  const tokenTitle =
    pending > 0
      ? `Media tokens: ${total} (${available} unused, ${pending} in use)`
      : `Media tokens: ${total} (${available} unused)`;

  return (
    <Wrap $collapsed={collapsed}>
      <Top>
        <Brand>
          <LogoButton
            type="button"
            onClick={collapsed ? onToggle : undefined}
            aria-label={collapsed ? "Expand sidebar" : "Logo"}
            title={collapsed ? "Expand sidebar" : "HappySRT"}
            $clickable={collapsed}
          >
            <LogoImg src="/logo.png" alt="HappySRT" />
            <LogoHoverOverlay $enabled={collapsed}>
              <OverlayIcon aria-hidden="true">»</OverlayIcon>
            </LogoHoverOverlay>
          </LogoButton>

          {!collapsed && <BrandText>HappySRT</BrandText>}
        </Brand>

        {!collapsed && (
          <CollapseButton
            type="button"
            onClick={onToggle}
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
          >
            «
          </CollapseButton>
        )}
      </Top>

      {!collapsed && (
        <>
<NewThreadButton
  type="button"
  onClick={onCreateThread}
  disabled={!!creatingThread}
  title={creatingThread ? "Creating…" : "Create a new thread"}
>
  {creatingThread ? "Creating…" : "+ New thread"}
</NewThreadButton>


          <NavLabel>Threads</NavLabel>

          <ThreadList>
            {threads.map((t) => (
              <ThreadItem
                key={t.id}
                $active={t.id === activeId}
                onClick={() => onSelect(t.id)}
                title={t.title}
              >
                <span>{t.title}</span>
              </ThreadItem>
            ))}
          </ThreadList>
        </>
      )}

      <Footer>
        {!collapsed && (
          <UserBadge
            user={user}
            isAnonymous={isAnonymous}
            // ✅ pass adjusted "unused" + "in-use" so UserBadge total stays stable
            mediaTokens={available}
            pendingMediaTokens={pending}
            onGoogleLogin={onGoogleLogin}
            onLogout={onLogout}
          />
        )}

        {collapsed && (
          <TokenMini title={tokenTitle} aria-label={tokenTitle}>
            <TokenDot $busy={pending > 0} aria-hidden="true" />
            <TokenValue>{total}</TokenValue>
            {pending > 0 && <TokenPending>+{pending}</TokenPending>}
          </TokenMini>
        )}
      </Footer>
    </Wrap>
  );
}

const Wrap = styled.aside`
  width: ${(p) => (p.$collapsed ? "58px" : "250px")};
  transition: width 180ms ease;
  background: var(--panel-2);
  border-right: 1px solid var(--border);

  display: flex;
  flex-direction: column;

  height: 100vh;
  height: 100dvh;
  max-height: 100vh;
  max-height: 100dvh;

  overflow: hidden;

  padding: 14px;
  gap: 12px;
  box-sizing: border-box;
`;

const Top = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
`;

const Brand = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
`;

const LogoButton = styled.button`
  position: relative;
  width: 34px;
  height: 34px;
  padding: 0;
  border: 0;
  border-radius: 10px;
  background: transparent;
  display: inline-grid;
  place-items: center;

  ${(p) =>
    p.$clickable
      ? `
    cursor: default;
    ${Wrap}:hover & { cursor: pointer; }
  `
      : `
    cursor: default;
  `}
`;

const LogoImg = styled.img`
  width: 28px;
  height: 28px;
  object-fit: contain;
  display: block;
  border-radius: 8px;
`;

const LogoHoverOverlay = styled.div`
  position: absolute;
  inset: 0;
  border-radius: 10px;
  opacity: 0;
  pointer-events: none;
  display: grid;
  place-items: center;
  transition: opacity 120ms ease, background 120ms ease, border 120ms ease;

  ${(p) =>
    p.$enabled
      ? `
    ${Wrap}:hover & {
      opacity: 1;
      background: rgba(0, 0, 0, 0.06);
      border: 1px solid var(--border);
    }
  `
      : `
    display: none;
  `}
`;

const OverlayIcon = styled.div`
  font-weight: 800;
  color: var(--text);
  font-size: 16px;
  line-height: 1;
`;

const BrandText = styled.div`
  font-weight: 800;
  letter-spacing: 0.2px;
  white-space: nowrap;
  color: var(--text);
`;

const CollapseButton = styled.button`
  width: 34px;
  height: 34px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
  cursor: pointer;

  &:hover {
    background: var(--hover);
  }
`;

const NewThreadButton = styled.button`
  width: 100%;
  border-radius: 12px;
  border: 1px solid rgba(239, 68, 68, 0.25);
  background: rgba(239, 68, 68, 0.08);
  color: var(--accent);
  font-weight: 900;
  padding: 10px 12px;
  cursor: pointer;

  &:hover {
    background: rgba(239, 68, 68, 0.12);
  }

    &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
`;

const NavLabel = styled.div`
  font-size: 12px;
  color: var(--muted);
  padding: 0 6px;
`;

const ThreadList = styled.div`
  flex: 1 1 auto;
  min-height: 0;

  display: flex;
  flex-direction: column;
  gap: 6px;

  padding-right: 4px;
  overflow: auto;

  overscroll-behavior: contain;
`;

const ThreadItem = styled.button`
  width: 100%;
  text-align: left;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  padding: 10px 10px;

  border-radius: 12px;
  border: 1px solid ${(p) => (p.$active ? "rgba(239,68,68,0.35)" : "transparent")};
  background: ${(p) => (p.$active ? "var(--panel)" : "transparent")};
  color: var(--text);
  cursor: pointer;

  &:hover {
    background: ${(p) => (p.$active ? "var(--panel)" : "rgba(0,0,0,0.04)")};
  }

  span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: ${(p) => (p.$active ? "800" : "650")};
  }
`;

const Footer = styled.div`
  flex: 0 0 auto;

  margin-top: auto;
  padding-top: 12px;

  padding-bottom: calc(10px + env(safe-area-inset-bottom));

  border-top: 1px solid var(--border);
  display: grid;
  gap: 10px;

  background: var(--panel-2);
`;

const TokenMini = styled.div`
  width: 100%;
  height: 36px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--panel);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;

  box-sizing: border-box;
`;

const TokenDot = styled.div`
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: ${(p) =>
    p.$busy ? "rgba(59,130,246,0.95)" : "rgba(34,197,94,0.9)"};
`;

const TokenValue = styled.div`
  font-weight: 900;
  color: var(--text);
  font-size: 13px;
  line-height: 1;
`;

const TokenPending = styled.div`
  font-weight: 900;
  color: rgba(59, 130, 246, 1);
  font-size: 12px;
  line-height: 1;
`;
