import styled from "styled-components";
import TutorialThread from "./TutorialThread";
import ThreadComposer from "./ThreadComposer";
import { useThreads } from "../contexts/threadsContext";
import ChatTimeline from "./ChatTimeline";

function safeArr(x) {
  return Array.isArray(x) ? x : [];
}

export default function ThreadView({
  thread,
  loading,

  showMobileHeaderActions,
  onOpenSidebar,
  onCreateThread,
  creatingThread,
}) {
  const { renameThread, deleteThread } = useThreads();

  if (loading || !thread) {
    return (
      <Wrap>
        <Header>
          <Left>
            <Title>Loading…</Title>
            <Sub>Preparing your threads</Sub>
          </Left>

          <Actions>
            {showMobileHeaderActions && (
              <>
                <IconButton type="button" onClick={onOpenSidebar} aria-label="Open sidebar" title="Open sidebar">
                  ☰
                </IconButton>
<NewThreadHeaderButton
  type="button"
  onClick={onCreateThread}
  disabled={!!creatingThread}
  title={creatingThread ? "Creating…" : "Create a new thread"}
>
  {creatingThread ? "Creating…" : "+ New thread"}
</NewThreadHeaderButton>

              </>
            )}
          </Actions>
        </Header>
        <Body />
      </Wrap>
    );
  }

  const isDefault = thread.id === "default";
  const chatItems = safeArr(thread?.chatItems);
  const hasChatItems = chatItems.length > 0;

  const onRename = async () => {
    const next = window.prompt("Rename thread:", thread?.title || "");
    if (!next) return;
    await renameThread(thread.id, next);
  };

  const onDelete = async () => {
    const ok = window.confirm(`Delete "${thread?.title}"?`);
    if (!ok) return;
    await deleteThread(thread.id);
  };

  return (
    <Wrap>
      <Header>
        <Left>
          <Title title={thread?.title || ""}>{thread?.title || "Thread"}</Title>
          <Sub>
            {isDefault
              ? "Tutorial thread (always available)"
              : "Upload media → transcribe / translate / summarize"}
          </Sub>
        </Left>

        <Actions>
          {showMobileHeaderActions && (
            <>
              <IconButton type="button" onClick={onOpenSidebar} aria-label="Open sidebar" title="Open sidebar">
                ☰
              </IconButton>
<NewThreadHeaderButton
  type="button"
  onClick={onCreateThread}
  disabled={!!creatingThread}
  title={creatingThread ? "Creating…" : "Create a new thread"}
>
  {creatingThread ? "Creating…" : "+ New thread"}
</NewThreadHeaderButton>

            </>
          )}

          {!isDefault && (
            <>
              <SmallButton type="button" onClick={onRename}>
                Rename
              </SmallButton>
              <DangerButton type="button" onClick={onDelete}>
                Delete
              </DangerButton>
            </>
          )}
        </Actions>
      </Header>

      <Body>
        {isDefault ? (
          <TutorialThread />
        ) : hasChatItems ? (
          <ChatTimeline thread={thread} showEmpty={false} />
        ) : (
<Empty>
  <EmptyCard>
    <EmptyTitle>Drop a file to get started</EmptyTitle>
    <EmptySub>
      Upload audio/video (or paste a media URL) to run transcription, translation, and/or summarization.
    </EmptySub>

    <EmptyHints>
      <li>Use + New thread to keep projects organized</li>
      <li>Runs and results will show up here</li>
      <li>Export anytime: SRT or text</li>
    </EmptyHints>
  </EmptyCard>
</Empty>

        )}
      </Body>

      {!isDefault && <ThreadComposer thread={thread} />}
    </Wrap>
  );
}

const Wrap = styled.div`
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
`;

const Header = styled.div`
  padding: 16px 18px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;

    @media(max-width: 786px){
    gap: 8px; 
    padding: 12px 18px;
  }
`;

const Left = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  @media(max-width: 786px){
    gap: 3px; 
  }
`;

const Actions = styled.div`
  display: flex;
  gap: 8px;
  flex: 0 0 auto;
`;

const IconButton = styled.button`
  width: 36px;
  height: 36px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--hover);
  color: var(--text);
  font-weight: 900;
  cursor: pointer;
  display: grid;
  place-items: center;

  &:hover {
    background: #ededee;
  }

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

    @media(max-width: 786px) {
    width: 32px;
    height: 32px;
  }
`;

// keep your existing styles below (Title/Sub/Body/etc)
const Title = styled.div`
  font-weight: 900;
  font-size: 15px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

    @media(max-width: 786px) {
    font-size: 14px;
  }
`;

const Sub = styled.div`
  font-size: 12px;
  color: var(--muted);
  @media(max-width: 786px) {
    font-size: 10px;
  }
 
`;

const Body = styled.div`
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 18px;
  background: var(--bg);
    @media(max-width: 786px) {
    padding: 11px;
  }
  
`;

const SmallButton = styled.button`
  border: 1px solid var(--border);
  background: var(--hover);
  color: var(--text);
  border-radius: 12px;
  padding: 8px 10px;
  font-weight: 800;
  cursor: pointer;

  &:hover {
    background: #ededee;
  }

      @media(max-width: 786px) {
    font-size: 12px;
  }
`;

const DangerButton = styled.button`
  border: 1px solid rgba(239, 68, 68, 0.25);
  background: rgba(239, 68, 68, 0.1);
  color: var(--accent);
  border-radius: 12px;
  padding: 8px 10px;
  font-weight: 900;
  cursor: pointer;

  &:hover {
    background: rgba(239, 68, 68, 0.14);
  }
    @media(max-width: 786px) {
    font-size: 12px;
  }
`;

// (Empty state styles unchanged)
const Empty = styled.div`
  height: 100%;
  display: grid;
  place-items: center;
  padding: 20px 10px;
`;

const EmptyCard = styled.div`
  width: 100%;
  max-width: 720px;
  border-radius: 18px;
  background: var(--panel);
  border: 1px solid var(--border);
  box-shadow: var(--shadow);
  padding: 18px;
  max-width: calc(min(80%, 720px));
`;

const EmptyTitle = styled.div`
  font-size: 16px;
  font-weight: 950;
  color: var(--text);
`;

const EmptySub = styled.div`
  margin-top: 6px;
  font-size: 13px;
  color: var(--muted);
  line-height: 1.4;
`;

const EmptyHints = styled.ul`
  margin: 12px 0 0;
  padding: 0 0 0 18px;
  color: var(--muted);
  font-size: 12px;

  li {
    margin: 6px 0;
  }
`;

const NewThreadHeaderButton = styled.button`
  border-radius: 12px;
  border: 1px solid rgba(239, 68, 68, 0.25);
  background: rgba(239, 68, 68, 0.08);
  color: var(--accent);
  font-weight: 900;

  height: 36px;
  padding: 0 12px;

  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 8px;

  white-space: nowrap;

  &:hover {
    background: rgba(239, 68, 68, 0.12);
  }

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

    @media(max-width: 786px) {
    height: 32px;
    font-size: 12px;
  }

  /* optional: if the header gets tight, hide text and keep "+" only */
  @media (max-width: 360px) {
    padding: 0 10px;

    /* show only the + on very tiny screens */
    span {
      display: none;
    }
  }
`;
