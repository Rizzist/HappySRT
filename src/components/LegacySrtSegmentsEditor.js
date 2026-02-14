// components/LegacySrtSegmentsEditor.js
import React, { forwardRef, useEffect, useMemo, useRef, useState, useImperativeHandle } from "react";
import styled, { css, keyframes } from "styled-components";

function normalizeWhitespace(t) {
  return String(t || "").replace(/\s+/g, " ").trim();
}

function pad2(n) {
  return String(n).padStart(2, "0");
}
function pad3(n) {
  return String(n).padStart(3, "0");
}

function secondsToTimecode(sec) {
  const s = Math.max(0, Number(sec || 0));
  const totalMs = Math.round(s * 1000);

  const hh = Math.floor(totalMs / 3600000);
  const rem1 = totalMs % 3600000;
  const mm = Math.floor(rem1 / 60000);
  const rem2 = rem1 % 60000;
  const ss = Math.floor(rem2 / 1000);
  const ms = rem2 % 1000;

  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)},${pad3(ms)}`;
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

function timeToMs(t) {
  const s = String(t || "").trim();
  const m = s.match(/^(\d+):(\d+):(\d+),(\d+)$/);
  if (!m) return null;
  const hh = Number(m[1] || 0);
  const mm = Number(m[2] || 0);
  const ss = Number(m[3] || 0);
  const ms = Number(m[4] || 0);
  if (![hh, mm, ss, ms].every((x) => Number.isFinite(x))) return null;
  return (hh * 3600 + mm * 60 + ss) * 1000 + ms;
}

function msToTime(msTotal) {
  let ms = Number(msTotal || 0);
  if (!Number.isFinite(ms) || ms < 0) ms = 0;

  const hours = Math.floor(ms / 3600000);
  ms = ms % 3600000;
  const mins = Math.floor(ms / 60000);
  ms = ms % 60000;
  const secs = Math.floor(ms / 1000);
  const milli = ms % 1000;

  return `${pad2(hours)}:${pad2(mins)}:${pad2(secs)},${pad3(milli)}`;
}

function isActiveAtTime(item, currentTimeSec) {
  const s = parseTimecodeToSeconds(item?.start);
  const e = parseTimecodeToSeconds(item?.end);
  if (s == null || e == null) return false;
  const t = Number(currentTimeSec || 0);
  return t >= s && t < e;
}

function toItemsFromSegments(segments) {
  const segs = Array.isArray(segments) ? segments : [];
  const out = segs
    .map((seg, i) => {
      const start = Number(seg?.start || 0);
      const end = Number(seg?.end || 0);
      const text = String(seg?.text || "");
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
      return {
        index: String(i + 1).padStart(3, "0"),
        start: secondsToTimecode(start),
        end: secondsToTimecode(end),
        text,
        _flash: false,
      };
    })
    .filter(Boolean);

  return out;
}

function reindex(items) {
  return (Array.isArray(items) ? items : []).map((it, i) => ({
    ...it,
    index: String(i + 1).padStart(3, "0"),
  }));
}

function buildSrtFromItems(items) {
  const rows = Array.isArray(items) ? items : [];
  const blocks = rows
    .map((it, i) => {
      const idx = String(i + 1);
      const start = String(it?.start || "").trim();
      const end = String(it?.end || "").trim();
      const text = String(it?.text || "").trim();
      return `${idx}\n${start} --> ${end}\n${text}`;
    })
    .join("\n\n");
  return blocks.trim() ? blocks.trim() + "\n" : "";
}

function itemsToSegments(items) {
  const rows = Array.isArray(items) ? items : [];
  const out = [];

  for (const it of rows) {
    const s = parseTimecodeToSeconds(it?.start);
    const e = parseTimecodeToSeconds(it?.end);
    if (s == null || e == null) continue;
    const start = Math.max(0, s);
    const end = Math.max(start, e);
    out.push({ start, end, text: normalizeWhitespace(it?.text || "") });
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

function keyOfItems(items) {
  return (Array.isArray(items) ? items : [])
    .map((it) => `${String(it?.start || "")}|${String(it?.end || "")}|${normalizeWhitespace(it?.text || "")}`)
    .join("§");
}

const fadeIn = keyframes`
  0% { background-color: #fc0; }
  100% { background-color: #eee; }
`;

const LegacySrtSegmentsEditor = forwardRef(function LegacySrtSegmentsEditor(
  { segments, currentTime = 0, onSeek, onSave, onMeta, disabled = false, maxHeight = 360 },
  ref
) {
  const baseItems = useMemo(() => reindex(toItemsFromSegments(segments)), [segments]);
  const baseKey = useMemo(() => keyOfItems(baseItems), [baseItems]);

  const [items, setItems] = useState(baseItems);
  const [editingId, setEditingId] = useState(null);

  // baseline snapshot for dirty tracking
  const baselineKeyRef = useRef(baseKey);

  const listRef = useRef(null);

  const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";

  const focusEditableById = (domId) => {
    if (!isBrowser) return;
    setTimeout(() => {
      const el = document.getElementById(domId);
      if (!el) return;
      try {
        el.focus();
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(range);
        }
      } catch (e) {
        // ignore
      }
    }, 0);
  };

  // sync when external segments change (but don't clobber unsaved edits unless locked)
  useEffect(() => {
    if (disabled) {
      setItems(baseItems);
      baselineKeyRef.current = baseKey;
      setEditingId(null);
      return;
    }

    const isDirty = keyOfItems(items) !== baselineKeyRef.current;
    if (!isDirty) {
      setItems(baseItems);
      baselineKeyRef.current = baseKey;
      setEditingId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseKey, disabled]);

  const activeIndex = useMemo(() => {
    for (let i = 0; i < items.length; i++) {
      if (isActiveAtTime(items[i], currentTime)) return i;
    }
    return -1;
  }, [items, currentTime]);

  useEffect(() => {
    if (!listRef.current) return;
    if (activeIndex < 0) return;
    const el = listRef.current.querySelector(`#srt-item-${activeIndex}`);
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [activeIndex]);

  const computeMeta = (nextItems) => {
    const dirty = keyOfItems(nextItems) !== baselineKeyRef.current;
    const hasBadTime = (Array.isArray(nextItems) ? nextItems : []).some((it) => {
      const s = timeToMs(it?.start);
      const e = timeToMs(it?.end);
      return s == null || e == null || e < s;
    });
    return { dirty, hasBadTime };
  };

  const pushMeta = (nextItems) => {
    if (typeof onMeta !== "function") return;
    onMeta(computeMeta(nextItems));
  };

  useEffect(() => {
    pushMeta(items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  function fixLineMinMax(next, i) {
    const startMs = timeToMs(next?.[i]?.start);
    const endMs = timeToMs(next?.[i]?.end);
    if (startMs == null || endMs == null) return next;
    if (endMs < startMs) next[i].end = next[i].start;
    return next;
  }

  function fixOverlaps(next, i, prop) {
    const thisStart = timeToMs(next?.[i]?.start);
    const thisEnd = timeToMs(next?.[i]?.end);
    if (thisStart == null || thisEnd == null) return next;

    if (prop === "end") {
      const ni = i + 1;
      if (ni < next.length) {
        const nextStart = timeToMs(next?.[ni]?.start);
        const nextEnd = timeToMs(next?.[ni]?.end);
        if (nextStart != null && thisEnd > nextStart) {
          next[ni].start = msToTime(thisEnd);
          if (nextEnd != null && thisEnd > nextEnd) next[ni].end = msToTime(thisEnd);
        }
      }
    }

    if (prop === "start") {
      const pi = i - 1;
      if (pi >= 0) {
        const prevEnd = timeToMs(next?.[pi]?.end);
        if (prevEnd != null && thisStart < prevEnd) {
          next[pi].end = msToTime(thisStart);
          next = fixLineMinMax(next, pi);
        }
      }
    }

    return next;
  }

  const patchItem = (idx, patch, propForOverlap) => {
    if (disabled) return;

    setItems((prev) => {
      let next = prev.map((x, i) => (i === idx ? { ...x, ...patch } : x));
      next = reindex(next);
      next = fixLineMinMax(next, idx);
      if (propForOverlap) next = fixOverlaps(next, idx, propForOverlap);
      return next;
    });
  };

  const handleTimeKeyDown = (e) => {
    if (String(e?.key || "") === "Enter") {
      e.preventDefault();
      e.currentTarget.blur();
    }
  };

  const handleRowSeek = (index) => {
    if (disabled) return;
    if (typeof onSeek !== "function") return;
    const s = parseTimecodeToSeconds(items?.[index]?.start);
    if (s == null) return;
    onSeek(s);
  };

  const handleDelete = (index) => {
    if (disabled) return;
    setEditingId(null);
    let next = items.filter((_, idx) => idx !== index);
    next = reindex(next);
    setItems(next);
  };

  const handleAddAfter = (index) => {
    if (disabled) return;
    setEditingId(null);
    const cur = items[index];
    const start = String(cur?.end || "00:00:00,000");
    const end = String(cur?.end || "00:00:00,000");
    const newItem = { index: "", start, end, text: "New SRT Item Text", _flash: true };

    let next = [...items.slice(0, index + 1), newItem, ...items.slice(index + 1)];
    next = reindex(next);
    setItems(next);

    setTimeout(() => {
      setItems((p) => p.map((x, i) => (i === index + 1 ? { ...x, _flash: false } : x)));
    }, 550);
  };

  const handleAddBefore = (index) => {
    if (disabled) return;
    setEditingId(null);
    const cur = items[Math.max(0, index)];
    const start = String(cur?.start || "00:00:00,000");
    const end = String(cur?.start || "00:00:00,000");
    const newItem = { index: "", start, end, text: "New SRT Item Text", _flash: true };

    let next = [...items.slice(0, Math.max(0, index)), newItem, ...items.slice(Math.max(0, index))];
    next = reindex(next);
    setItems(next);

    setTimeout(() => {
      setItems((p) => p.map((x, i) => (i === index ? { ...x, _flash: false } : x)));
    }, 550);
  };

  const handleMerge = (index) => {
    if (disabled) return;
    if (index < 0 || index >= items.length - 1) return;
    setEditingId(null);

    const a = items[index];
    const b = items[index + 1];

    const merged = {
      ...a,
      start: a.start,
      end: b.end,
      text: `${String(a.text || "").trim()} ${String(b.text || "").trim()}`.trim(),
      _flash: true,
    };

    let next = [...items];
    next.splice(index, 2, merged);
    next = reindex(next);
    setItems(next);

    setTimeout(() => {
      setItems((p) => p.map((x, i) => (i === index ? { ...x, _flash: false } : x)));
    }, 550);
  };

  const addFirst = () => {
    if (disabled) return;
    const next = reindex([
      {
        index: "001",
        start: "00:00:00,000",
        end: "00:00:03,000",
        text: "Begin Transcription Here. Double Click to Edit Me!",
        _flash: true,
      },
    ]);
    setItems(next);
    setTimeout(() => {
      setItems((p) => p.map((x, i) => (i === 0 ? { ...x, _flash: false } : x)));
    }, 550);
  };

  const reset = () => {
    if (disabled) return;
    setItems(baseItems);
    baselineKeyRef.current = baseKey;
    setEditingId(null);
    if (typeof onMeta === "function") onMeta({ dirty: false, hasBadTime: false });
  };

  const save = () => {
    if (disabled) return;
    if (typeof onSave !== "function") return;

    const meta = computeMeta(items);
    if (meta.hasBadTime) return;

    const segs = itemsToSegments(items);
    const transcriptSrt = buildSrtFromItems(items);
    const transcriptText = segmentsToPlainText(segs);

    baselineKeyRef.current = keyOfItems(items);
    setEditingId(null);

    if (typeof onMeta === "function") onMeta({ dirty: false, hasBadTime: false });
    onSave({ transcriptSrt, transcriptText });
  };

  useImperativeHandle(ref, () => ({
    reset,
    save,
    getMeta: () => computeMeta(items),
  }));

  if (!items.length) {
    return (
      <SRTEditorWrapper ref={listRef} style={{ maxHeight }}>
        {!disabled ? (
          <EmptyState>
            <AddFirstSRTButton onClick={addFirst}>[+] Add SRT Item</AddFirstSRTButton>
            <EmptyTip>
              <ol style={{ margin: 0, paddingLeft: 18 }}>
                <li>Double click times/text to edit</li>
                <li>Click a row to seek</li>
                <li>Use Save in header</li>
              </ol>
            </EmptyTip>
          </EmptyState>
        ) : (
          <EmptyState>
            <div style={{ fontWeight: 600, color: "#333" }}>Building SRT…</div>
          </EmptyState>
        )}
      </SRTEditorWrapper>
    );
  }

  return (
    <SRTEditorWrapper ref={listRef} style={{ maxHeight }}>
      {items.map((item, i) => {
        const highlighted = i === activeIndex;

        const startDomId = `srt-start-${i}`;
        const endDomId = `srt-end-${i}`;
        const textDomId = `srt-text-${i}`;

        const startOk = parseTimecodeToSeconds(item.start) != null;
        const endOk = parseTimecodeToSeconds(item.end) != null;

        return (
          <SRTItem
            key={`${item.index}-${item.start}-${item.end}-${i}`}
            id={`srt-item-${i}`}
            newItem={!!item._flash}
            isHighlighted={highlighted}
            $disabled={disabled}
            onClick={() => handleRowSeek(i)}
            title={disabled ? "Transcription is running" : "Click row to seek • Double click fields to edit"}
          >
            <Timestamp>
              {/* Index */}
              <span>{item.index}</span>

              {/* Start Time */}
              <span
                id={startDomId}
                data-bad={startOk ? "0" : "1"}
                suppressContentEditableWarning
                contentEditable={!disabled && editingId === `start-${i}`}
                onDoubleClick={(e) => {
                  if (disabled) return;
                  e.stopPropagation();
                  setEditingId(`start-${i}`);
                  focusEditableById(startDomId);
                }}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={handleTimeKeyDown}
                onBlur={(e) => {
                  if (disabled) return;
                  const v = String(e?.currentTarget?.innerText || "").trim();
                  patchItem(i, { start: v }, "start");
                  setEditingId(null);
                }}
              >
                {item.start}
              </span>

              {/* End Time */}
              <span
                id={endDomId}
                data-bad={endOk ? "0" : "1"}
                suppressContentEditableWarning
                contentEditable={!disabled && editingId === `end-${i}`}
                onDoubleClick={(e) => {
                  if (disabled) return;
                  e.stopPropagation();
                  setEditingId(`end-${i}`);
                  focusEditableById(endDomId);
                }}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={handleTimeKeyDown}
                onBlur={(e) => {
                  if (disabled) return;
                  const v = String(e?.currentTarget?.innerText || "").trim();
                  patchItem(i, { end: v }, "end");
                  setEditingId(null);
                }}
              >
                {item.end}
              </span>
            </Timestamp>

            {/* Subtitle Text */}
            <SRTText
              id={textDomId}
              suppressContentEditableWarning
              contentEditable={!disabled && editingId === `text-${i}`}
              onDoubleClick={(e) => {
                if (disabled) return;
                e.stopPropagation();
                setEditingId(`text-${i}`);
                focusEditableById(textDomId);
              }}
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => {
                if (disabled) return;
                const v = String(e?.currentTarget?.innerText || "");
                patchItem(i, { text: v }, null);
                setEditingId(null);
              }}
            >
              {item.text}
            </SRTText>

            {/* Hover buttons (old vibe) */}
            <AddButton
              className="add-btn"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleAddBefore(i);
              }}
              disabled={disabled}
              title="Add before"
            >
              Add
            </AddButton>

            <AddButton2
              className="add2-btn"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleAddAfter(i);
              }}
              disabled={disabled}
              title="Add after"
            >
              Add
            </AddButton2>

            <DeleteButton
              className="delete-btn"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleDelete(i);
              }}
              disabled={disabled}
              title="Delete"
            >
              Delete
            </DeleteButton>

            <MergeButton
              className="merge-btn"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleMerge(i);
              }}
              disabled={disabled || i >= items.length - 1}
              title="Merge"
            >
              Merge
            </MergeButton>
          </SRTItem>
        );
      })}
    </SRTEditorWrapper>
  );
});

