import { useEffect, useRef, useState } from "react";
import styled from "styled-components";
import { toast } from "sonner";
import { useAuth } from "../contexts/AuthContext";

export default function AuthDialog({ open, onClose }) {
  const { loginWithEmailPassword, loginWithGoogle, sendPasswordRecovery } = useAuth();

  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const backdropPressStartedRef = useRef(false);

  useEffect(() => {
    if (!open) {
      setMode("login");
      setEmail("");
      setPassword("");
      setBusy(false);
      setSent(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (e) => {
      if (e.key === "Escape") onClose?.();
    };

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);

    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  const handleLogin = async (e) => {
    e.preventDefault();

    const cleanEmail = String(email || "").trim();
    const cleanPassword = String(password || "");

    if (!cleanEmail) {
      toast.error("Enter your email.");
      return;
    }

    if (!cleanPassword) {
      toast.error("Enter your password.");
      return;
    }

    setBusy(true);
    try {
      await loginWithEmailPassword(cleanEmail, cleanPassword);
      toast.success("Signed in.");
      onClose?.();
    } catch (err) {
      toast.error(err?.message || "Could not sign in.");
    } finally {
      setBusy(false);
    }
  };

  const handleRecovery = async (e) => {
    e.preventDefault();

    const cleanEmail = String(email || "").trim();
    if (!cleanEmail) {
      toast.error("Enter your email.");
      return;
    }

    setBusy(true);
    try {
      await sendPasswordRecovery(cleanEmail);
      setSent(true);
      toast.success("Password reset email sent.");
    } catch (err) {
      toast.error(err?.message || "Could not send reset email.");
    } finally {
      setBusy(false);
    }
  };

  return (
<Overlay
  onMouseDown={(e) => {
    backdropPressStartedRef.current = e.target === e.currentTarget;
  }}
  onMouseUp={(e) => {
    const endedOnBackdrop = e.target === e.currentTarget;

    if (backdropPressStartedRef.current && endedOnBackdrop) {
      onClose?.();
    }

    backdropPressStartedRef.current = false;
  }}
>
      <Card role="dialog" aria-modal="true" aria-labelledby="auth-dialog-title">
        <Top>
          <Title id="auth-dialog-title">
            {mode === "login" ? "Sign in" : "Reset password"}
          </Title>

          <CloseButton type="button" onClick={onClose} aria-label="Close">
            ✕
          </CloseButton>
        </Top>

        {mode === "login" ? (
          <Form onSubmit={handleLogin}>
            <Field>
              <Label>Email</Label>
              <Input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </Field>

            <Field>
              <Label>Password</Label>
              <Input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Your password"
              />
            </Field>

            <PrimaryButton type="submit" disabled={busy}>
              {busy ? "Signing in…" : "Sign in with email"}
            </PrimaryButton>

            <Row>
              <TextButton
                type="button"
                onClick={() => {
                  setMode("forgot");
                  setSent(false);
                }}
              >
                Forgot password?
              </TextButton>

              <TextButton
                type="button"
                onClick={() => {
                  onClose?.();
                  loginWithGoogle();
                }}
              >
                Use Google instead
              </TextButton>
            </Row>
          </Form>
        ) : (
          <Form onSubmit={handleRecovery}>
            <Field>
              <Label>Email</Label>
              <Input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </Field>

            {sent ? (
              <InfoBox>
                Check your email for the password reset link.
              </InfoBox>
            ) : (
              <InfoText>
                We’ll send you a reset link for your account.
              </InfoText>
            )}

            <PrimaryButton type="submit" disabled={busy}>
              {busy ? "Sending…" : "Send reset link"}
            </PrimaryButton>

            <Row>
              <TextButton
                type="button"
                onClick={() => {
                  setMode("login");
                  setSent(false);
                }}
              >
                Back to sign in
              </TextButton>
            </Row>
          </Form>
        )}
      </Card>
    </Overlay>
  );
}

const Overlay = styled.div`
  position: fixed;
  inset: 0;
  z-index: 120;
  background: rgba(0, 0, 0, 0.42);
  display: grid;
  place-items: center;
  padding: 16px;
`;

const Card = styled.div`
  width: min(440px, 100%);
  border-radius: 18px;
  border: 1px solid var(--border);
  background: var(--panel-2);
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.28);
  padding: 16px;
  display: grid;
  gap: 14px;
`;

const Top = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
`;

const Title = styled.h2`
  margin: 0;
  font-size: 18px;
  line-height: 1.2;
  color: var(--text);
`;

const CloseButton = styled.button`
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

const Form = styled.form`
  display: grid;
  gap: 12px;
`;

const Field = styled.label`
  display: grid;
  gap: 6px;
`;

const Label = styled.span`
  font-size: 12px;
  font-weight: 800;
  color: var(--muted);
`;

const Input = styled.input`
  width: 100%;
  box-sizing: border-box;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
  padding: 12px 13px;
  outline: none;

  &:focus {
    border-color: rgba(239, 68, 68, 0.35);
    box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.12);
  }
`;

const PrimaryButton = styled.button`
  width: 100%;
  border-radius: 12px;
  border: 1px solid rgba(239, 68, 68, 0.25);
  background: rgba(239, 68, 68, 0.08);
  color: var(--accent);
  font-weight: 900;
  padding: 11px 12px;
  cursor: pointer;

  &:hover {
    background: rgba(239, 68, 68, 0.12);
  }

  &:disabled {
    opacity: 0.65;
    cursor: not-allowed;
  }
`;

const Row = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
`;

const TextButton = styled.button`
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--muted);
  font-weight: 800;
  cursor: pointer;

  &:hover {
    color: var(--text);
  }
`;

const InfoText = styled.div`
  font-size: 12px;
  color: var(--muted);
`;

const InfoBox = styled.div`
  border-radius: 12px;
  border: 1px solid rgba(34, 197, 94, 0.22);
  background: rgba(34, 197, 94, 0.08);
  color: var(--text);
  padding: 11px 12px;
  font-size: 13px;
  font-weight: 700;
`;