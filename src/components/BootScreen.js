import { useEffect, useMemo, useState } from "react";
import styled, { keyframes } from "styled-components";

export default function BootScreen({ show, steps, error }) {
  const [mounted, setMounted] = useState(true);
  const [visible, setVisible] = useState(show);

  const allDone = useMemo(() => {
    if (!Array.isArray(steps) || steps.length === 0) return false;
    return steps.every((s) => {
      const state = s?.state || (s?.done ? "done" : "doing");
      return state === "done";
    });
  }, [steps]);

  useEffect(() => {
    let delayTimer = null;
    let unmountTimer = null;

    if (show) {
      setMounted(true);
      requestAnimationFrame(() => setVisible(true));
      return () => {};
    }

    // If show=false but steps aren't all done (shouldn't happen), keep it visible.
    if (!allDone && !error) {
      setMounted(true);
      setVisible(true);
      return () => {};
    }

    // ✅ show=false AND all steps done -> wait 0.3s, then fade out, then unmount
    delayTimer = setTimeout(() => {
      setVisible(false);
      unmountTimer = setTimeout(() => setMounted(false), 320); // matches your transition timing
    }, 300);

    return () => {
      if (delayTimer) clearTimeout(delayTimer);
      if (unmountTimer) clearTimeout(unmountTimer);
    };
  }, [show, allDone, error]);

  if (!mounted) return null;

  return (
    <Overlay $visible={visible}>
      <Card>
        <Logo src="/logo.png" alt="happysrt" />
        <Title>HappySRT</Title>
        <Sub>{error ? "Startup problem" : "Loading your workspace…"}</Sub>

        {Array.isArray(steps) && steps.length > 0 && (
          <Steps>
            {steps.map((s, idx) => {
              const state = s?.state || (s?.done ? "done" : "doing");
              const isDone = state === "done";
              const isPending = state === "pending";

              return (
                <StepRow key={idx}>
                  <Dot $done={isDone} $pending={isPending} $error={!!error && !isDone}>
                    {isDone ? "✓" : isPending ? "…" : "•"}
                  </Dot>
                  <StepText>{s.label}</StepText>
                </StepRow>
              );
            })}
          </Steps>
        )}
        {error ? <ErrorText>{String(error)}</ErrorText> : <Spinner />}
      </Card>
    </Overlay>
  );
}

const Overlay = styled.div`
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: grid;
  place-items: center;
  background: rgba(255, 255, 255, 0.92);
  backdrop-filter: blur(8px);
  opacity: ${(p) => (p.$visible ? 1 : 0)};
  pointer-events: ${(p) => (p.$visible ? "auto" : "none")};
  transition: opacity 280ms ease;
`;

const Card = styled.div`
  width: 360px;
  border-radius: 18px;
  background: var(--panel);
  border: 1px solid var(--border);
  box-shadow: var(--shadow);
  padding: 18px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;

  @media(max-width: 500px){
    width: 320px;
  }
`;

const Logo = styled.img`
  width: 44px;
  height: 44px;
  object-fit: contain;
  border-radius: 12px;
`;

const Title = styled.div`
  font-weight: 900;
  letter-spacing: 0.2px;
  color: var(--text);
`;

const Sub = styled.div`
  font-size: 12px;
  color: var(--muted);
`;

const Steps = styled.div`
  width: 100%;
  margin-top: 4px;
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

const StepRow = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
`;

const Dot = styled.div`
  width: 18px;
  height: 18px;
  border-radius: 999px;
  display: grid;
  place-items: center;
  font-size: 12px;
  font-weight: 900;

  color: ${(p) =>
    p.$error ? "#b91c1c" : p.$done ? "var(--accent)" : "rgba(0,0,0,0.55)"};

  border: 1px solid
    ${(p) =>
      p.$error
        ? "rgba(239,68,68,0.35)"
        : p.$done
        ? "rgba(239,68,68,0.25)"
        : "var(--border)"};

  background: ${(p) =>
    p.$error
      ? "rgba(239,68,68,0.10)"
      : p.$done
      ? "rgba(239,68,68,0.08)"
      : p.$pending
      ? "rgba(0,0,0,0.02)"
      : "rgba(0,0,0,0.03)"};
`;

const StepText = styled.div`
  font-size: 12px;
  color: var(--text);
  font-weight: 700;
`;

const ErrorText = styled.div`
  width: 100%;
  font-size: 12px;
  color: #b91c1c;
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.22);
  border-radius: 12px;
  padding: 10px 12px;
`;

const spin = keyframes`
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
`;

const Spinner = styled.div`
  width: 22px;
  height: 22px;
  border-radius: 999px;
  border: 2px solid rgba(0,0,0,0.12);
  border-top-color: var(--accent);
  animation: ${spin} 0.8s linear infinite;
`;