export default LegacySrtSegmentsEditor;

/* -------------------- styles (restored legacy look) -------------------- */

const SRTEditorWrapper = styled.div`
  width: 100%;
  background-color: #f7f9fc;
  border-radius: 8px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 8px;
  min-height: 240px;
`;

const EmptyState = styled.div`
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: center;
  justify-content: center;
  padding: 26px 10px;
`;

const AddFirstSRTButton = styled.div`
  background-color: #1074c4;
  padding: 8px;
  border-radius: 20px;
  border-color: white;
  max-width: 370px;
  min-width: 320px;
  color: #eee;
  font-size: 1rem;
  cursor: pointer;
  margin-top: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 500;
  &:hover {
    background-color: #0063a1;
  }
`;

const EmptyTip = styled.div`
  width: 100%;
  max-width: 520px;
  background: rgba(255, 255, 255, 0.75);
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 10px;
  padding: 12px;
  color: #222;
  font-size: 0.95rem;
`;

const SRTItem = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 6px;

  /* small gutter so hover buttons never cover index/time */
  padding: 5px 5px 8px 10px;

  background-color: ${(props) => (props.isHighlighted ? "rgba(240, 240, 80, 0.5)" : "#eee")};
  border-radius: 8px;
  position: relative;
  width: 100%;
  cursor: ${(p) => (p.$disabled ? "default" : "pointer")};
  animation: ${(props) => (props.newItem ? css`${fadeIn} 0.5s ease-in-out` : "none")};

  &:hover button.delete-btn {
    display: block;
  }
  &:hover button.add-btn,
  &:hover button.add2-btn {
    display: block;
  }
  &:hover button.merge-btn {
    display: block;
  }
