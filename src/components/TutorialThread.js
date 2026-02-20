// components/TutorialThread.js
import styled from "styled-components";

const SCREENSHOTS = [
  {
    src: "/icons/screenshots/boot.jpg",
    title: "Welcome screen",
    desc: "A clean workspace built for creators",
  },
  {
    src: "/icons/screenshots/tut.jpg",
    title: "Quick tour",
    desc: "Threads + upload + run actions",
  },
  {
    src: "/icons/screenshots/sample.jpg",
    title: "Results",
    desc: "Transcription • Translation • Summary tabs",
  },
  {
    src: "/icons/screenshots/pay.jpg",
    title: "Tokens",
    desc: "Track usage + upgrade when needed",
  },
];

export default function TutorialThread() {
  return (
    <Thread>
      <Card>
        <TitleRow>
          <H2>Welcome to HappySRT</H2>
          <Pill>Quick start</Pill>
        </TitleRow>

        <P>
          HappySRT is an AI workspace for <b>transcription</b>, <b>translation</b>, and <b>summarization</b>—built for
          creators who want speed, control, and clean exports.
        </P>

        <Hint>
          This <b>Default</b> thread is a permanent guide. Your real work happens in your own threads in the sidebar.
        </Hint>

        <MiniSteps>
          <MiniStep>
            <Dot>1</Dot>
            <span>
              Click <b>+ New thread</b>
            </span>
          </MiniStep>
          <MiniStep>
            <Dot>2</Dot>
            <span>
              <b>Upload</b> a file or paste a <b>media URL</b>
            </span>
          </MiniStep>
          <MiniStep>
            <Dot>3</Dot>
            <span>
              Run <b>Transcribe → Translate → Summarize</b>
            </span>
          </MiniStep>
          <MiniStep>
            <Dot>4</Dot>
            <span>
              <b>Download SRT</b> / <b>Copy</b> / <b>Save</b>
            </span>
          </MiniStep>
        </MiniSteps>
      </Card>

      <Card>
        <H3>See what it looks like 👀</H3>
        <P>
          Swipe through a quick preview. In practice, you’ll create a thread per project and your results stay organized
          and searchable.
        </P>

        <Gallery aria-label="HappySRT screenshots">
          {SCREENSHOTS.map((shot) => (
            <Shot key={shot.src}>
              <ShotImg src={shot.src} alt={`${shot.title} — ${shot.desc}`} loading="lazy" />
              <ShotMeta>
                <ShotTitle>{shot.title}</ShotTitle>
                <ShotDesc>{shot.desc}</ShotDesc>
              </ShotMeta>
            </Shot>
          ))}
        </Gallery>

        <Note>
          Tip: If you’re on desktop, you can also scroll the gallery horizontally with <b>Shift + mouse wheel</b>.
        </Note>
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
            🎙️ <b>Transcription</b> → turns speech into text with timestamps (SRT-ready).
          </li>
          <li>
            🌍 <b>Translation</b> → generates subtitle tracks in your target language.
          </li>
          <li>
            🧠 <b>Summarization</b> → produces highlights, bullets, and quick notes from the content.
          </li>
        </List>

        <Hint>
          You can run a single action (e.g. just Transcription) or chain them (e.g. Transcribe → Translate → Summarize).
        </Hint>
      </Card>

      <Card>
        <H3>Uploads, exports, and results</H3>
        <List>
          <li>
            📁 <b>Upload</b> a file (audio/video). Larger files use more processing.
          </li>
          <li>
            🧾 Results appear inside the thread: you’ll see tabs like <b>Transcription</b>, <b>Translation</b>, and{" "}
            <b>Summary</b>.
          </li>
          <li>
            📤 Export your work with buttons like <b>Download SRT</b> / <b>Copy</b> / <b>Save</b>.
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
          <li>Your token balance is shown in the sidebar under your profile.</li>
          <li>
            When a job runs, tokens can show as <b>in use</b> while it’s processing.
          </li>
          <li>
            If you’re low on tokens, you can <b>Upgrade</b> to get more monthly tokens and higher limits.
          </li>
        </List>

        <Note>You can start as a guest to explore, then sign in to keep your history and manage plans.</Note>
      </Card>

      <Card>
        <H3>Guest vs. signed-in</H3>
        <List>
          <li>
            👤 <b>Guest mode</b> is great for trying the app quickly.
          </li>
          <li>
            🔐 <b>Sign in with Google</b> to keep your threads synced and persist your work across devices.
          </li>
          <li>
            ⚙️ Once signed in, you can manage your plan and token limits from the sidebar.
          </li>
        </List>

        <Hint>
          Privacy note: this app is built to be creator-friendly. You control what you upload and what you export.
        </Hint>
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
  border: 1px solid rgba(59, 130, 246, 0.22);
  background: rgba(59, 130, 246, 0.10);
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

const MiniSteps = styled.div`
  margin-top: 12px;
  display: grid;
  gap: 8px;
`;

const MiniStep = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 14px;
  border: 1px solid rgba(0, 0, 0, 0.10);
  background: rgba(0, 0, 0, 0.02);
  color: var(--text);
`;

const Dot = styled.div`
  width: 22px;
  height: 22px;
  border-radius: 999px;
  display: grid;
  place-items: center;
  font-size: 12px;
  font-weight: 950;
  color: var(--text);
  border: 1px solid rgba(0, 0, 0, 0.14);
  background: rgba(0, 0, 0, 0.03);
`;

const Gallery = styled.div`
  margin-top: 12px;
  display: flex;
  gap: 12px;
  overflow-x: auto;
  padding-bottom: 6px;
  scroll-snap-type: x mandatory;
  -webkit-overflow-scrolling: touch;

  &::-webkit-scrollbar {
    height: 10px;
  }
`;

const Shot = styled.div`
  flex: 0 0 240px;
  scroll-snap-align: start;
  border-radius: 16px;
  border: 1px solid var(--border);
  background: rgba(0, 0, 0, 0.02);
  overflow: hidden;
`;

const ShotImg = styled.img`
  width: 100%;
  height: auto;
  display: block;
  aspect-ratio: 1080 / 2316;
  object-fit: cover;
`;

const ShotMeta = styled.div`
  padding: 10px 12px 12px;
`;

const ShotTitle = styled.div`
  font-size: 12px;
  font-weight: 950;
  color: var(--text);
`;

const ShotDesc = styled.div`
  margin-top: 2px;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.35;
`;
