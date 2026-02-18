// components/UserBadge.js
import styled, { keyframes } from "styled-components";
import { useMemo, useRef, useState, useEffect } from "react";
import UpgradePlansModal from "./UpgradePlansModal";
import { toast } from "sonner";
import { onUpgradeRequested } from "../lib/upgradeBus"; // ✅ add
import { useAuth } from "../contexts/AuthContext";

function firstAlphaNumChar(str) {
  if (!str) return "";
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (/[A-Za-z0-9]/.test(ch)) return ch;
  }
  return "";
}

function cleanWord(word) {
  return String(word || "")
    .trim()
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/[^A-Za-z0-9]+$/, "");
}

function getInitials(user) {
  const name = (user?.name || "").trim();
  const email = (user?.email || "").trim();
  const source = name || email || "User";

  const words = source
    .split(/\s+/)
    .map(cleanWord)
    .filter((w) => firstAlphaNumChar(w));

  if (words.length === 0) return "US";

  if (words.length === 1) {
    const w = words[0];
    const chars = [];
    for (let i = 0; i < w.length; i++) {
      const ch = w[i];
      if (/[A-Za-z0-9]/.test(ch)) chars.push(ch);
      if (chars.length === 2) break;
    }
    return (chars.join("") || "U").toUpperCase();
  }

  const first = firstAlphaNumChar(words[0]);
  const last = firstAlphaNumChar(words[words.length - 1]);
  return `${first}${last}`.toUpperCase();
}

function normKey(s) {
  return String(s || "").toLowerCase().trim();
}

function prettyPlanName(planName, planKey) {
  const n = String(planName || "").trim();
  if (n) return n;
  const k = String(planKey || "").trim();
  return k || "free";
}

export default function UserBadge({ onStartCheckout }) {
  const {
    user,
    isAnonymous,
    loginWithGoogle,
    logout,

    // tokens
    mediaTokens,
    pendingMediaTokens,
    tokensHydrated,

    // billing
    planKey,
    planName,
  } = useAuth();

  const avatarUrl = user?.prefs?.avatarUrl || "";
  const initials = getInitials(user);

  const displayName = isAnonymous ? "Guest" : user?.name?.trim() || "User";
  const providerBadge = isAnonymous ? "free" : "google";

  const pending = Math.max(0, Number(pendingMediaTokens || 0) || 0);
  const available = Math.max(0, Number(mediaTokens || 0) || 0);
  const total = available + pending;

  const planKeyNorm = normKey(planKey);
  const planLabel = prettyPlanName(planName, planKey);

  const isFreePlan = !planKeyNorm || planKeyNorm === "free" || planKeyNorm === "hobby";
  const hasPaidPlan = !isAnonymous && !isFreePlan;

  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [burst, setBurst] = useState(false);
  const [busyPlanKey, setBusyPlanKey] = useState("");

  const burstTimerRef = useRef(null);

  // ✅ shimmer is driven ONLY by tokensHydrated
  const showTokenSkeleton = !isAnonymous && !tokensHydrated;

  const tokenTitle = useMemo(() => {
    if (showTokenSkeleton) return "Loading token balance…";
    return pending > 0
      ? `Media tokens: ${total} (${available} unused, ${pending} in use)`
      : `Media tokens: ${total} (${available} unused)`;
  }, [showTokenSkeleton, pending, total, available]);


    useEffect(() => {
  return onUpgradeRequested((detail) => {
    // optional: handle guest differently
    if (isAnonymous) {
      toast.error("Sign in to upgrade.");
      return;
    }

    // optional: little burst animation
    setBurst(true);
    if (burstTimerRef.current) clearTimeout(burstTimerRef.current);
    burstTimerRef.current = setTimeout(() => setBurst(false), 650);

    setUpgradeOpen(true);
  });
}, [isAnonymous]);


  const onPlanClick = () => {
    setBurst(true);
    if (burstTimerRef.current) clearTimeout(burstTimerRef.current);
    burstTimerRef.current = setTimeout(() => setBurst(false), 650);
    setUpgradeOpen(true);
  };

  const handleMouseMove = (e) => {
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 100;
    const y = ((e.clientY - r.top) / r.height) * 100;
    el.style.setProperty("--mx", `${x}%`);
    el.style.setProperty("--my", `${y}%`);
  };

  const handleSelectPlan = async (pk) => {
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
  };

  return (
    <Wrap>
      <AvatarWrap>
        {avatarUrl ? (
          <AvatarImg src={avatarUrl} alt={displayName} />
        ) : (
          <AvatarFallback aria-hidden="true">{initials}</AvatarFallback>
        )}
      </AvatarWrap>

      <Meta>
        <TopRow>
          <Name title={displayName}>{displayName}</Name>
        </TopRow>

        <TokenRow title={tokenTitle}>
          Media Tokens:{" "}
          {showTokenSkeleton ? <SkeletonNum aria-label="Loading media tokens" /> : <b>{total}</b>}

          <Breakdown>
            {showTokenSkeleton ? (
              <>
                <SkeletonText style={{ width: 82 }} />
                <SkeletonText style={{ width: 72 }} />
              </>
            ) : (
              <>
                <span>{available} unused</span>
                {pending > 0 ? <Pending>+{pending} in use</Pending> : null}
              </>
            )}
          </Breakdown>
        </TokenRow>

                  <Pills>
            <Pill>{providerBadge}</Pill>
            {!isAnonymous ? (
              <PlanPill $paid={hasPaidPlan} title={`Plan: ${planLabel}`}>
                {planLabel}
              </PlanPill>
            ) : null}
          </Pills>

        <Actions>
          {isAnonymous ? (
            <PrimaryButton type="button" onClick={loginWithGoogle}>
              Continue with Google
            </PrimaryButton>
          ) : (
            <PlanButton
              type="button"
              onClick={onPlanClick}
              onMouseMove={handleMouseMove}
              $burst={burst}
              aria-label={hasPaidPlan ? "Manage plan" : "Upgrade"}
              title={hasPaidPlan ? "Manage your plan" : "Upgrade your plan"}
            >
              <Sparkle aria-hidden="true" data-pulse="1">
                ✦
              </Sparkle>
              {hasPaidPlan ? "Manage plan" : "Upgrade"}
              <Chevron aria-hidden="true">›</Chevron>
            </PlanButton>
          )}
        </Actions>
      </Meta>

      <UpgradePlansModal
        open={!!upgradeOpen}
        onClose={() => setUpgradeOpen(false)}
        onSelectPlan={handleSelectPlan}
        busyPlanKey={busyPlanKey}
        onLogout={logout}
      />
    </Wrap>
  );
}