`;

const Timestamp = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 2px;
  font-size: 0.9em;
  text-indent: 15px;
  position: relative;
  user-select: none;

  & span:nth-child(1) {
    font-size: 1em;
    color: #000;
    font-weight: 400;
    margin-left: -18px;
    margin-top: -1px;
  }

  & span:nth-child(2),
  & span:nth-child(3) {
    font-size: 0.8em;
    color: #777;
    font-weight: 700;
    margin-left: 10px;
    position: relative;
  }

  /* editing outline */
  & span[contenteditable="true"] {
    user-select: text;
    outline: 2px solid rgba(16, 116, 196, 0.35);
    border-radius: 6px;
    padding: 2px 6px;
    background: rgba(255, 255, 255, 0.8);
    margin-left: 6px;
    text-indent: 0;
  }

  /* bad time format */
  & span[data-bad="1"] {
    color: #b42318;
  }
`;

const SRTText = styled.div`
  flex: 3;
  padding: 5px;
  border-radius: 4px;
  font-size: 0.8rem;
  text-align: center;
  margin: auto auto;
  cursor: text;
  user-select: text;
  white-space: pre-wrap;

  &[contenteditable="true"] {
    outline: 2px solid rgba(16, 116, 196, 0.35);
    background: rgba(255, 255, 255, 0.8);
    border-radius: 6px;
  }
`;

