import { useMemo } from "react";
import styled from "styled-components";

function normalizeWhitespace(t) {
  return String(t || "").replace(/\s+/g, " ").trim();
}

function getKeyCI(obj, lang) {
  const o = obj && typeof obj === "object" ? obj : null;
  const want = String(lang || "").trim().toLowerCase();
  if (!o || !want) return null;

  if (Object.prototype.hasOwnProperty.call(o, lang)) return lang;

  for (const k of Object.keys(o)) {
    if (String(k).trim().toLowerCase() === want) return k;
  }
  return null;
}

function getByLangCI(map, lang) {
  const key = getKeyCI(map, lang);
  return key ? map[key] : null;
}

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

  out.sort((a, b) => a.start - b.start || a.end - b.end);
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

function fmtClock(seconds) {
  const s = Math.max(0, Number(seconds || 0));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const pad = (n) => String(n).padStart(2, "0");
  if (hh > 0) return `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
  return `${pad(mm)}:${pad(ss)}`;
}

function isActiveAtTime(seg, t) {
  const s = Number(seg?.start || 0);
  const e = Number(seg?.end || 0);
  const time = Number(t || 0);
  return time >= s && time < e;
}

function getLiveStreamFor(stepVal, lang) {
  if (!stepVal) return "";
  if (Array.isArray(stepVal)) return stepVal.join("");
  if (stepVal && typeof stepVal === "object" && lang) {
    const hit = getByLangCI(stepVal, lang);
    return Array.isArray(hit) ? hit.join("") : "";
  }
  return "";
}

function extractPersisted(results, lang) {
  const trMap = results?.translations && typeof results.translations === "object" ? results.translations : null;
  const payload = trMap ? getByLangCI(trMap, lang) : null;

  let srt = "";
  let segments = [];
  let text = "";

  if (typeof payload === "string") {
    srt = payload;
  } else if (Array.isArray(payload)) {
    // ✅ persisted as segments array
    segments = payload;
  } else if (payload && typeof payload === "object") {
    srt = String(payload?.srt || payload?.translationSrt || "");
    segments =
      (Array.isArray(payload?.segments) && payload.segments) ||
      (Array.isArray(payload?.translationSegments) && payload.translationSegments) ||
      [];
    text = String(payload?.text || payload?.translationText || "");
  }

  srt = String(srt || "").trim();

  if (!segments.length && srt) segments = srtToSegments(srt);
  if (!text && segments.length) text = segmentsToPlainText(segments);

  return { srt, segments, text };
}


function extractLiveSegments(liveOne, lang) {
  const segVal = liveOne?.segments?.translate;
  if (!segVal) return [];
  if (Array.isArray(segVal)) return segVal;
  if (segVal && typeof segVal === "object") {
    const hit = getByLangCI(segVal, lang);
    return Array.isArray(hit) ? hit : [];
  }
  return [];
}

export default function TranslatedSrtViewer({
  lang,
  view = "srt",
  results,
  liveOne,
  translateStatus,
  currentTime,
  onSeek,
  maxHeight = 360,
}) {
  const l = String(lang || "").trim();

  const persisted = useMemo(() => extractPersisted(results, l), [results, l]);

  const liveSegs = useMemo(() => extractLiveSegments(liveOne, l), [liveOne, l]);
  const liveStream = useMemo(() => getLiveStreamFor(liveOne?.stream?.translate, l), [liveOne, l]);

  // status is optional; viewer should still render persisted output if present
  const state = String(getByLangCI(translateStatus?.byLang, l)?.state || translateStatus?.state || "")
    .toLowerCase()
    .trim();

  const segments = persisted.segments.length ? persisted.segments : liveSegs;
  const text = persisted.text || (segments.length ? segmentsToPlainText(segments) : "");
  const srt = persisted.srt || "";

  if (!l) return <Box $maxH={maxHeight}><Muted>Select a language to view output.</Muted></Box>;

  // Outer timeline already gates to “completed + exists”, but keep this resilient:
  if (!srt && !text && !liveStream) {
    return (
      <Box $maxH={maxHeight}>
        <Muted>{state === "running" ? "Translating…" : "No translated output yet."}</Muted>
      </Box>
    );
  }

  if (String(view) === "text") {
    return (
      <Box $maxH={maxHeight}>
        {segments.length ? (
          <Snippets aria-label="Translated text (clickable)">
            {segments.map((seg, idx) => {
              const txt = normalizeWhitespace(seg?.text || "");
              if (!txt) return null;
              const active = isActiveAtTime(seg, currentTime);
              return (
                <Snippet
                  key={`${Number(seg?.start || 0).toFixed(3)}|${Number(seg?.end || 0).toFixed(3)}|${idx}`}
                  $active={active}
                  title={`${fmtClock(seg?.start)} → ${fmtClock(seg?.end)} (click to seek)`}
                  onClick={() => onSeek && onSeek(Number(seg?.start || 0))}
                >
                  {txt}
                </Snippet>
              );
            })}
          </Snippets>
        ) : (
          <Pre>{text || liveStream}</Pre>
        )}
      </Box>
    );
  }

  // view === "srt"
  return (
    <Box $maxH={maxHeight}>
      <Pre>{srt || liveStream}</Pre>
    </Box>
  );
}

const Box = styled.div`
  max-height: ${(p) => `${Number(p.$maxH || 360)}px`};
  overflow: auto;
`;

const Pre = styled.pre`
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  color: var(--text);
  line-height: 1.45;
`;

const Muted = styled.div`
  font-size: 12px;
  font-weight: 800;
  color: var(--muted);
`;

const Snippets = styled.div`
  font-size: 14px;
  color: var(--text);
  line-height: 1.6;
  display: flex;
  flex-wrap: wrap;
  gap: 1px 2px;
`;

const Snippet = styled.span`
  display: inline-flex;
  align-items: center;
  margin: 0;
  padding: 0px 2px;
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
