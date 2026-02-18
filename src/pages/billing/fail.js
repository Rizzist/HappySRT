// pages/billing/fail.js
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/router";
import styled from "styled-components";

import { XCircle } from "@styled-icons/feather/XCircle";
import { ArrowLeft } from "@styled-icons/feather/ArrowLeft";

import { useAuth } from "../../contexts/AuthContext";

function normReason(r) {
  const t = String(r || "").toLowerCase().trim();
  if (!t) return "";
  if (t.includes("cancel")) return "cancel";
  if (t.includes("fail")) return "fail";
  return t;
}

export default function BillingFailPage() {
  const router = useRouter();
  const { syncBilling, isAnonymous } = useAuth();

  const reason = useMemo(() => normReason(router?.query?.reason), [router?.query?.reason]);

  const title = reason === "cancel" ? "Checkout canceled" : "Checkout didn’t complete";
  const sub =
    reason === "cancel"
      ? "No worries — you weren’t charged. You can try again anytime."
      : "We couldn’t confirm the payment. You can try again or choose another plan.";

  const didSyncRef = useRef(false);

  const [secondsLeft, setSecondsLeft] = useState(5);
  const redirectTimerRef = useRef(null);
  const tickTimerRef = useRef(null);

  useEffect(() => {
    if (!router.isReady) return;

    // ✅ One-shot billing sync (sometimes Stripe finishes even if user returns weirdly)
    if (!didSyncRef.current) {
      didSyncRef.current = true;
      if (!isAnonymous) {
        Promise.resolve(syncBilling?.({ force: true })).catch(() => {});
      }
    }

    setSecondsLeft(5);

    if (tickTimerRef.current) clearInterval(tickTimerRef.current);
    tickTimerRef.current = setInterval(() => {
      setSecondsLeft((s) => (s > 0 ? s - 1 : 0));
    }, 1000);

    if (redirectTimerRef.current) clearTimeout(redirectTimerRef.current);
    redirectTimerRef.current = setTimeout(() => {
      router.replace("/");
    }, 5000);

    return () => {
      if (tickTimerRef.current) clearInterval(tickTimerRef.current);
      if (redirectTimerRef.current) clearTimeout(redirectTimerRef.current);
      tickTimerRef.current = null;
      redirectTimerRef.current = null;
    };
  }, [router.isReady, router, syncBilling, isAnonymous]);

  return (
    <Wrap>
      <Card>
        <Top>
          <IconWrap>
            <Icon aria-hidden="true" />
          </IconWrap>

          <Title>{title}</Title>
          <Sub>
            {sub} Redirecting back to the app in <b>{secondsLeft}s</b>.
          </Sub>
        </Top>

        <Actions>
          <Primary type="button" onClick={() => router.replace("/")}>
            <Arrow aria-hidden="true" />
            Back to app now
          </Primary>
        </Actions>
      </Card>
    </Wrap>
  );
}

const Wrap = styled.div`
  min-height: 100vh;
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: 18px;
  background: var(--bg);
`;

const Card = styled.div`
  width: min(560px, 100%);
  border-radius: 18px;
  border: 1px solid var(--border);
  background: var(--panel);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.16);
  overflow: hidden;
`;

const Top = styled.div`
  padding: 16px 16px 12px 16px;
`;

const IconWrap = styled.div`
  width: 44px;
  height: 44px;
  border-radius: 14px;
  border: 1px solid rgba(239, 68, 68, 0.22);
  background: rgba(239, 68, 68, 0.06);
  display: grid;
  place-items: center;
`;

const Icon = styled(XCircle)`
  width: 22px;
  height: 22px;
  color: rgba(239, 68, 68, 1);
`;

const Title = styled.div`
  margin-top: 10px;
  font-size: 18px;
  font-weight: 950;
  color: var(--text);
`;

const Sub = styled.div`
  margin-top: 6px;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.45;

  b {
    color: var(--text);
    font-weight: 950;
  }
`;

const Actions = styled.div`
  padding: 12px 16px 16px 16px;
  border-top: 1px solid var(--border);
  display: grid;
`;

const Primary = styled.button`
  width: 100%;
  border-radius: 14px;
  padding: 11px 12px;
  cursor: pointer;

  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
  font-weight: 950;

  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;

  &:hover {
    background: var(--hover);
  }
`;

const Arrow = styled(ArrowLeft)`
  width: 16px;
  height: 16px;
  opacity: 0.85;
`;
