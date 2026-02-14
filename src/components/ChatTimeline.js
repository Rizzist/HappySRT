// components/ChatTimeline.js
import { useEffect, useMemo, useRef, useState } from "react";
import styled from "styled-components";
import { createPortal } from "react-dom";
import { useThreads } from "../contexts/threadsContext";
import ChatMediaPlayer from "./ChatMediaPlayer";
import LegacySrtSegmentsEditor from "./LegacySrtSegmentsEditor";

import * as CatalogImport from "../shared/transcriptionCatalog";
const Catalog = (CatalogImport && (CatalogImport.default || CatalogImport)) || {};
const { LANGUAGES, getModelsForLanguage } = Catalog;

function normalizeWhitespace(t) {
  return String(t || "").replace(/\s+/g, " ").trim();
}

function segKey(seg) {
  const s = Number(seg?.start || 0);
  const e = Number(seg?.end || 0);
  const t = normalizeWhitespace(seg?.text || "");
  return `${s.toFixed(3)}|${e.toFixed(3)}|${t}`;
}

function mergeSegments(a, b) {
  const A = Array.isArray(a) ? a : [];
  const B = Array.isArray(b) ? b : [];
  if (!A.length) return B.slice();
  if (!B.length) return A.slice();

  const seen = new Set();
  const out = [];

  for (const seg of [...A, ...B]) {
    if (!seg) continue;
    const k = segKey(seg);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(seg);
  }

  out.sort(
    (x, y) =>
      (Number(x?.start || 0) - Number(y?.start || 0)) ||
      (Number(x?.end || 0) - Number(y?.end || 0))
  );
  return out;
}

function safeArr(x) {
  return Array.isArray(x) ? x : [];
}

function isBusy(stepStatus) {
  const s = String(stepStatus?.state || "");
  return s === "queued" || s === "running";
}
function isFailed(stepStatus) {
  return String(stepStatus?.state || "") === "failed";
}

function deriveStage(stepStatus, stepName) {
  const state = String(stepStatus?.state || "");
  const stage = String(stepStatus?.stage || "");
  if (stage) return stage;
  if (state === "queued") return "QUEUED";
  if (state === "running") return stepName === "transcribe" ? "TRANSCRIBING" : "RUNNING";
  if (state === "done") return "DONE";
  if (state === "failed") return "FAILED";
  if (state === "blocked") return "BLOCKED";
  return state || "—";
}

// If edited SRT exists, parse it into segments so highlight+seek match edits
function parseTimecodeToSeconds(tc) {
  const s = String(tc || "").trim();
  const m = s.match(/^(\d+):(\d+):(\d+),(\d+)$/);
  if (!m) return null;
  const hh = Number(m[1] || 0);
  const mm = Number(m[2] || 0);
  const ss = Number(m[3] || 0);
  const ms = Number(m[4] || 0);
  if (![hh, mm, ss, ms].every((x) => Number.isFinite(x))) return null;
  return hh * 3600 + mm * 60 + ss + ms / 1000;
}

function srtToSegments(srt) {
  const raw = String(srt || "").trim();
  if (!raw) return [];
  const blocks = raw.split(/\n\s*\n/g);
  const out = [];

  for (const b of blocks) {
    const lines = b.split("\n").map((x) => String(x || "").trim());
    if (lines.length < 3) continue;

    const ts = lines[1] || "";
    const parts = ts.split(" --> ");
    if (parts.length !== 2) continue;

    const start = parseTimecodeToSeconds(parts[0]);
    const end = parseTimecodeToSeconds(parts[1]);
    if (start == null || end == null) continue;

    const text = normalizeWhitespace(lines.slice(2).join("\n"));
    out.push({ start, end, text });
  }

  out.sort((a, b) => (a.start - b.start) || (a.end - b.end));
  return out;
}

function segmentsToPlainText(segments) {
  const segs = Array.isArray(segments) ? segments : [];
  return segs
    .map((s) => normalizeWhitespace(s?.text || ""))
    .filter(Boolean)
    .join(" ")
    .trim();
}

function stateTone(stepStatus) {
  const s = String(stepStatus?.state || "");
  if (s === "done") return "done";
  if (s === "failed") return "failed";
  if (s === "running") return "running";
  if (s === "queued") return "queued";
  if (s === "blocked") return "blocked";
  return "idle";
}

function pickDefaultModelIdForLang(lang) {
  const l = String(lang || "auto") || "auto";
  if (typeof getModelsForLanguage !== "function") return "deepgram_nova3";
  const opts = safeArr(getModelsForLanguage(l));
  return String(opts?.[0]?.id || "deepgram_nova3");
}

