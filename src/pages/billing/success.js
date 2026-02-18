// pages/billing/success.js
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/router";
import styled from "styled-components";

import { CheckCircle } from "@styled-icons/feather/CheckCircle";
import { ArrowLeft } from "@styled-icons/feather/ArrowLeft";

import { useAuth } from "../../contexts/AuthContext";

function shortId(s) {
  const t = String(s || "").trim();
  if (!t) return "";
  if (t.length <= 18) return t;
  return `${t.slice(0, 10)}…${t.slice(-6)}`;
}

export default function BillingSuccessPage() {
  const router = useRouter();
  const { syncBilling } = useAuth();

  const sessionId = useMemo(() => {
    const raw = router?.query?.session_id;
    return raw ? String(raw) : "";
  }, [router?.query?.session_id]);

  const didSyncRef = useRef(false);

  const [secondsLeft, setSecondsLeft] = useState(5);
  const redirectTimerRef = useRef(null);
  const tickTimerRef = useRef(null);

  useEffect(() => {
    if (!router.isReady) return;

    // ✅ One-shot billing sync (prefers checkout session -> subscription)
    if (!didSyncRef.current) {
      didSyncRef.current = true;
      if (sessionId) {
        Promise.resolve(syncBilling?.({ sessionId, force: true })).catch(() => {});
      } else {
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
  }, [router.isReady, router, sessionId, syncBilling]);

  return (
    <Wrap>
      <Card>
        <Top>
          <IconWrap>
            <Icon aria-hidden="true" />
          </IconWrap>
          <Title>Payment successful</Title>
          <Sub>
            Your plan is being applied. Redirecting back to the app in <b>{secondsLeft}s</b>.
          </Sub>

          {sessionId ? (
            <MetaRow>
              <MetaLabel>Session</MetaLabel>
              <MetaValue title={sessionId}>{shortId(sessionId)}</MetaValue>
            </MetaRow>
          ) : null}
        </Top>

        <Actions>
          <Primary type="button" onClick={() => router.replace("/")}>
            <Arrow aria-hidden="true" />
            Back to app now
          </Primary>
        </Actions>

        <Foot>
          <FootNote>
            (Testing mode) We sync from Stripe on page load. Webhooks will make this instant later.
          </FootNote>
        </Foot>
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
  border: 1px solid rgba(34, 197, 94, 0.22);
  background: rgba(34, 197, 94, 0.06);
  display: grid;
  place-items: center;
`;

const Icon = styled(CheckCircle)`
  width: 22px;
  height: 22px;
  color: rgba(34, 197, 94, 1);
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

const MetaRow = styled.div`
  margin-top: 12px;
  border: 1px solid var(--border);
  background: rgba(0, 0, 0, 0.02);
  border-radius: 14px;
  padding: 10px 12px;

  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
`;

const MetaLabel = styled.div`
  font-size: 11px;
  font-weight: 850;
  color: var(--muted);
`;

const MetaValue = styled.div`
  font-size: 12px;
  font-weight: 900;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

  border: 1px solid rgba(239, 68, 68, 0.24);
  background: rgba(239, 68, 68, 0.08);
  color: var(--text);
  font-weight: 950;

  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;

  &:hover {
    background: rgba(239, 68, 68, 0.11);
  }
`;

const Arrow = styled(ArrowLeft)`
  width: 16px;
  height: 16px;
  opacity: 0.85;
`;

const Foot = styled.div`
  padding: 12px 16px 16px 16px;
`;

const FootNote = styled.div`
  font-size: 11px;
  color: var(--muted);
  line-height: 1.35;
`;
