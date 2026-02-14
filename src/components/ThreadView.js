// components/ThreadView.js
import styled from "styled-components";
import TutorialThread from "./TutorialThread";
import ThreadComposer from "./ThreadComposer";
import { useThreads } from "../contexts/threadsContext";
import ChatTimeline from "./ChatTimeline";

function safeArr(x) {
  return Array.isArray(x) ? x : [];
}

export default function ThreadView({ thread, loading }) {
  const { renameThread, deleteThread } = useThreads();

  if (loading || !thread) {
    return (
      <Wrap>
        <Header>
          <Left>
            <Title>Loading…</Title>
            <Sub>Preparing your threads</Sub>
          </Left>
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

        {!isDefault && (
          <Right>
            <SmallButton type="button" onClick={onRename}>
              Rename
            </SmallButton>
            <DangerButton type="button" onClick={onDelete}>
              Delete
            </DangerButton>
          </Right>
        )}
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
                Choose what you want: transcription, translation, summarization — or any combo.
              </EmptySub>

              <EmptyHints>
                <li>Audio/video supported (later: Backblaze B2 + links)</li>
                <li>Runs will show up here like messages</li>
                <li>We’ll wire models/providers next</li>
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
`;

const Left = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
`;

const Right = styled.div`
  display: flex;
  gap: 8px;
  flex: 0 0 auto;
`;

const Title = styled.div`
  font-weight: 900;
  font-size: 15px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const Sub = styled.div`
  font-size: 12px;
  color: var(--muted);
`;

const Body = styled.div`
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 18px;
  background: var(--bg);
`;

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
`;
