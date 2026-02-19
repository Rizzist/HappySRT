// components/TutorialThread.js
import styled from "styled-components";

const GITHUB_REPO_LINK = "https://github.com/Rizzist/happysrt"

export default function TutorialThread() {
  return (
    <Thread>
      <Card>
        <TitleRow>
          <H2>Welcome to HappySRT</H2>
          <Pill>Open source</Pill>
        </TitleRow>

        <P>
          HappySRT is an AI workspace for <b>transcription</b>, <b>translation</b>, and <b>summarization</b>—built for
          creators who want speed, control, and clean exports.
        </P>

        <Hint>
          This <b>Default</b> thread is a permanent guide. Your real work happens in your own threads in the sidebar.
        </Hint>

        <LinkRow>
          <GitHubLink
            href={GITHUB_REPO_LINK}
            target="_blank"
            rel="noreferrer"
            title="View the source on GitHub"
          >
            View on GitHub →
          </GitHubLink>
          <Muted>
            If you like the project, leaving a ⭐ helps a lot.
          </Muted>
        </LinkRow>
      </Card>

      <Card>
        <H3>How the app works (quick tour)</H3>
        <List>
          <li>
            <b>Threads</b> are separate workspaces. Create one with <b>+ New thread</b> to keep projects organized.
          </li>
          <li>
            In a thread, <b>upload an audio/video file</b> or <b>paste a media URL</b>, then run one or more actions.
          </li>
          <li>
            Each run creates results you can <b>copy</b>, <b>download</b> (SRT/text), and come back to later.
          </li>
        </List>

        <Note>
          Tip: The “Default (How it works)” thread is informational. Use your own threads for actual uploads + outputs.
        </Note>
      </Card>

      <Card>
        <H3>Core features</H3>
        <List>
          <li>
            <b>Transcription</b> → turns speech into text with timestamps (SRT-ready).
          </li>
          <li>
            <b>Translation</b> → generates subtitle tracks in your target language.
          </li>
          <li>
            <b>Summarization</b> → produces highlights, bullets, and quick notes from the content.
          </li>
        </List>

        <Hint>
          You can run a single action (e.g. just Transcription) or combine them (e.g. Transcribe → Translate → Summarize).
        </Hint>
      </Card>

      <Card>
        <H3>Uploads, exports, and results</H3>
        <List>
          <li>
            <b>Upload</b> a file (audio/video). Larger files use more processing.
          </li>
          <li>
            Results appear inside the thread: you’ll see tabs like <b>Transcription</b>, <b>Translation</b>, and{" "}
            <b>Summary</b>.
          </li>
          <li>
            Export your work with buttons like <b>Download SRT</b> / <b>Copy</b> / <b>Save</b>.
          </li>
        </List>

        <Hint>
          Keep one thread per project (podcast episode, client, course module, etc.) so everything stays searchable.
        </Hint>
      </Card>

      <Card>
        <H3>Media tokens & billing</H3>
        <P>
          HappySRT uses <b>media tokens</b> to track processing usage. Think of tokens as your “processing credits” for
          transcription / translation / summarization.
        </P>

        <List>
          <li>
            Your token balance is shown in the sidebar under your profile.
          </li>
          <li>
            When a job runs, tokens can show as <b>in use</b> while it’s processing.
          </li>
          <li>
            If you’re low on tokens, you can <b>Upgrade</b> to get more monthly tokens and higher limits.
          </li>
        </List>

        <Note>
          You can start as a guest to explore, then sign in to keep your history and manage plans.
        </Note>
      </Card>

      <Card>
        <H3>Guest vs. signed-in</H3>
        <List>
          <li>
            <b>Guest mode</b> is great for trying the app quickly.
          </li>
          <li>
            <b>Sign in with Google</b> to keep your threads synced and persist your work across devices.
          </li>
          <li>
            Once signed in, you can manage your plan and token limits from the sidebar.
          </li>
        </List>

        <Hint>
          Privacy note: this app is built to be creator-friendly. You control what you upload and what you export.
        </Hint>
      </Card>

      <Card>
        <H3>Open source</H3>
        <P>
          HappySRT is fully open source—feel free to fork it, self-host it, and contribute improvements.
        </P>

        <List>
          <li>Found a bug? Open an issue.</li>
          <li>Want a feature? Suggest it (or ship a PR).</li>
          <li>Using it in production? A ⭐ helps others discover it.</li>
        </List>

        <LinkRow>
          <GitHubLink href={GITHUB_REPO_LINK} target="_blank" rel="noreferrer">
            Open the repo →
          </GitHubLink>
          <Muted>Thanks for supporting open source.</Muted>
        </LinkRow>
      </Card>
    </Thread>
  );
}

const Thread = styled.div`
  max-width: 920px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
`;

const Card = styled.div`
  border-radius: 16px;
  padding: 18px;
  background: var(--panel);
  border: 1px solid var(--border);
  box-shadow: var(--shadow);
`;

const TitleRow = styled.div`
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
`;

const Pill = styled.div`
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 900;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid rgba(239, 68, 68, 0.22);
  background: rgba(239, 68, 68, 0.08);
  color: var(--accent);
`;

const H2 = styled.h2`
  margin: 0 0 10px;
  font-size: 18px;
  letter-spacing: -0.2px;
`;

const H3 = styled.h3`
  margin: 0 0 10px;
  font-size: 15px;
  letter-spacing: -0.1px;
`;

const P = styled.p`
  margin: 0 0 10px;
  color: var(--text);
  line-height: 1.55;
`;

const Hint = styled.div`
  font-size: 12px;
  color: var(--muted);
  line-height: 1.4;
`;

const List = styled.ul`
  margin: 0;
  padding-left: 18px;
  color: var(--text);

  li {
    margin: 8px 0;
    line-height: 1.5;
  }
`;

const Note = styled.div`
  margin-top: 12px;
  font-size: 12px;
  color: var(--muted);
  padding-left: 10px;
  border-left: 3px solid var(--accent);
  line-height: 1.45;
`;

const LinkRow = styled.div`
  margin-top: 12px;
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
`;

const GitHubLink = styled.a`
  font-size: 12px;
  font-weight: 950;
  color: var(--text);
  text-decoration: none;

  border-radius: 12px;
  padding: 8px 10px;

  border: 1px solid rgba(0, 0, 0, 0.10);
  background: rgba(0, 0, 0, 0.02);

  &:hover {
    background: var(--hover);
  }
`;

const Muted = styled.span`
  font-size: 12px;
  color: var(--muted);
  font-weight: 800;
`;
