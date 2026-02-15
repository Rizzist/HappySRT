// components/UserBadge.js
import styled from "styled-components";

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

export default function UserBadge({
  user,
  isAnonymous,
  mediaTokens,
  pendingMediaTokens,
  onGoogleLogin,
  onLogout,
}) {
  const avatarUrl = user?.prefs?.avatarUrl || "";
  const initials = getInitials(user);

  const displayName = isAnonymous ? "Guest" : user?.name?.trim() || "User";
  const providerBadge = isAnonymous ? "free" : "google";

  const pending = Math.max(0, Number(pendingMediaTokens || 0) || 0);
  const available = Math.max(0, Number(mediaTokens || 0) || 0);

  // show total as main value (unused + in-use)
  const total = available + pending;

  return (
    <Wrap>
      <AvatarWrap>
        {avatarUrl ? <AvatarImg src={avatarUrl} alt={displayName} /> : <AvatarFallback aria-hidden="true">{initials}</AvatarFallback>}
      </AvatarWrap>

      <Meta>
        <TopRow>
          <Name title={displayName}>{displayName}</Name>
          <Pill>{providerBadge}</Pill>
        </TopRow>

        <TokenRow
          title={
            pending > 0
              ? `Media tokens: ${total} (${available} unused, ${pending} in use)`
              : `Media tokens: ${total} (${available} unused)`
          }
        >
          Media Tokens: <b>{total}</b>

          <Breakdown>
            <span>{available} unused</span>
            {pending > 0 ? <Pending>+{pending} in use</Pending> : null}
          </Breakdown>
        </TokenRow>

        <Actions>
          {isAnonymous ? (
            <PrimaryButton type="button" onClick={onGoogleLogin}>
              Continue with Google
            </PrimaryButton>
          ) : (
            <GhostButton type="button" onClick={onLogout}>
              Log out
            </GhostButton>
          )}
        </Actions>
      </Meta>
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

const Pill = styled.span`
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid rgba(239, 68, 68, 0.25);
  background: rgba(239, 68, 68, 0.08);
  color: var(--accent);
  font-weight: 800;
  flex: 0 0 auto;
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

const GhostButton = styled.button`
  width: 100%;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
  font-weight: 700;
  border-radius: 12px;
  padding: 10px 12px;
  cursor: pointer;

  &:hover {
    background: var(--hover);
  }
`;