function isActiveAtTime(seg, t) {
  const s = Number(seg?.start || 0);
  const e = Number(seg?.end || 0);
  const time = Number(t || 0);
  return time >= s && time < e;
}

function fmtClock(seconds) {
  const s = Math.max(0, Number(seconds || 0));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const pad = (n) => String(n).padStart(2, "0");
  if (hh > 0) return `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
  return `${pad(mm)}:${pad(ss)}`;
}

export default function ChatTimeline({ thread, showEmpty = true }) {
  const { liveRunsByThread, retryTranscribe, saveSrt } = useThreads();

  const [tabByItem, setTabByItem] = useState({});
  const [transViewByItem, setTransViewByItem] = useState({}); // srt | text
  const [timeByItem, setTimeByItem] = useState({});

  // dropdown state (only for T)
  const [openMenuFor, setOpenMenuFor] = useState(null); // chatItemId
  const anchorElRef = useRef(null);
  const menuElRef = useRef(null);
  const [menuPos, setMenuPos] = useState(null); // { top, left, width, placement }

  const [transOptsByItem, setTransOptsByItem] = useState({}); // chatItemId -> { language, modelId }

  // store player APIs so transcript clicks can seek
  const playerApisRef = useRef({}); // chatItemId -> api

  // editor refs + meta (dirty/invalid) so Save/Reset can live in Output header
  const srtEditorRefsRef = useRef({}); // chatItemId -> ref api
  const [srtMetaByItem, setSrtMetaByItem] = useState({}); // chatItemId -> { dirty, hasBadTime }

  // optimistic saved srt so UI instantly reflects save
  const [optimisticSrtByItem, setOptimisticSrtByItem] = useState({}); // chatItemId -> srt string

  const items = useMemo(() => {
    const arr = safeArr(thread?.chatItems);
    return arr
      .slice()
      .sort((a, b) => (Date.parse(b?.createdAt || 0) || 0) - (Date.parse(a?.createdAt || 0) || 0));
  }, [thread?.chatItems]);

  // clear optimistic entries once thread results catch up
  useEffect(() => {
    setOptimisticSrtByItem((prev) => {
      const next = { ...(prev || {}) };
      for (const it of items) {
        const id = String(it?.chatItemId || "");
        if (!id) continue;
        const persisted = String(it?.results?.transcriptSrt || "").trim();
        const opt = String(next[id] || "").trim();
        if (opt && persisted && opt === persisted) delete next[id];
      }
      return next;
    });
  }, [items]);

  const live =
    liveRunsByThread && liveRunsByThread[String(thread?.id)]
      ? liveRunsByThread[String(thread?.id)]
      : null;

  const liveChat = live?.chatItems && typeof live.chatItems === "object" ? live.chatItems : {};

  const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";

  const computeMenuPos = () => {
    if (!isBrowser) return;
    const anchor = anchorElRef.current;
    if (!anchor) return;

    const rect = anchor.getBoundingClientRect();

    // smaller menu
    const width = Math.min(420, Math.max(300, Math.floor(window.innerWidth * 0.36)));
    const pad = 12;

    let left = rect.right - width;
    left = Math.max(pad, Math.min(left, window.innerWidth - width - pad));

    // default: open downward
    let top = rect.bottom + 8;
    let placement = "bottom";

    setMenuPos({ top, left, width, placement, _anchorTop: rect.top, _anchorBottom: rect.bottom });
  };

  const refineMenuPlacement = () => {
    if (!isBrowser) return;
    if (!menuElRef.current) return;
    if (!menuPos) return;

    const mr = menuElRef.current.getBoundingClientRect();
    const pad = 12;

    // if it overflows bottom and we have space above, flip upward
    if (mr.bottom > window.innerHeight - pad) {
      const anchorTop = Number(menuPos?._anchorTop || 0);
      const desiredTop = anchorTop - mr.height - 8;
      if (desiredTop >= pad) {
        setMenuPos((p) => (p ? { ...p, top: desiredTop, placement: "top" } : p));
      }
    }
  };

  const closeMenu = () => {
    setOpenMenuFor(null);
    anchorElRef.current = null;
    setMenuPos(null);
  };

  useEffect(() => {
    if (!openMenuFor) return;

    computeMenuPos();

    const onDown = (e) => {
      const t = e?.target;
      if (!t) return;

      const a = anchorElRef.current;
      const m = menuElRef.current;

      if (a && a.contains(t)) return;
      if (m && m.contains(t)) return;

      closeMenu();
    };

    const onKey = (e) => {
      if (String(e?.key || "") === "Escape") closeMenu();
    };

    const onReflow = () => {
      computeMenuPos();
      requestAnimationFrame(() => refineMenuPlacement());
    };

    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);

    requestAnimationFrame(() => refineMenuPlacement());

    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openMenuFor]);

  if (!items.length) {
    if (!showEmpty) return null;
    return (
      <EmptyCard>
        <EmptyTitle>No messages yet</EmptyTitle>
        <EmptySub>Press Start to move uploaded media into chat items.</EmptySub>
      </EmptyCard>
    );
  }

  const languageOptions = safeArr(LANGUAGES);

  return (
    <List>
      {items.map((it) => {
        const chatItemId = String(it?.chatItemId || "");
        const media = it?.media || {};
        const status = it?.status || {};
        const results = it?.results || {};
        const liveOne = liveChat[chatItemId] || null;

        const tab = tabByItem[chatItemId] || "transcribe";
        const transView = transViewByItem[chatItemId] || "srt";

        const trans = status?.transcribe || {};
        const tr = status?.translate || {};
        const sum = status?.summarize || {};

        const transState = String(trans?.state || "");
        const isTranscribing = transState === "running";

        const persistedSrtRaw = String(results?.transcriptSrt || "");
        const optimisticSrt = String(optimisticSrtByItem?.[chatItemId] || "");
        const persistedSrt = (optimisticSrt || persistedSrtRaw || "").trim();

        const editedSegs = persistedSrt ? srtToSegments(persistedSrt) : [];
        const persistedSegs = editedSegs.length
          ? editedSegs
          : Array.isArray(results?.transcriptSegments)
          ? results.transcriptSegments
          : [];

        const liveSegs = Array.isArray(liveOne?.segments?.transcribe) ? liveOne.segments.transcribe : [];
        const mergedSegs = isTranscribing ? mergeSegments(persistedSegs, liveSegs) : persistedSegs;

        const segPlain = segmentsToPlainText(mergedSegs);

        const fallbackStream =
          tab === "transcribe"
            ? safeArr(liveOne?.stream?.transcribe).join("") || ""
            : tab === "translate"
            ? safeArr(liveOne?.stream?.translate).join("") || ""
            : safeArr(liveOne?.stream?.summarize).join("") || "";

        const showText =
          tab === "transcribe"
            ? results?.transcript || ""
            : tab === "translate"
            ? results?.translation || ""
            : results?.summary || "";

        const curTime = Number(timeByItem[chatItemId] || 0);

        const title = media?.filename || media?.name || (media?.url ? "linked media" : "media");

        const toneT = stateTone(trans);
        const toneTR = stateTone(tr);
        const toneS = stateTone(sum);

        const isMenuOpen = openMenuFor === chatItemId;

        const seedLang = String(trans?.language || "") || "auto";
        const seedModel = String(trans?.modelId || "") || pickDefaultModelIdForLang(seedLang);

        const opts = transOptsByItem[chatItemId] || {
          language: seedLang,
          modelId: seedModel,
        };

        const modelsForLang =
          typeof getModelsForLanguage === "function"
            ? safeArr(getModelsForLanguage(String(opts.language || "auto") || "auto"))
            : [];

        const modelIsValid = modelsForLang.some((m) => String(m?.id || "") === String(opts.modelId || ""));
        const effectiveModelId =
          String(opts.modelId || "") && (modelsForLang.length ? modelIsValid : true)
            ? String(opts.modelId || "")
            : String(modelsForLang?.[0]?.id || pickDefaultModelIdForLang(opts.language));

        const canReTranscribe = String(trans?.state || "") !== "running";

        const openMenu = (e) => {
          if (!isBrowser) return;
          const el = e?.currentTarget;
          if (!el) return;

          // seed options on first open
          setTransOptsByItem((p) => {
            const cur = p?.[chatItemId];
            if (cur) return p || {};

            const lang = seedLang;
            const models = typeof getModelsForLanguage === "function" ? safeArr(getModelsForLanguage(lang)) : [];
            const modelId = String(trans?.modelId || "") || String(models?.[0]?.id || pickDefaultModelIdForLang(lang));

            return {
              ...(p || {}),
              [chatItemId]: {
                language: lang,
                modelId,
              },
            };
          });

          if (isMenuOpen) {
            closeMenu();
            return;
          }

          anchorElRef.current = el;
          setOpenMenuFor(chatItemId);
        };

        const doSeek = (t) => {
          const api = playerApisRef.current?.[chatItemId];
          if (api && typeof api.seek === "function") api.seek(t);
        };

        // single button that covers retry + re-transcribe + "apply current settings"
        const doReTranscribe = () => {
          setTabByItem((p) => ({ ...(p || {}), [chatItemId]: "transcribe" }));
          setTransViewByItem((p) => ({ ...(p || {}), [chatItemId]: "srt" }));

          retryTranscribe({
            chatItemId,
            options: {
              force: true,
              clear: true,
              asrLang: String(opts.language || "auto") || "auto",
              asrModel: String(effectiveModelId || "deepgram_nova3") || "deepgram_nova3",
            },
          });

          closeMenu();
        };

        const outputHeaderLabel =
          tab === "transcribe" ? (transView === "srt" ? "SRT" : "Text") : tab === "translate" ? "Translation" : "Summary";

        const meta = srtMetaByItem?.[chatItemId] || {};
        const dirty = !!meta.dirty;
        const hasBadTime = !!meta.hasBadTime;

        const canReset = tab === "transcribe" && transView === "srt" && !isTranscribing && dirty;
        const canSave = tab === "transcribe" && transView === "srt" && !isTranscribing && dirty && !hasBadTime;

        const doReset = () => {
          const api = srtEditorRefsRef.current?.[chatItemId];
          if (api && typeof api.reset === "function") api.reset();
        };

        const doSave = () => {
          const api = srtEditorRefsRef.current?.[chatItemId];
          if (api && typeof api.save === "function") api.save();
        };

        const transcriptionBody =
          transView === "srt" ? (
            <SrtModeWrap>
              <LegacySrtSegmentsEditor
                ref={(r) => {
                  if (!r) {
                    const next = { ...(srtEditorRefsRef.current || {}) };
                    delete next[chatItemId];
                    srtEditorRefsRef.current = next;
                    return;
                  }
                  srtEditorRefsRef.current = { ...(srtEditorRefsRef.current || {}), [chatItemId]: r };
                }}
                segments={mergedSegs}
                currentTime={curTime}
                onSeek={(t) => doSeek(t)}
                disabled={isTranscribing}
                maxHeight={360}
                onMeta={(m) => {
                  setSrtMetaByItem((p) => ({ ...(p || {}), [chatItemId]: m || {} }));
                }}
                onSave={({ transcriptSrt, transcriptText }) => {
                  // optimistic UI
                  setOptimisticSrtByItem((p) => ({ ...(p || {}), [chatItemId]: String(transcriptSrt || "") }));
                  saveSrt({ chatItemId, transcriptSrt, transcriptText });
                }}
              />

              {!mergedSegs.length && (fallbackStream || showText || segPlain) ? (
                <LiveTextHint>
                  <LiveTextTitle>Text (while SRT builds)</LiveTextTitle>
                  <LiveTextBody>{showText || segPlain || fallbackStream}</LiveTextBody>
                </LiveTextHint>
              ) : null}
            </SrtModeWrap>
          ) : mergedSegs.length ? (
            <TextSnippets aria-label="Transcript text (clickable)">
              {mergedSegs.map((seg, idx) => {
                const txt = normalizeWhitespace(seg?.text || "");
                if (!txt) return null;

                const active = isActiveAtTime(seg, curTime);
                return (
                  <Snippet
                    key={`${segKey(seg)}|${idx}`}
                    $active={active}
                    title={`${fmtClock(seg?.start)} → ${fmtClock(seg?.end)} (click to seek)`}
                    onClick={() => doSeek(Number(seg?.start || 0))}
                  >
                    {txt}
                  </Snippet>
                );
              })}
            </TextSnippets>
          ) : (
            <Text>{showText || segPlain || fallbackStream || "—"}</Text>
          );

        const outputBody =
          tab === "transcribe" ? (
            transcriptionBody
          ) : (
            <Text>{showText || fallbackStream || "—"}</Text>
          );

        return (
          <Card key={chatItemId}>
            <CardHead>
              <HeadLeft>
                <Title title={title}>{title}</Title>
                <Sub>
                  {String(media?.mime || "") || "—"}
                  {trans?.language ? ` • ${String(trans.language)}` : ""}
                  {trans?.modelId ? ` • ${String(trans.modelId)}` : ""}
                </Sub>
              </HeadLeft>

              <HeadRight>
                <StepBtn type="button" $tone={toneT} onClick={openMenu} $open={isMenuOpen} title="Transcription options">
                  <Dot $tone={toneT} />
                  <StepK> T </StepK>
                  <StepV>{deriveStage(trans, "transcribe")}</StepV>
                  {isBusy(trans) ? <Spinner /> : null}
                  <Caret $open={isMenuOpen}>▾</Caret>
                </StepBtn>

                <StepPill $tone={toneTR} title="Translation">
                  <Dot $tone={toneTR} />
                  <StepK> TR </StepK>
                  <StepV>{deriveStage(tr, "translate")}</StepV>
                </StepPill>

                <StepPill $tone={toneS} title="Summary">
                  <Dot $tone={toneS} />
                  <StepK> S </StepK>
                  <StepV>{deriveStage(sum, "summarize")}</StepV>
                </StepPill>

                {isFailed(trans) && trans?.error ? <Err title={String(trans.error)}>{String(trans.error)}</Err> : null}
              </HeadRight>
            </CardHead>

            <Grid>
              <Left>
                <ChatMediaPlayer
                  threadId={String(thread?.id || "")}
                  item={it}
                  media={media}
                  onTime={(t) => setTimeByItem((p) => ({ ...(p || {}), [chatItemId]: t }))}
                  onApi={(api) => {
                    if (!api) {
                      const next = { ...(playerApisRef.current || {}) };
                      delete next[chatItemId];
                      playerApisRef.current = next;
                      return;
                    }
                    playerApisRef.current = { ...(playerApisRef.current || {}), [chatItemId]: api };
                  }}
                />
              </Left>

              <Right>
                <Tabs>
                  <TabBtn
                    type="button"
                    $on={tab === "transcribe"}
                    onClick={() => setTabByItem((p) => ({ ...(p || {}), [chatItemId]: "transcribe" }))}
                  >
                    Transcription
                  </TabBtn>
                  <TabBtn
                    type="button"
                    $on={tab === "translate"}
                    onClick={() => setTabByItem((p) => ({ ...(p || {}), [chatItemId]: "translate" }))}
                  >
                    Translation
                  </TabBtn>
                  <TabBtn
                    type="button"
                    $on={tab === "summarize"}
                    onClick={() => setTabByItem((p) => ({ ...(p || {}), [chatItemId]: "summarize" }))}
                  >
                    Summary
                  </TabBtn>
                </Tabs>

                <Output $tight={tab === "transcribe" && transView === "srt"}>
                  <OutputHead>
                    <OutTitle>
                      {outputHeaderLabel}
                      {tab === "transcribe" && transView === "srt" && dirty ? <DirtyPill>unsaved</DirtyPill> : null}
                      {tab === "transcribe" && transView === "srt" && hasBadTime ? <BadPill>bad timecode</BadPill> : null}
                    </OutTitle>

                    {tab === "transcribe" ? (
                      <HdrRight>
                        {transView === "srt" ? (
                          <HdrActions>
                            <HdrBtn type="button" onClick={doReset} disabled={!canReset} title="Discard local edits">
                              Reset
                            </HdrBtn>
                            <HdrBtn type="button" onClick={doSave} disabled={!canSave} title="Save SRT edits">
                              Save
                            </HdrBtn>
                          </HdrActions>
                        ) : null}

                        <Switch>
                          <SwitchBtn
                            type="button"
                            $on={transView === "srt"}
                            onClick={() => setTransViewByItem((p) => ({ ...(p || {}), [chatItemId]: "srt" }))}
                          >
                            SRT
                          </SwitchBtn>
                          <SwitchBtn
                            type="button"
                            $on={transView === "text"}
                            onClick={() => setTransViewByItem((p) => ({ ...(p || {}), [chatItemId]: "text" }))}
                          >
                            Text
                          </SwitchBtn>
                        </Switch>
                      </HdrRight>
                    ) : null}
                  </OutputHead>

                  <OutputBody>{outputBody}</OutputBody>
                </Output>
              </Right>
            </Grid>

            {/* Dropdown (Portal) */}
            {isBrowser && isMenuOpen && menuPos
              ? createPortal(
                  <Menu
                    ref={menuElRef}
                    style={{
                      position: "fixed",
                      top: menuPos.top,
                      left: menuPos.left,
                      width: menuPos.width,
                      maxHeight: `calc(100vh - ${Math.max(12, menuPos.top)}px - 12px)`,
                      overflow: "auto",
                    }}
                    role="dialog"
                    aria-label="Transcription options"
                  >
                    <MenuTop>
                      <MenuTitle>Transcription</MenuTitle>
                      <MenuStatus>
                        <Dot $tone={toneT} />
                        <MenuStatusText>{deriveStage(trans, "transcribe")}</MenuStatusText>
                      </MenuStatus>
                    </MenuTop>

                    <MenuRow>
                      <MenuAction
                        type="button"
                        onClick={doReTranscribe}
                        disabled={!canReTranscribe}
                        title={isTranscribing ? "Transcription is running" : "Retry / re-run with these settings"}
                      >
                        Re-transcribe
                      </MenuAction>
                    </MenuRow>

                    <MenuDivider />

                    {/* Language + Model dropdowns (like composer) */}
                    <MenuField>
                      <MenuLabel>Language</MenuLabel>

                      {languageOptions.length ? (
                        <MenuSelect
                          value={String(opts.language || "auto")}
                          onChange={(e) => {
                            const nextLang = String(e?.target?.value || "auto") || "auto";

                            // adjust model if it doesn't exist for the new language
                            const models =
                              typeof getModelsForLanguage === "function" ? safeArr(getModelsForLanguage(nextLang)) : [];

                            const curModel = String((transOptsByItem?.[chatItemId]?.modelId || opts.modelId) || "");
                            const ok = models.some((m) => String(m?.id || "") === curModel);
                            const nextModel = ok
                              ? curModel
                              : String(models?.[0]?.id || pickDefaultModelIdForLang(nextLang));

                            setTransOptsByItem((p) => ({
                              ...(p || {}),
                              [chatItemId]: { ...(p?.[chatItemId] || {}), language: nextLang, modelId: nextModel },
                            }));
                          }}
                        >
                          {languageOptions.map((l) => (
                            <option key={String(l.value)} value={String(l.value)}>
                              {String(l.label || l.value)}
                            </option>
                          ))}
                        </MenuSelect>
                      ) : (
                        <MenuInput
                          value={String(opts.language || "")}
                          onChange={(e) => {
                            const v = e?.target?.value;
                            setTransOptsByItem((p) => ({
                              ...(p || {}),
                              [chatItemId]: { ...(p?.[chatItemId] || {}), language: String(v || "") },
                            }));
                          }}
                          placeholder="e.g. auto, en, en-GB, ar..."
                        />
                      )}
                    </MenuField>

                    <MenuField>
                      <MenuLabel>Model</MenuLabel>

                      {modelsForLang.length ? (
                        <MenuSelect
                          value={String(effectiveModelId || "")}
                          onChange={(e) => {
                            const v = String(e?.target?.value || "");
                            setTransOptsByItem((p) => ({
                              ...(p || {}),
                              [chatItemId]: { ...(p?.[chatItemId] || {}), modelId: String(v || "") },
                            }));
                          }}
                        >
                          {modelsForLang.map((m) => (
                            <option key={String(m.id)} value={String(m.id)}>
                              {String(m.label || m.id)}
                            </option>
                          ))}
                        </MenuSelect>
                      ) : (
                        <MenuInput
                          value={String(opts.modelId || "")}
                          onChange={(e) => {
                            const v = e?.target?.value;
                            setTransOptsByItem((p) => ({
                              ...(p || {}),
                              [chatItemId]: { ...(p?.[chatItemId] || {}), modelId: String(v || "") },
                            }));
                          }}
                          placeholder="e.g. deepgram_nova3..."
                        />
                      )}
                    </MenuField>

                    <MenuNote>
                      Re-transcribe will retry if it failed/queued, or re-run after done — always using the language/model
                      selected above.
                    </MenuNote>
                  </Menu>,
                  document.body
                )
              : null}
          </Card>
        );
      })}
    </List>
  );
}

const List = styled.div`
  display: flex;
  flex-direction: column;
  gap: 14px;
`;

const Card = styled.div`
  border: 1px solid var(--border);
  background: var(--panel);
  border-radius: 18px;
  box-shadow: var(--shadow);
  overflow: hidden; /* portal dropdown avoids clipping now */
`;

const CardHead = styled.div`
  padding: 14px 14px 10px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
`;

const HeadLeft = styled.div`
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
`;

const Title = styled.div`
  font-weight: 950;
  color: var(--text);
  font-size: 13px;
  max-width: 560px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const Sub = styled.div`
  font-size: 12px;
  color: var(--muted);
  font-weight: 800;
`;

const HeadRight = styled.div`
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
`;

const StepBase = styled.div`
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 7px 10px;
  font-size: 11px;
  color: var(--text);
  font-weight: 950;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: rgba(0, 0, 0, 0.02);
`;

const StepPill = styled(StepBase)`
  user-select: none;
`;

const StepBtn = styled.button`
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 7px 10px;
  font-size: 11px;
  color: var(--text);
  font-weight: 950;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: rgba(0, 0, 0, 0.02);
  cursor: pointer;

  &:hover {
    background: rgba(0, 0, 0, 0.04);
  }

  &:active {
    background: rgba(0, 0, 0, 0.05);
  }

  box-shadow: ${(p) => (p.$open ? "0 0 0 3px rgba(0,0,0,0.04)" : "none")};
`;

const Dot = styled.span`
  width: 10px;
  height: 10px;
  border-radius: 999px;
  display: inline-block;
  box-shadow: 0 0 0 3px rgba(0, 0, 0, 0.03) inset;

  background: ${(p) =>
    p.$tone === "done"
      ? "rgba(46, 204, 113, 0.95)"
      : p.$tone === "failed"
      ? "rgba(239, 68, 68, 0.95)"
      : p.$tone === "running"
      ? "rgba(52, 152, 219, 0.95)"
      : p.$tone === "queued"
      ? "rgba(245, 158, 11, 0.95)"
      : p.$tone === "blocked"
      ? "rgba(148, 163, 184, 0.95)"
      : "rgba(148, 163, 184, 0.8)"};
`;

const StepK = styled.span`
  font-weight: 1000;
  letter-spacing: 0.2px;
`;

const StepV = styled.span`
  font-weight: 950;
  opacity: 0.95;
`;

const Caret = styled.span`
  font-size: 12px;
  opacity: 0.8;
  transform: ${(p) => (p.$open ? "rotate(180deg)" : "rotate(0deg)")};
  transition: transform 0.12s ease;
`;

const Err = styled.div`
  font-size: 11px;
  font-weight: 900;
  color: var(--accent);
  max-width: 360px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const Spinner = styled.span`
  width: 12px;
  height: 12px;
  border: 2px solid #999;
  border-bottom-color: transparent;
  border-radius: 50%;
  display: inline-block;
  animation: spin 0.6s linear infinite;

  @keyframes spin {
    0% {
      transform: rotate(0deg);
    }
    100% {
      transform: rotate(360deg);
    }
  }
`;

const Grid = styled.div`
  display: grid;
  grid-template-columns: 420px 1fr;
  gap: 14px;
  padding: 14px;

  @media (max-width: 980px) {
    grid-template-columns: 1fr;
  }
`;

const Left = styled.div`
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
`;

const Right = styled.div`
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
`;

const Tabs = styled.div`
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
`;

const TabBtn = styled.button`
  border-radius: 999px;
  border: 1px solid ${(p) => (p.$on ? "rgba(239,68,68,0.28)" : "var(--border)")};
  background: ${(p) => (p.$on ? "rgba(239,68,68,0.10)" : "var(--panel)")};
  color: ${(p) => (p.$on ? "var(--accent)" : "var(--text)")};
  font-weight: 950;
  font-size: 12px;
  padding: 8px 12px;
  cursor: pointer;

  &:hover {
    background: ${(p) => (p.$on ? "rgba(239,68,68,0.12)" : "var(--hover)")};
  }
`;

const Output = styled.div`
  border: 1px solid var(--border);
  border-radius: 14px;
  background: rgba(0, 0, 0, 0.02);
  padding: ${(p) => (p.$tight ? "8px 10px 10px" : "10px 12px 12px")};
`;

const OutputHead = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
`;

const OutTitle = styled.div`
  font-size: 12px;
  font-weight: 950;
  color: var(--text);
  display: inline-flex;
  align-items: center;
  gap: 8px;
`;

const DirtyPill = styled.span`
  font-size: 10.5px;
  font-weight: 900;
  color: var(--accent);
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.22);
  padding: 2px 7px;
  border-radius: 999px;
`;

const BadPill = styled.span`
  font-size: 10.5px;
  font-weight: 900;
  color: rgba(239, 68, 68, 0.95);
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.22);
  padding: 2px 7px;
  border-radius: 999px;
`;

const HdrRight = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 10px;
`;

const HdrActions = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 8px;
`;

const HdrBtn = styled.button`
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
  font-weight: 950;
  font-size: 11px;
  padding: 7px 10px;
  cursor: pointer;

  &:hover {
    background: var(--hover);
  }

  &:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
`;

const OutputBody = styled.div`
  min-height: 44px;
`;

const Text = styled.pre`
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  color: var(--text);
  line-height: 1.45;
`;

const Switch = styled.div`
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--panel);
  padding: 3px;
  display: inline-flex;
  gap: 4px;
`;

const SwitchBtn = styled.button`
  border: 0;
  border-radius: 999px;
  padding: 6px 10px;
  font-weight: 950;
  font-size: 12px;
  cursor: pointer;
  background: ${(p) => (p.$on ? "rgba(239,68,68,0.10)" : "transparent")};
  color: ${(p) => (p.$on ? "var(--accent)" : "var(--text)")};

  &:hover {
    background: ${(p) => (p.$on ? "rgba(239,68,68,0.12)" : "rgba(0,0,0,0.04)")};
  }
`;

const SrtModeWrap = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px; /* tighter */
`;

const LiveTextHint = styled.div`
  border: 1px dashed var(--border);
  border-radius: 12px;
  padding: 10px;
  background: rgba(0, 0, 0, 0.02);
`;

const LiveTextTitle = styled.div`
  font-size: 11px;
  font-weight: 950;
  color: var(--muted);
  margin-bottom: 6px;
`;

const LiveTextBody = styled.div`
  font-size: 12px;
  color: var(--text);
  line-height: 1.45;
  white-space: pre-wrap;
`;

/* clickable "Text mode" snippets based on SRT segments */
const TextSnippets = styled.div`
  font-size: 12px;
  color: var(--text);
  line-height: 1.45;
  white-space: normal;
`;

const Snippet = styled.span`
  display: inline-block;
  padding: 1px 5px;       /* tighter */
  margin: 0 4px 4px 0;    /* tighter */
  border-radius: 8px;
  border: 1px solid ${(p) => (p.$active ? "rgba(239,68,68,0.22)" : "transparent")};
  background: ${(p) => (p.$active ? "rgba(239,68,68,0.12)" : "transparent")};
  cursor: pointer;
  user-select: none;

  &:hover {
    background: ${(p) => (p.$active ? "rgba(239,68,68,0.14)" : "rgba(0,0,0,0.04)")};
    border-color: ${(p) => (p.$active ? "rgba(239,68,68,0.26)" : "rgba(0,0,0,0.10)")};
  }
`;

const EmptyCard = styled.div`
  border: 1px solid var(--border);
  background: var(--panel);
  border-radius: 16px;
  padding: 14px;
  box-shadow: var(--shadow);
`;

const EmptyTitle = styled.div`
  font-weight: 950;
  color: var(--text);
`;

const EmptySub = styled.div`
  margin-top: 4px;
  font-size: 12px;
  color: var(--muted);
`;

/* Dropdown Menu (Portal) */

const Menu = styled.div`
  border: 1px solid var(--border);
  background: var(--panel);
  border-radius: 14px;
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.16);
  padding: 10px;
  z-index: 9999;