const DeleteButton = styled.button`
  display: none;
  position: absolute;
  top: 0;
  left: 0;
  background-color: #eeaa99;
  padding: 1px 4px;
  margin-left: 35px;
  margin-top: 8px;
  font-size: 0.6rem;
  border: 0;
  border-radius: 4px;

  &.delete-btn {
    cursor: pointer;
  }

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
`;

const AddButton = styled.button`
  display: none;
  position: absolute;
  top: 0;
  left: 0;
  background-color: #66ca66;
  padding: 2px 6px;
  margin-top: 25px;
  margin-left: 4px;
  font-size: 0.6rem;
  border: 0;
  border-radius: 4px;

  &.add-btn {
    cursor: pointer;
  }

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
`;

const AddButton2 = styled.button`
  display: none;
  position: absolute;
  top: 0;
  left: 0;
  background-color: #66ca66;
  padding: 2px 6px;
  margin-top: 43px;
  margin-left: 4px;
  font-size: 0.6rem;
  border: 0;
  border-radius: 4px;

  &.add2-btn {
    cursor: pointer;
  }

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
`;

const MergeButton = styled.button`
  display: none;
  position: absolute;
  top: 0;
  left: 0;
  background-color: #f0b400;
  padding: 0px 6px;
  margin-top: 42px;
  margin-left: 120px;
  font-size: 0.6rem;
  border: 0;
  border-radius: 4px;

  &.merge-btn {
    cursor: pointer;
  }

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
`;