const Wrap = styled.div`
  width: 100%;
  box-sizing: border-box;

  display: flex;
  align-items: flex-start;
  justify-content: flex-start;
  gap: 10px;

  padding: 10px;
  border-radius: 14px;
  background: rgba(0, 0, 0, 0.03);
  border: 1px solid var(--border);

  min-width: 0;
`;

const AvatarWrap = styled.div`
  width: 34px;
  height: 34px;
  border-radius: 999px;
  overflow: hidden;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  background: rgba(0, 0, 0, 0.08);
`;

const AvatarImg = styled.img`
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
`;

const AvatarFallback = styled.div`
  font-size: 12px;
  font-weight: 900;
  color: var(--text);
`;

const Meta = styled.div`
  flex: 1 1 auto;
  min-width: 0;

  display: flex;
  flex-direction: column;
  gap: 6px;
`;

const TopRow = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
`;

const Name = styled.div`
  font-size: 13px;
  font-weight: 800;
  color: var(--text);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const Pills = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
`;

const Pill = styled.span`
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid rgba(239, 68, 68, 0.25);
  background: rgba(239, 68, 68, 0.08);
  color: var(--accent);
  font-weight: 800;
`;

const PlanPill = styled.span`
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  font-weight: 900;

  border: 1px solid ${(p) => (p.$paid ? "rgba(34,197,94,0.25)" : "rgba(0,0,0,0.12)")};
  background: ${(p) => (p.$paid ? "rgba(34,197,94,0.08)" : "rgba(0,0,0,0.04)")};
  color: var(--text);
`;

const TokenRow = styled.div`
  font-size: 12px;
  color: var(--muted);
  line-height: 1.25;

  b {
    color: var(--text);
    font-weight: 950;
  }
`;

const Breakdown = styled.div`
  margin-top: 2px;
  display: flex;
  gap: 10px;
  font-size: 11px;
  font-weight: 800;
  color: var(--muted);
  align-items: center;
`;

const Pending = styled.span`
  font-weight: 950;
  color: rgba(59, 130, 246, 1);
`;

const Actions = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 4px;
`;