`;

const MenuTop = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
`;

const MenuTitle = styled.div`
  font-size: 16px;
  font-weight: 1000;
  color: var(--text);
`;

const MenuStatus = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 5px 9px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: rgba(0, 0, 0, 0.02);
`;

const MenuStatusText = styled.div`
  font-size: 11px;
  font-weight: 950;
  color: var(--text);
`;

const MenuRow = styled.div`
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
`;

const MenuAction = styled.button`
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
  font-weight: 950;
  font-size: 12px;
  padding: 9px 12px;
  cursor: pointer;

  &:hover {
    background: var(--hover);
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

const MenuDivider = styled.div`
  height: 1px;
  background: var(--border);
  margin: 10px 0;
`;

const MenuField = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
`;

const MenuLabel = styled.div`
  font-size: 11px;
  font-weight: 950;
  color: var(--muted);
`;

const MenuInput = styled.input`
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 9px 10px;
  font-size: 12px;
  font-weight: 900;
  background: rgba(0, 0, 0, 0.02);
  color: var(--text);
  outline: none;

  &:focus {
    border-color: rgba(239, 68, 68, 0.35);
    box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.08);
    background: rgba(0, 0, 0, 0.01);
  }
`;

const MenuSelect = styled.select`
  height: 38px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: #fff;
  color: var(--text);
  padding: 0 10px;
  outline: none;
  font-weight: 900;
  font-size: 12px;

  &:focus {
    border-color: rgba(239, 68, 68, 0.35);
    box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.1);
  }
`;

const MenuNote = styled.div`
  font-size: 10.5px;
  color: var(--muted);
  font-weight: 800;
  line-height: 1.35;
`;
