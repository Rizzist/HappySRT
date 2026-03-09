import { useState } from "react";
import { useRouter } from "next/router";
import styled from "styled-components";
import { toast } from "sonner";
import { useAuth } from "../contexts/AuthContext";

export default function ResetPasswordPage() {
  const router = useRouter();
  const { completePasswordRecovery, loginWithEmailPassword } = useAuth();

  const [password, setPassword] = useState("");
  const [passwordAgain, setPasswordAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [doneMessage, setDoneMessage] = useState("");

  const userId = typeof router.query.userId === "string" ? router.query.userId : "";
  const secret = typeof router.query.secret === "string" ? router.query.secret : "";
  const email = typeof router.query.email === "string" ? router.query.email : "";

  const hasValidLink = !!userId && !!secret;

  const onSubmit = async (e) => {
    e.preventDefault();

    if (!hasValidLink) {
      toast.error("Invalid or expired reset link.");
      return;
    }

    if (!password || password.length < 8) {
      toast.error("Password must be at least 8 characters.");
      return;
    }

    if (password !== passwordAgain) {
      toast.error("Passwords do not match.");
      return;
    }

    setBusy(true);

    try {
      await completePasswordRecovery({
        userId,
        secret,
        password,
      });

      if (email) {
        try {
          await loginWithEmailPassword(email, password);
          toast.success("Password updated. Signed in.");
          router.replace("/");
          return;
        } catch {}
      }

      setDone(true);
      setDoneMessage("Password updated. Sign in with your new password.");
      toast.success("Password updated.");
    } catch (err) {
      toast.error(err?.message || "Could not reset password.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page>
      <Card>
        <Title>Reset password</Title>

        {!router.isReady ? (
          <Muted>Loading…</Muted>
        ) : done ? (
          <>
            <SuccessBox>{doneMessage}</SuccessBox>

            <PrimaryButton type="button" onClick={() => router.push("/")}>
              Back to app
            </PrimaryButton>
          </>
        ) : !hasValidLink ? (
          <>
            <ErrorBox>This reset link is invalid or expired.</ErrorBox>

            <PrimaryButton type="button" onClick={() => router.push("/")}>
              Back to app
            </PrimaryButton>
          </>
        ) : (
          <Form onSubmit={onSubmit}>
            {email ? <Muted>Resetting password for {email}</Muted> : null}

            <Field>
              <Label>New password</Label>
              <Input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
              />
            </Field>

            <Field>
              <Label>Confirm new password</Label>
              <Input
                type="password"
                autoComplete="new-password"
                value={passwordAgain}
                onChange={(e) => setPasswordAgain(e.target.value)}
                placeholder="Repeat your new password"
              />
            </Field>

            <PrimaryButton type="submit" disabled={busy}>
              {busy ? "Updating…" : "Update password"}
            </PrimaryButton>
          </Form>
        )}
      </Card>
    </Page>
  );
}

const Page = styled.div`
  min-height: 100vh;
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: 20px;
  background: var(--bg);
`;

const Card = styled.div`
  width: min(460px, 100%);
  border-radius: 18px;
  border: 1px solid var(--border);
  background: var(--panel-2);
  padding: 18px;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.18);
  display: grid;
  gap: 14px;
`;

const Title = styled.h1`
  margin: 0;
  font-size: 22px;
  color: var(--text);
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

const Muted = styled.div`
  font-size: 13px;
  color: var(--muted);
`;

const SuccessBox = styled.div`
  border-radius: 12px;
  border: 1px solid rgba(34, 197, 94, 0.22);
  background: rgba(34, 197, 94, 0.08);
  color: var(--text);
  padding: 12px;
  font-weight: 700;
`;

const ErrorBox = styled.div`
  border-radius: 12px;
  border: 1px solid rgba(239, 68, 68, 0.22);
  background: rgba(239, 68, 68, 0.08);
  color: var(--text);
  padding: 12px;
  font-weight: 700;
`;