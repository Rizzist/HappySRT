import { useEffect, useMemo, useRef, useState } from "react";
import styled from "styled-components";
import { getLocalMedia, putLocalMedia } from "../lib/mediaStore";
import { getLocalMediaMeta, putLocalMediaMeta } from "../lib/mediaMetaStore";
import { getMediaIndex } from "../lib/mediaIndexStore";
import { useAuth } from "../contexts/AuthContext";
import { useThreads } from "../contexts/threadsContext";
import { makeScope, scopeCandidates } from "../lib/scopeKey";

function isBrowser() {
  return typeof window !== "undefined";
}

function pickPlayableUrl(media) {
  return (
    media?.playbackUrl ||
    media?.signedUrl ||
    (media?.sourceType === "url" ? media?.url : "") ||
    ""
  );
}

function pickClientFileId(media, item) {
  return (
    media?.clientFileId ||
    media?.client_file_id ||
    item?.clientFileId ||
    item?.client_file_id ||
    null
  );
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

// Cache server mp3 under a DIFFERENT key than the original upload
const SERVER_VARIANT_SUFFIX = "::server_mp3";

function serverVariantId(clientFileId) {
  const id = String(clientFileId || "");
  return id ? `${id}${SERVER_VARIANT_SUFFIX}` : null;
}

async function findLocalAcrossScopes({ scopes, threadId, clientFileId }) {
  const origId = clientFileId ? String(clientFileId) : null;
  const srvId = serverVariantId(clientFileId);

  // Original always wins
  const idsToTry = [origId, srvId].filter(Boolean);

  for (const id of idsToTry) {
    for (const sc of scopes) {
      try {
        const blobOrFile = await getLocalMedia(sc, threadId, id);

        if (blobOrFile instanceof Blob) {
          let meta = null;
          try {
            meta = await getLocalMediaMeta(sc, threadId, id);
          } catch {}

          return {
            blob: blobOrFile,
            scope: sc,
            meta,
            storedId: id,
            variant: id === origId ? "original" : "server",
          };
        }
      } catch {}
    }
  }

  return null;
}

export default function ChatMediaPlayer({ threadId, item, media, onTime, onApi, className }) {
  const { user, isAnonymous } = useAuth();
  const { requestMediaUrl, wsStatus } = useThreads();

  const scope = useMemo(() => makeScope(user, isAnonymous), [user?.$id, isAnonymous]);
  

  const chatItemId = String(item?.chatItemId || "");
  const mimeHint = String(media?.mime || "");

  const [src, setSrc] = useState("");
  const [sourceKind, setSourceKind] = useState("none"); // local | remote | none
  const [error, setError] = useState(null);
  const [loadedMime, setLoadedMime] = useState("");
  const [stage, setStage] = useState("idle"); // idle | resolving_id | waiting_ws | requesting_url | downloading

  const elRef = useRef(null);

  // Object URL lifecycle
  const objectUrlRef = useRef(null);
  const revokeObjectUrl = (url) => {
    if (!url) return;
    try {
      URL.revokeObjectURL(url);
    } catch {}
  };

  const setObjectSrcFromBlob = (blob, { mimeFallback } = {}) => {
    const nextUrl = URL.createObjectURL(blob);
    const prevUrl = objectUrlRef.current;

    objectUrlRef.current = nextUrl;
    setSrc(nextUrl);
    setSourceKind("local");

    const effectiveMime = String(blob?.type || mimeFallback || "");
    if (effectiveMime && effectiveMime !== loadedMime) setLoadedMime(effectiveMime);

    if (prevUrl && prevUrl !== nextUrl) revokeObjectUrl(prevUrl);
  };

  // clientFileId resolution is async: start undefined (pending)
  const [resolvedClientFileId, setResolvedClientFileId] = useState(undefined);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setResolvedClientFileId(undefined);

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

  // Unmount cleanup only
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) {
        revokeObjectUrl(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, []);

  // ✅ IMPORTANT:
  // Only reset loadedMime when the identity of this media changes.
  // Otherwise you'll create an effect loop that flips audio/video.
  const identityRef = useRef("");

  // Main resolver: local(original first) -> remote url -> WS request
  useEffect(() => {
    if (!isBrowser()) return;

    let cancelled = false;

    (async () => {
      const clientFileId = resolvedClientFileId;

      // media identity (what this player is meant to play)
      const identity = `${String(threadId || "")}:${String(chatItemId || "")}:${String(clientFileId || "")}`;

      if (identityRef.current !== identity) {
        identityRef.current = identity;
        // reset only on identity change
        setError(null);
        setLoadedMime("");
      } else {
        // no reset: keep loadedMime stable to prevent audio/video flicker
        setError(null);
      }

      // Build scopes to try (covers "uploaded as guest then logged in" too)
      const uniqScopes = scopeCandidates(user, isAnonymous);


      // 1) Wait for clientFileId resolution (prevents remote-first flicker)
      if (clientFileId === undefined) {
        setStage("resolving_id");
        return;
      }

      // 2) Localforage first (original wins)
      if (threadId && clientFileId) {
        const hit = await findLocalAcrossScopes({ scopes: uniqScopes, threadId, clientFileId });
        if (cancelled) return;

        if (hit?.blob) {
          const fallbackMime = String(hit?.meta?.mime || mimeHint || "");

          if (sourceKind !== "local") {
            setObjectSrcFromBlob(hit.blob, { mimeFallback: fallbackMime });
          } else {
            // If blob.type was empty previously, fill loadedMime once
            if (!loadedMime && fallbackMime) setLoadedMime(fallbackMime);
          }

          setStage("idle");
          return;
        }
      }

      // 3) If server already gave a playable URL, use it
      const remote = pickPlayableUrl(media);
      if (remote) {
        if (sourceKind !== "remote" || src !== String(remote)) {
          setSrc(String(remote));
          setSourceKind("remote");
          // optional: set mime if we have a hint (doesn't change renderKind unless you rely on it)
          if (!loadedMime && mimeHint) setLoadedMime(mimeHint);
        }
        setStage("idle");
        return;
      }

      // 4) Ask WS for media URL
      if (threadId && chatItemId && typeof requestMediaUrl === "function") {
        if (String(wsStatus || "") !== "ready") {
          setStage("waiting_ws");
          return;
        }

        setStage("requesting_url");
        const ok = requestMediaUrl({ threadId, chatItemId });
        if (!ok) setStage("waiting_ws");
        return;
      }

      setStage("idle");
    })();

    return () => {
      cancelled = true;
    };
  }, [
    scope,
    user,
    threadId,
    chatItemId,
    media,
    resolvedClientFileId,
    requestMediaUrl,
    wsStatus,
    src,
    sourceKind,
    mimeHint,
    loadedMime,
  ]);

  // When remote URL arrives: cache server mp3 under serverVariantId (never overwrite original)
  const cacheAttemptedRef = useRef(new Set());

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const remote = pickPlayableUrl(media);
      const clientFileId = resolvedClientFileId;

      if (!remote) return;
      if (!threadId) return;

      // show remote immediately only if we have nothing else
      if (!src && sourceKind !== "local") {
        setSrc(String(remote));
        setSourceKind("remote");
        if (!loadedMime && mimeHint) setLoadedMime(mimeHint);
      }

      // need id to cache
      if (!clientFileId) return;

      const serverId = serverVariantId(clientFileId);
      if (!serverId) return;

      // if already local (original or cached), don’t cache/download
      if (sourceKind === "local") return;

      const scopesToTry = [];
      if (scope) scopesToTry.push(scope);
      scopesToTry.push("guest");
      if (user?.$id) scopesToTry.push(String(user.$id));
      const uniqScopes = Array.from(new Set(scopesToTry.filter(Boolean)));

      // If original exists (or server variant exists), stop
      const existing = await findLocalAcrossScopes({ scopes: uniqScopes, threadId, clientFileId });
      if (existing?.blob) return;

      // Fetch only once per thread+serverId per session
      const cacheKey = `${String(threadId)}:${String(serverId)}`;
      if (cacheAttemptedRef.current.has(cacheKey)) return;
      cacheAttemptedRef.current.add(cacheKey);

      const sc = makeScope(user, isAnonymous) || "guest";

      setStage("downloading");
      try {
        const blob = await fetchBlob(remote);
        if (cancelled) return;

        await putLocalMedia(sc, threadId, serverId, blob);
        await putLocalMediaMeta(sc, threadId, serverId, {
          origin: "server",
          variant: "server",
          originalClientFileId: String(clientFileId),
          sourceUrl: String(remote),
          mime: String(blob?.type || "audio/mpeg"),
          bytes: Number(blob?.size || 0) || 0,
          savedAt: new Date().toISOString(),
        });

        if (cancelled) return;

        // Don’t swap src mid-play; only use local if nothing is playing/loaded yet
        if (!src && sourceKind !== "local") {
          setObjectSrcFromBlob(blob, { mimeFallback: String(blob?.type || "audio/mpeg") });
        }
      } catch {
        // caching may fail; remote playback still works
      } finally {
        if (!cancelled) setStage("idle");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [media, resolvedClientFileId, threadId, scope, user, src, sourceKind, loadedMime, mimeHint]);

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
  }, [onApi]);

  const renderKind = useMemo(() => {
    // Prefer loadedMime when local; otherwise fall back to server hint
    const m = sourceKind === "local" ? (loadedMime || mimeHint) : (mimeHint || loadedMime);
    if (isVideoLike(m)) return "video";
    if (isAudioLike(m)) return "audio";
    return "audio";
  }, [loadedMime, mimeHint, sourceKind]);

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
      : stage === "resolving_id"
      ? "Resolving…"
      : stage === "waiting_ws"
      ? "Waiting…"
      : stage === "requesting_url"
      ? "Fetching URL…"
      : "No media";

  const emptyText =
    stage === "resolving_id"
      ? "Resolving local media…"
      : stage === "waiting_ws"
      ? "Waiting for server connection…"
      : stage === "requesting_url"
      ? "Requesting media URL…"
      : "Media not available to play.";

  return (
    <Wrap className={className}>
      <TopRow>
        <Badges>
          <Badge $kind={sourceKind}>{badgeText}</Badge>
          {loadedMime || mimeHint ? <Meta>{loadedMime || mimeHint}</Meta> : null}
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
  background: rgba(0, 0, 0, 0.02);
  border-radius: 14px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;

  @media(max-width: 786px){
    padding: 6px;
    gap: 4px;
  }
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
    @media(max-width: 786px) {
    font-size: 10px;
  }
`;

const Meta = styled.span`
  font-size: 11px;
  color: var(--muted);
  font-weight: 800;
    @media(max-width: 786px) {
    font-size: 10px;
  }
`;

const Audio = styled.audio`
  width: 100%;
    @media(max-width: 786px) {
    max-height: 32px;
  }
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
