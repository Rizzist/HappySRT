// components/ThreadComposer.js
import { useEffect, useMemo, useRef, useState } from "react";
import styled from "styled-components";
import { toast } from "sonner";
import { useThreads } from "../contexts/threadsContext";
import { useAuth } from "../contexts/AuthContext";
import { getLocalMedia } from "../lib/mediaStore";

import * as CatalogImport from "../shared/transcriptionCatalog";
const Catalog = (CatalogImport && (CatalogImport.default || CatalogImport)) || {};
const { LANGUAGES, getModelsForLanguage, getModelById } = Catalog;

function ensureDraftShape(d) {
  const out = d && typeof d === "object" ? { ...d } : {};
  if (!Array.isArray(out.files)) out.files = [];
  return out;
}

function isAudioOrVideo(file) {
  const t = String(file?.type || "");
  return t.startsWith("audio/") || t.startsWith("video/");
}

function isReadyDraftFile(f) {
  const stage = String(f?.stage || "");
  return stage === "uploaded" || stage === "linked";
}

function isBusyDraftFile(f) {
  const stage = String(f?.stage || "");
  return stage === "uploading" || stage === "converting" || stage === "linking";
}

function safeArr(x) {
  return Array.isArray(x) ? x : [];
}

export default function ThreadComposer({ thread }) {
  const {
    addDraftMediaFromFile,
    addDraftMediaFromUrl,
    deleteDraftMedia,
    startRun,
    wsStatus,
    wsError,
    requestThreadSnapshot,
  } = useThreads();

  const { user, isAnonymous } = useAuth();

  const [url, setUrl] = useState("");

  const [doTranscribe, setDoTranscribe] = useState(true);
  const [doTranslate, setDoTranslate] = useState(false);
  const [doSummarize, setDoSummarize] = useState(false);

  const [asrLang, setAsrLang] = useState("auto");
  const [asrModel, setAsrModel] = useState("deepgram_nova3");

  const [trProvider, setTrProvider] = useState("google");
  const [trLang, setTrLang] = useState("en");
  const [sumModel, setSumModel] = useState("gpt-4o-mini");

  const draft = ensureDraftShape(thread?.draft);
  const files = draft.files || [];

  const [objectUrls, setObjectUrls] = useState({});
  const [playingId, setPlayingId] = useState(null);
  const mediaRefs = useRef({});

  const asrModelOptions = useMemo(() => {
    if (typeof getModelsForLanguage !== "function") return [];
    return safeArr(getModelsForLanguage(asrLang));
  }, [asrLang]);

  useEffect(() => {
    if (!asrModelOptions.length) return;

    const ok = asrModelOptions.some((m) => String(m?.id || "") === String(asrModel || ""));
    if (!ok) setAsrModel(String(asrModelOptions[0]?.id || "deepgram_nova3"));
  }, [asrLang, asrModelOptions, asrModel]);

  useEffect(() => {
    if (!LANGUAGES || !Array.isArray(LANGUAGES) || typeof getModelsForLanguage !== "function") {
      console.warn("[ThreadComposer] transcriptionCatalog import looks wrong", { Catalog });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ✅ FIX: depend on `files` (not `files.length`) so stage changes update previews.
  useEffect(() => {
    let alive = true;

    (async () => {
      if (!thread?.id) return;

      const next = {};
      const scope = isAnonymous ? "guest" : user?.$id;

      for (const f of files) {
        const itemId = f?.itemId;
        const clientFileId = f?.clientFileId;
        const local = f?.local;
        if (!itemId || !clientFileId || !local) continue;

        try {
          const blob = await getLocalMedia(scope, thread.id, clientFileId);
          if (blob) next[itemId] = URL.createObjectURL(blob);
        } catch {}
      }

      if (!alive) return;

      setObjectUrls((prev) => {
        for (const k of Object.keys(prev)) {
          if (!next[k]) URL.revokeObjectURL(prev[k]);
        }
        return next;
      });
    })();

    return () => {
      alive = false;
    };
  }, [thread?.id, isAnonymous, user?.$id, files]);

  useEffect(() => {
    for (const [id, el] of Object.entries(mediaRefs.current || {})) {
      if (!el) continue;
      if (playingId && String(id) === String(playingId)) continue;
      try {
        if (!el.paused) el.pause();
      } catch {}
    }
  }, [playingId]);

  // ✅ FIX: depend on `files`, not `.length`
  useEffect(() => {
    if (!playingId) return;
    const stillThere = (files || []).some((f) => String(f?.itemId) === String(playingId));
    if (!stillThere) setPlayingId(null);
  }, [files, playingId]);

  // ✅ FIX: recompute when any file changes (stage, itemId, etc.)
  const readyFiles = useMemo(() => {
    return (files || []).filter((f) => f?.itemId && isReadyDraftFile(f));
  }, [files]);

  const busyUploading = useMemo(() => {
    return (files || []).some((f) => isBusyDraftFile(f));
  }, [files]);

  const hasAnyOption = useMemo(() => {
    return Boolean(doTranscribe || doTranslate || doSummarize);
  }, [doTranscribe, doTranslate, doSummarize]);

  const threadIsValid = Boolean(thread?.id && thread.id !== "default");
  const wsIsReady = String(wsStatus || "") === "ready";
  const hasReadyMedia = readyFiles.length > 0;

  const startUi = useMemo(() => {
    if (!threadIsValid) return { disabled: true, text: "Select thread", title: "Select a thread to begin" };
    if (!hasAnyOption) return { disabled: true, text: "Pick options", title: "Choose transcription / translation / summarization" };
    if (busyUploading) return { disabled: true, text: "Uploading…", title: "Finish uploading/converting first" };
    if (!hasReadyMedia) return { disabled: true, text: "Add media", title: "Upload/link at least one media file first" };

    if (!wsIsReady) {
      const st = String(wsStatus || "");
      const label =
        st === "connecting" || st === "socket_open"
          ? "Connecting…"
          : st === "error"
          ? "WS error"
          : "Connecting…";
      return { disabled: true, text: label, title: "Connecting to realtime server (auth/HELLO)…" };
    }

    return { disabled: false, text: "Start", title: "Start processing" };
  }, [threadIsValid, hasAnyOption, busyUploading, hasReadyMedia, wsIsReady, wsStatus]);

  const onChooseFiles = async (e) => {
    const picked = Array.from(e.target.files || []);
    e.target.value = "";
    if (!thread?.id || picked.length === 0) return;

    const allowed = picked.filter(isAudioOrVideo);
    const rejected = picked.filter((f) => !isAudioOrVideo(f));

    if (rejected.length) toast.error("Only audio/video files are allowed.");

    for (const f of allowed) {
      await addDraftMediaFromFile(thread.id, f);
    }
  };

  const onAddUrl = async () => {
    const clean = String(url || "").trim();
    if (!clean || !thread?.id) return;
    await addDraftMediaFromUrl(thread.id, clean);
    setUrl("");
  };

  const playInline = async ({ itemId, previewUrl }) => {
    if (!previewUrl || !itemId) return;

    setPlayingId(itemId);

    setTimeout(() => {
      const el = mediaRefs.current[itemId];
      if (!el) return;

      try {
        if (!el.paused) {
          el.pause();
          return;
        }
        const p = el.play();
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch {}
    }, 0);
  };

  const onStart = async () => {
    if (startUi.disabled) {
      if (startUi.title) toast.error(startUi.title);
      return;
    }

    if (wsError?.message) {
      toast.error(wsError.message);
      return;
    }

    const first = readyFiles[0] || null;
    if (!first?.itemId) {
      toast.error("No ready media found. Upload/link media first.");
      return;
    }

    if (!wsIsReady) {
      toast.error("Realtime server not ready yet (auth/HELLO).");
      return;
    }

    const selectedModel = typeof getModelById === "function" ? getModelById(asrModel) : null;

    const options = {
      doTranscribe,
      asrLang,
      asrModel,
      asrProvider: selectedModel?.provider || null,
      asrModelName: selectedModel?.model || null,

      doTranslate,
      trProvider,
      trLang,

      doSummarize,
      sumModel,
    };

    const readyIds = readyFiles.map((x) => String(x?.itemId || "")).filter(Boolean);

    const ok = await startRun({ itemIds: readyIds, options });
    if (ok) {
      toast.success("Start sent");

      // ✅ extra safety: ask for a snapshot shortly after start
      // so draft/chatItems reconcile even if an event is missed.
      setTimeout(() => {
        try {
          requestThreadSnapshot && requestThreadSnapshot();
        } catch {}
      }, 450);
    }
  };

  const translateLangOptions = useMemo(() => {
    const all = safeArr(LANGUAGES);
    return all.filter((l) => l?.value && l.value !== "auto" && l.value !== "multi");
  }, []);

  return (
    <Dock>
      <Box>
        {files.length > 0 && (
          <MediaGrid>
            {files.map((f) => {
              const previewUrl = objectUrls[f.itemId] || (f.sourceType === "url" ? f.url : "");
              const isVideo = Boolean(f?.local?.isVideo) || String(f?.local?.mime || "").startsWith("video/");
              const isAudio = String(f?.local?.mime || "").startsWith("audio/");
              const isPlaying = String(playingId || "") === String(f.itemId || "");

              const stageLabel =
                f.stage === "uploaded"
                  ? "Uploaded (mp3)"
                  : f.stage === "converting"
                  ? "Converting to mp3…"
                  : f.stage === "uploading"
                  ? "Uploading mp3…"
                  : f.stage === "linked"
                  ? "Linked"
                  : f.stage || "Draft";

              const onDelete = async () => {
                try {
                  const el = mediaRefs.current[f.itemId];
                  if (el && !el.paused) el.pause();
                } catch {}
                if (isPlaying) setPlayingId(null);
                await deleteDraftMedia(thread.id, f.itemId);
              };

              const onOpenNewTab = () => {
                if (!previewUrl) return;
                window.open(previewUrl, "_blank", "noopener,noreferrer");
              };

              const onPlayClick = () => {
                if (!previewUrl) return;
                playInline({ itemId: f.itemId, previewUrl });
              };

              return (
                <Card key={f.itemId}>
                  <Thumb>
                    {previewUrl ? (
                      isVideo ? (
                        <VideoPlayer
                          ref={(el) => {
                            if (el) mediaRefs.current[f.itemId] = el;
                            else delete mediaRefs.current[f.itemId];
                          }}
                          src={previewUrl}
                          playsInline
                          preload="metadata"
                          muted={!isPlaying}
                          controls={isPlaying}
                          onEnded={() => {
                            if (String(playingId) === String(f.itemId)) setPlayingId(null);
                          }}
                        />
                      ) : isAudio ? (
                        isPlaying ? (
                          <AudioWrap>
                            <AudioPlayer
                              ref={(el) => {
                                if (el) mediaRefs.current[f.itemId] = el;
                                else delete mediaRefs.current[f.itemId];
                              }}
                              src={previewUrl}
                              controls
                              preload="metadata"
                              onEnded={() => {
                                if (String(playingId) === String(f.itemId)) setPlayingId(null);
                              }}
                            />
                          </AudioWrap>
                        ) : (
                          <AudioBadge>audio</AudioBadge>
                        )
                      ) : (
                        <LinkBadge>link</LinkBadge>
                      )
                    ) : (
                      <EmptyThumb>…</EmptyThumb>
                    )}

                    <HoverActions>
                      <IconButton type="button" title={isPlaying ? "Pause" : "Play"} onClick={onPlayClick}>
                        {isPlaying ? "❚❚" : "▶"}
                      </IconButton>

                      <IconButton type="button" title="Open in new tab" onClick={onOpenNewTab}>
                        ↗
                      </IconButton>

                      <IconButton type="button" title="Delete" onClick={onDelete}>
                        ✕
                      </IconButton>
                    </HoverActions>
                  </Thumb>

                  <Meta>
                    <Name title={f?.local?.name || f?.audio?.b2?.filename || f?.url || ""}>
                      {f?.local?.name || f?.audio?.b2?.filename || f?.url || "Media"}
                    </Name>
                    <Sub>{stageLabel}</Sub>
                  </Meta>
                </Card>
              );
            })}
          </MediaGrid>
        )}

        <TopRow>
          <Attach>
            <HiddenFile type="file" multiple accept="audio/*,video/*" onChange={onChooseFiles} />
            <AttachButton type="button" title="Attach media">
              📎
            </AttachButton>
          </Attach>

          <UrlInput placeholder="Paste a media URL and press +" value={url} onChange={(e) => setUrl(e.target.value)} />

          <AddUrlButton type="button" onClick={onAddUrl} disabled={!url.trim()}>
            +
          </AddUrlButton>

          <StartButton type="button" disabled={startUi.disabled} title={startUi.title} onClick={onStart}>
            {startUi.text}
          </StartButton>
        </TopRow>

        <OptionsRow>
          <Pill type="button" $on={doTranscribe} onClick={() => setDoTranscribe((v) => !v)}>
            Transcription
          </Pill>
          <Pill type="button" $on={doTranslate} onClick={() => setDoTranslate((v) => !v)}>
            Translation
          </Pill>
          <Pill type="button" $on={doSummarize} onClick={() => setDoSummarize((v) => !v)}>
            Summarization
          </Pill>
        </OptionsRow>

        {(doTranscribe || doTranslate || doSummarize) && (
          <Panel>
            {doTranscribe && (
              <Group>
                <GroupTitle>Transcription</GroupTitle>

                <Fields>
                  <Field>
                    <Label>Language</Label>
                    <Select value={asrLang} onChange={(e) => setAsrLang(e.target.value)}>
                      {safeArr(LANGUAGES).map((l) => (
                        <option key={String(l.value)} value={String(l.value)}>
                          {String(l.label || l.value)}
                        </option>
                      ))}
                    </Select>
                  </Field>

                  <Field>
                    <Label>Model</Label>
                    <Select value={asrModel} onChange={(e) => setAsrModel(e.target.value)}>
                      {asrModelOptions.length ? (
                        asrModelOptions.map((m) => (
                          <option key={String(m.id)} value={String(m.id)}>
                            {String(m.label || m.id)}
                          </option>
                        ))
                      ) : (
                        <option value={asrModel}>No models for this language</option>
                      )}
                    </Select>
                  </Field>
                </Fields>

              </Group>
            )}

            {doTranslate && (
              <Group>
                <GroupTitle>Translation</GroupTitle>
                <Fields>
                  <Field>
                    <Label>Provider</Label>
                    <Select value={trProvider} onChange={(e) => setTrProvider(e.target.value)}>
                      <option value="google">Google Translate</option>
                      <option value="deepl">DeepL</option>
                      <option value="gpt">AI (LLM)</option>
                    </Select>
                  </Field>

                  <Field>
                    <Label>Target</Label>
                    <Select value={trLang} onChange={(e) => setTrLang(e.target.value)}>
                      {translateLangOptions.map((l) => (
                        <option key={String(l.value)} value={String(l.value)}>
                          {String(l.label || l.value)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </Fields>
              </Group>
            )}

            {doSummarize && (
              <Group>
                <GroupTitle>Summarization</GroupTitle>
                <Fields>
                  <Field>
                    <Label>Model</Label>
                    <Select value={sumModel} onChange={(e) => setSumModel(e.target.value)}>
                      <option value="gpt-4o-mini">ChatGPT (fast)</option>
                      <option value="gpt-4o">ChatGPT (best)</option>
                      <option value="claude">Claude (later)</option>
                    </Select>
                  </Field>

                  <Field>
                    <Label>Style</Label>
                    <Select defaultValue="bullets">
                      <option value="bullets">Bullets</option>
                      <option value="tldr">TL;DR</option>
                      <option value="chapters">Chapters</option>
                    </Select>
                  </Field>
                </Fields>
              </Group>
            )}

          </Panel>
        )}
      </Box>
    </Dock>
  );
}

/* --- styles --- */

const Dock = styled.div`
  padding: 16px 18px;
  border-top: 1px solid var(--border);
  background: var(--bg);
  display: flex;
  justify-content: center;
`;

const Box = styled.div`
  width: 100%;
  max-width: 860px;
`;

const MediaGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 12px;

  @media (max-width: 900px) {
    grid-template-columns: repeat(3, 1fr);
  }
  @media (max-width: 680px) {
    grid-template-columns: repeat(2, 1fr);
  }
`;

const Card = styled.div`
  border: 1px solid var(--border);
  background: var(--panel);
  border-radius: 14px;
  overflow: hidden;
  box-shadow: var(--shadow);
`;

const Thumb = styled.div`
  position: relative;
  height: 110px;
  background: rgba(0, 0, 0, 0.05);

  &:hover > div {
    opacity: 1;
    pointer-events: auto;
  }
`;

const VideoPlayer = styled.video`
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
`;

const AudioWrap = styled.div`
  height: 100%;
  width: 100%;
  display: grid;
  place-items: center;
  padding: 10px;
`;

const AudioPlayer = styled.audio`
  width: 100%;
`;

const EmptyThumb = styled.div`
  height: 100%;
  display: grid;
  place-items: center;
  color: var(--muted);
  font-weight: 900;
`;

const AudioBadge = styled.div`
  height: 100%;
  display: grid;
  place-items: center;
  font-weight: 950;
  color: var(--text);
`;

const LinkBadge = styled.div`
  height: 100%;
  display: grid;
  place-items: center;
  font-weight: 950;
  color: var(--text);
`;

const HoverActions = styled.div`
  position: absolute;
  inset: 0;
  display: flex;
  align-items: flex-end;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 120ms ease;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.35), rgba(0, 0, 0, 0));
`;

const IconButton = styled.button`
  width: 34px;
  height: 34px;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.35);
  background: rgba(255, 255, 255, 0.18);
  color: #fff;
  font-weight: 900;
  cursor: pointer;

  &:hover {
    background: rgba(255, 255, 255, 0.26);
  }
`;

const Meta = styled.div`
  padding: 10px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
`;

const Name = styled.div`
  font-weight: 900;
  font-size: 12px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const Sub = styled.div`
  font-size: 11px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const TopRow = styled.div`
  display: grid;
  grid-template-columns: 44px 1fr 44px 92px;
  gap: 10px;
  align-items: center;
`;

const Attach = styled.label`
  position: relative;
  display: inline-grid;
  place-items: center;
`;

const HiddenFile = styled.input`
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
`;

const AttachButton = styled.div`
  width: 44px;
  height: 44px;
  border-radius: 14px;
  border: 1px solid var(--border);
  background: var(--panel);
  display: grid;
  place-items: center;
  font-size: 16px;
  box-shadow: var(--shadow);
`;

const UrlInput = styled.input`
  height: 44px;
  border-radius: 14px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
  padding: 0 14px;
  outline: none;
  box-shadow: var(--shadow);

  &::placeholder {
    color: rgba(107, 114, 128, 0.9);
  }
`;

const AddUrlButton = styled.button`
  height: 44px;
  width: 44px;
  border-radius: 14px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
  font-weight: 950;
  cursor: pointer;
  box-shadow: var(--shadow);

  &:hover:enabled {
    background: var(--hover);
  }
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

const StartButton = styled.button`
  height: 44px;
  border-radius: 14px;
  border: 1px solid rgba(239, 68, 68, 0.25);
  background: rgba(239, 68, 68, 0.1);
  color: var(--accent);
  font-weight: 950;
  cursor: pointer;
  box-shadow: var(--shadow);

  &:hover:enabled {
    background: rgba(239, 68, 68, 0.14);
  }
  &:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
`;

const OptionsRow = styled.div`
  margin-top: 12px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
`;

const Pill = styled.button`
  border-radius: 999px;
  border: 1px solid ${(p) => (p.$on ? "rgba(239,68,68,0.28)" : "var(--border)")};
  background: ${(p) => (p.$on ? "rgba(239,68,68,0.10)" : "var(--panel)")};
  color: ${(p) => (p.$on ? "var(--accent)" : "var(--text)")};
  font-weight: 900;
  font-size: 12px;
  padding: 8px 10px;
  cursor: pointer;
  box-shadow: var(--shadow);

  &:hover {
    background: ${(p) => (p.$on ? "rgba(239,68,68,0.12)" : "var(--hover)")};
  }
`;

const Panel = styled.div`
  margin-top: 12px;
  border-radius: 16px;
  border: 1px solid var(--border);
  background: var(--panel);
  box-shadow: var(--shadow);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
`;

const Group = styled.div`
  border: 1px solid var(--border);
  background: rgba(0, 0, 0, 0.015);
  border-radius: 14px;
  padding: 10px;
`;

const GroupTitle = styled.div`
  font-weight: 950;
  font-size: 12px;
  color: var(--text);
  margin-bottom: 8px;
`;

const Fields = styled.div`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;

  @media (max-width: 720px) {
    grid-template-columns: 1fr;
  }
`;

const Field = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
`;

const Label = styled.div`
  font-size: 11px;
  color: var(--muted);
  font-weight: 800;
`;

const Select = styled.select`
  height: 38px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: #fff;
  color: var(--text);
  padding: 0 10px;
  outline: none;

  &:focus {
    border-color: rgba(239, 68, 68, 0.35);
    box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.1);
  }
`;


