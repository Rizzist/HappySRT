// pages/_offline.js
import Head from "next/head";
import styled from "styled-components";
import { WifiOff } from "@styled-icons/feather/WifiOff";

export default function Offline() {
  const tryAgain = () => {
    if (typeof window === "undefined") return;
    window.location.reload();
  };

  const goHome = () => {
    if (typeof window === "undefined") return;
    window.location.href = "/";
  };

  return (
    <Wrap>
      <Head>
        <title>Offline • HappySRT</title>
        <meta name="robots" content="noindex" />
      </Head>

      <Card>
        <Top>
          <IconWrap>
            <Icon aria-hidden="true" />
          </IconWrap>

          <Title>You’re offline</Title>
          <Sub>
            HappySRT can’t reach the network right now. Check your connection, then try again.
          </Sub>

          <MetaRow>
            <MetaLabel>Status</MetaLabel>
            <MetaValue>{typeof navigator !== "undefined" && navigator.onLine ? "Online (maybe captive portal)" : "Offline"}</MetaValue>
          </MetaRow>
        </Top>

        <Actions>
          <Primary type="button" onClick={tryAgain}>
            Try again
          </Primary>

          <Secondary type="button" onClick={goHome}>
            Back to app
          </Secondary>
        </Actions>

        <Foot>
          <FootNote>
            Tip: If you’re on public Wi-Fi, you may need to open the login/captive portal first.
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
  border: 1px solid rgba(245, 158, 11, 0.22);
  background: rgba(245, 158, 11, 0.06);
  display: grid;
  place-items: center;
`;

const Icon = styled(WifiOff)`
  width: 22px;
  height: 22px;
  color: rgba(245, 158, 11, 1);
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
  gap: 10px;
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

  &:hover {
    background: rgba(239, 68, 68, 0.11);
  }
`;

const Secondary = styled.button`
  width: 100%;
  border-radius: 14px;
  padding: 11px 12px;
  cursor: pointer;

  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
  font-weight: 950;

  &:hover {
    background: var(--hover);
  }
`;

const Foot = styled.div`
  padding: 12px 16px 16px 16px;
`;

const FootNote = styled.div`
  font-size: 11px;
  color: var(--muted);
  line-height: 1.35;
`;