const PrimaryButton = styled.button`
  width: 100%;
  border: 1px solid rgba(239, 68, 68, 0.25);
  background: rgba(239, 68, 68, 0.08);
  color: var(--accent);
  font-weight: 800;
  border-radius: 12px;
  padding: 10px 12px;
  cursor: pointer;

  &:hover {
    background: rgba(239, 68, 68, 0.12);
  }
`;

// ---- skeleton shimmer ----
const shimmer = keyframes`
  0% { background-position: 0% 0%; }
  100% { background-position: 200% 0%; }
`;

const SkeletonBase = styled.span`
  display: inline-block;
  border-radius: 999px;
  background: linear-gradient(
    90deg,
    rgba(0, 0, 0, 0.06),
    rgba(0, 0, 0, 0.12),
    rgba(0, 0, 0, 0.06)
  );
  background-size: 200% 100%;
  animation: ${shimmer} 1.05s ease-in-out infinite;
`;

const SkeletonNum = styled(SkeletonBase)`
  height: 14px;
  width: 64px;
  vertical-align: middle;
`;

const SkeletonText = styled(SkeletonBase)`
  height: 10px;
  width: 72px;
`;

// ---- Plan button ----
const pulse = keyframes`
  0% { transform: scale(1); opacity: 0.55; }
  50% { transform: scale(1.02); opacity: 0.75; }
  100% { transform: scale(1); opacity: 0.55; }
`;

const burst = keyframes`
  from { transform: scale(0.65); opacity: 0.0; }
  25% { opacity: 0.55; }
  to { transform: scale(1.55); opacity: 0.0; }
`;

const PlanButton = styled.button`
  --mx: 50%;
  --my: 50%;

  position: relative;
  width: 100%;
  border-radius: 14px;
  padding: 10px 12px;
  cursor: pointer;

  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;

  color: var(--text);
  font-weight: 950;
  letter-spacing: 0.1px;

  background: linear-gradient(180deg, rgba(239, 68, 68, 0.1), rgba(239, 68, 68, 0.06));
  border: 1px solid rgba(239, 68, 68, 0.22);

  box-shadow: 0 10px 24px rgba(239, 68, 68, 0.1), 0 6px 14px rgba(0, 0, 0, 0.1);

  transform: translateZ(0);
  transition: transform 140ms ease, box-shadow 140ms ease, border-color 140ms ease, background 140ms ease;

  &:before {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: 14px;
    pointer-events: none;
    opacity: 0.9;
    background: radial-gradient(
      240px 140px at var(--mx) var(--my),
      rgba(255, 255, 255, 0.22),
      transparent 55%
    );
    mix-blend-mode: overlay;
  }

  &:after {
    content: "";
    position: absolute;
    inset: -2px;
    border-radius: 16px;
    pointer-events: none;
    opacity: ${(p) => (p.$burst ? 1 : 0)};
    background: radial-gradient(closest-side, rgba(239, 68, 68, 0.3), transparent 68%);
    animation: ${(p) => (p.$burst ? burst : "none")} 520ms ease-out both;
  }

  &:hover {
    transform: translateY(-1px);
    border-color: rgba(239, 68, 68, 0.32);
    background: linear-gradient(180deg, rgba(239, 68, 68, 0.13), rgba(239, 68, 68, 0.07));
    box-shadow: 0 14px 34px rgba(239, 68, 68, 0.14), 0 10px 18px rgba(0, 0, 0, 0.12);
  }

  &:active {
    transform: translateY(0px) scale(0.995);
  }

  &:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.18), 0 14px 34px rgba(239, 68, 68, 0.14),
      0 10px 18px rgba(0, 0, 0, 0.12);
  }

  @media (prefers-reduced-motion: no-preference) {
    & > span[data-pulse="1"] {
      animation: ${pulse} 3.2s ease-in-out infinite;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    &:after {
      animation: none;
    }
    &:hover,
    &:active {
      transform: none;
    }
    & > span[data-pulse="1"] {
      animation: none;
    }
  }
`;

const Sparkle = styled.span`
  font-size: 12px;
  opacity: 0.9;
  color: var(--accent);
  filter: drop-shadow(0 4px 10px rgba(239, 68, 68, 0.2));
`;

const Chevron = styled.span`
  font-size: 16px;
  margin-left: 2px;
  opacity: 0.85;
  color: var(--text);
`;
