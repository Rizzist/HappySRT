import { useEffect, useMemo, useRef, useState } from "react";
import styled from "styled-components";
import { getLocalMedia, putLocalMedia } from "../lib/mediaStore";
import { getMediaIndex } from "../lib/mediaIndexStore";
import { useAuth } from "../contexts/AuthContext";
import { useThreads } from "../contexts/threadsContext";

function isBrowser() {
  return typeof window !== "undefined";
}

function pickPlayableUrl(media) {
  return media?.playbackUrl || media?.signedUrl || (media?.sourceType === "url" ? media?.url : "") || "";
}

function pickClientFileId(media, item) {
  return media?.clientFileId || media?.client_file_id || item?.clientFileId || item?.client_file_id || null;
}

function isVideoLike(mime) {
  return String(mime || "").startsWith("video/");
}

function isAudioLike(mime) {
  return String(mime || "").startsWith("audio/");
}

async function fetchBlob(url) {
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) throw new Error("Failed to download media");
  return res.blob();
}

export default function ChatMediaPlayer({ threadId, item, media, onTime, onApi, className }) {
  const { user, isAnonymous } = useAuth();
  const { requestMediaUrl, wsStatus } = useThreads();

  const scope = useMemo(() => {
    if (!user) return null;
    return isAnonymous ? "guest" : user.$id;
  }, [user, isAnonymous]);

  const chatItemId = String(item?.chatItemId || "");
  const mimeHint = String(media?.mime || "");

  const [src, setSrc] = useState("");
  const [sourceKind, setSourceKind] = useState("none"); // local | remote | none
  const [error, setError] = useState(null);
  const [loadedMime, setLoadedMime] = useState("");

  // stages: idle | waiting_ws | requesting_url | downloading
  const [stage, setStage] = useState("idle");

  const elRef = useRef(null);
  const objectUrlRef = useRef(null);

  // important: only mark requested if the WS send actually succeeded
  const requestedRemoteRef = useRef(false);

  const [resolvedClientFileId, setResolvedClientFileId] = useState(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const direct = pickClientFileId(media, item);
      if (direct) {
        if (!cancelled) setResolvedClientFileId(String(direct));
        return;
      }

      if (scope && threadId && chatItemId) {
        try {
          const idx = await getMediaIndex(scope, threadId, chatItemId);
          if (idx?.clientFileId && !cancelled) {
            setResolvedClientFileId(String(idx.clientFileId));
            return;
          }
        } catch {}
      }

      if (!cancelled) setResolvedClientFileId(null);
    })();

    return () => {
      cancelled = true;
    };
  }, [scope, threadId, chatItemId, media, item]);

  async function cleanupObjectUrl() {
    if (objectUrlRef.current) {
      try {
        URL.revokeObjectURL(objectUrlRef.current);
      } catch {}
      objectUrlRef.current = null;
    }
  }

  // Main resolver: local -> remote existing -> request via WS
  useEffect(() => {
    if (!isBrowser()) return;

    let cancelled = false;

    (async () => {
      setError(null);
      setLoadedMime("");

      await cleanupObjectUrl();

      // 1) Try localforage (if we have a clientFileId)
      const clientFileId = resolvedClientFileId;
      if (threadId && clientFileId) {
        const scopesToTry = [];
        if (scope) scopesToTry.push(scope);
        scopesToTry.push("guest");
        if (user?.$id) scopesToTry.push(String(user.$id));

        const uniq = Array.from(new Set(scopesToTry.filter(Boolean)));

        for (const sc of uniq) {
          try {
            const blobOrFile = await getLocalMedia(sc, threadId, clientFileId);
            if (cancelled) return;

            if (blobOrFile instanceof Blob) {
              const url = URL.createObjectURL(blobOrFile);
              objectUrlRef.current = url;
              setSrc(url);
              setSourceKind("local");
              setLoadedMime(String(blobOrFile.type || ""));
              setStage("idle");
              return;
            }
          } catch {}
        }
      }

      // 2) Remote URL already present (maybe pushed by server)
      const remote = pickPlayableUrl(media);
      if (remote) {
        setSrc(String(remote));
        setSourceKind("remote");
        setStage("idle");
        return;
      }

      // 3) Need to ask WS for media URL — but only when WS is ready
      // Reset "requested" when inputs change
      requestedRemoteRef.current = false;

      if (threadId && chatItemId && typeof requestMediaUrl === "function") {
        if (String(wsStatus || "") !== "ready") {
          setStage("waiting_ws");
        } else {
          setStage("requesting_url");
          const ok = requestMediaUrl({ threadId, chatItemId });
          if (ok) {
            requestedRemoteRef.current = true;
          } else {
            // WS send failed: do NOT mark as requested; we’ll retry when wsStatus changes
            requestedRemoteRef.current = false;
            setStage("waiting_ws");
          }
        }
      } else {
        setStage("idle");
      }

      setSrc("");
      setSourceKind("none");
    })();

    return () => {
      cancelled = true;
      cleanupObjectUrl();
    };
  }, [scope, user, threadId, chatItemId, media, resolvedClientFileId, requestMediaUrl, wsStatus]);

  // Retry requesting URL when WS becomes ready (fixes the “asked too early” bug)
  useEffect(() => {
    const remote = pickPlayableUrl(media);
    if (remote) return; // already have it
    if (src) return;
    if (!threadId || !chatItemId) return;
    if (typeof requestMediaUrl !== "function") return;

    if (String(wsStatus || "") !== "ready") return;
    if (requestedRemoteRef.current) return;

    setStage("requesting_url");
    const ok = requestMediaUrl({ threadId, chatItemId });
    if (ok) requestedRemoteRef.current = true;
    else setStage("waiting_ws");
  }, [wsStatus, threadId, chatItemId, requestMediaUrl, media, src]);

  // When remote URL arrives later, optionally download+cache to localforage.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const remote = pickPlayableUrl(media);
      const clientFileId = resolvedClientFileId;

      if (!remote) return;

      // ensure UI uses remote immediately
      if (sourceKind !== "local") {
        setSrc(String(remote));
        setSourceKind("remote");
      }

      // only cache if we have a clientFileId (local indexing available)
      if (!clientFileId || !threadId) return;

      // if already local, don’t download
      if (sourceKind === "local") return;

      // only cache if we have a scope
      const sc = scope || "guest";

      try {
        const existing = await getLocalMedia(sc, threadId, clientFileId);
        if (existing instanceof Blob) return;
      } catch {}

      // download + cache
      setStage("downloading");
      try {
        const blob = await fetchBlob(remote);
        if (cancelled) return;

        await putLocalMedia(sc, threadId, clientFileId, blob);
        if (cancelled) return;

        await cleanupObjectUrl();
        const url = URL.createObjectURL(blob);
        objectUrlRef.current = url;

        setSrc(url);
        setSourceKind("local");
        setLoadedMime(String(blob.type || ""));
      } catch {
        // CORS/Range/etc can break caching — but remote playback still works.
      } finally {
        if (!cancelled) setStage("idle");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [media, resolvedClientFileId, threadId, scope, sourceKind]);

  // Expose API (seek/play)
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;

    const api = {
      el,
      play: () => {
        try {
          return el.play();
        } catch {}
      },
      pause: () => {
        try {
          el.pause();
        } catch {}
      },
      seek: (t) => {
        const x = Number(t);
        if (!Number.isFinite(x)) return;
        try {
          el.currentTime = Math.max(0, x);
        } catch {}
      },
      getTime: () => {
        try {
          return Number(el.currentTime || 0);
        } catch {
          return 0;
        }
      },
    };

    if (typeof onApi === "function") onApi(api);
    return () => {
      if (typeof onApi === "function") onApi(null);
    };
  }, [onApi, src]);

  const renderKind = useMemo(() => {
    const m = loadedMime || mimeHint;
    if (isVideoLike(m)) return "video";
    if (isAudioLike(m)) return "audio";
    return "audio";
  }, [loadedMime, mimeHint]);

  const onTimeUpdate = () => {
    const el = elRef.current;
    if (!el) return;
    const t = Number(el.currentTime || 0);
    if (typeof onTime === "function") onTime(t);
  };

  const badgeText =
    sourceKind === "local"
      ? "Local"
      : sourceKind === "remote"
      ? stage === "downloading"
        ? "Downloading…"
        : "Remote"
      : stage === "waiting_ws"
      ? "Waiting…"
      : stage === "requesting_url"
      ? "Fetching URL…"
      : "No media";

  const emptyText =
    stage === "waiting_ws"
      ? "Waiting for server connection…"
      : stage === "requesting_url"
      ? "Requesting media URL…"
      : "Media not available to play.";

  return (
    <Wrap className={className}>
      <TopRow>
        <Badges>
          <Badge $kind={sourceKind}>{badgeText}</Badge>
          {(loadedMime || mimeHint) ? <Meta>{loadedMime || mimeHint}</Meta> : null}
        </Badges>
      </TopRow>

      {!src ? (
        <Empty>
          <div>{emptyText}</div>
          {chatItemId ? <Small>chatItemId: {String(chatItemId)}</Small> : null}
        </Empty>
      ) : renderKind === "video" ? (
        <Video
          ref={elRef}
          src={src}
          controls
          preload="metadata"
          onTimeUpdate={onTimeUpdate}
          onError={() => setError("Video failed to load (CORS/URL?)")}
        />
      ) : (
        <Audio
          ref={elRef}
          src={src}
          controls
          preload="metadata"
          onTimeUpdate={onTimeUpdate}
          onError={() => setError("Audio failed to load (CORS/URL?)")}
        />
      )}

      {error ? <Err>{error}</Err> : null}
    </Wrap>
  );
}

const Wrap = styled.div`
  border: 1px solid var(--border);
  background: rgba(0,0,0,0.02);
  border-radius: 14px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

const TopRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
`;

const Badges = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
`;

const Badge = styled.span`
  font-size: 11px;
  font-weight: 950;
  padding: 6px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: ${(p) =>
    p.$kind === "local"
      ? "rgba(46, 204, 113, 0.12)"
      : p.$kind === "remote"
      ? "rgba(52, 152, 219, 0.12)"
      : "rgba(0,0,0,0.06)"};
`;

const Meta = styled.span`
  font-size: 11px;
  color: var(--muted);
  font-weight: 800;
`;

const Audio = styled.audio`
  width: 100%;
`;

const Video = styled.video`
  width: 100%;
  max-height: 320px;
  border-radius: 12px;
  background: #000;
`;

const Empty = styled.div`
  padding: 14px;
  border: 1px dashed var(--border);
  border-radius: 12px;
  color: var(--muted);
  font-size: 12px;
`;

const Small = styled.div`
  margin-top: 6px;
  font-size: 11px;
  opacity: 0.9;
`;

const Err = styled.div`
  font-size: 11px;
  color: var(--accent);
  font-weight: 900;
`;
