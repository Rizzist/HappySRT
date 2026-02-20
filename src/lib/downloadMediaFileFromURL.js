function guessMimeFromUrl(url) {
  const u = String(url || "");
  const path = u.split("?")[0].split("#")[0];
  const ext = (path.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();

  const map = {
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    aac: "audio/aac",
    wav: "audio/wav",
    flac: "audio/flac",
    ogg: "audio/ogg",
    opus: "audio/opus",
    webm: "video/webm",
    mp4: "video/mp4",
    mov: "video/quicktime",
    m4v: "video/mp4",
  };

  return map[ext] || "";
}

function filenameFromUrl(url) {
  try {
    const u = new URL(String(url || ""));
    const path = decodeURIComponent(u.pathname || "");
    const name = path.split("/").filter(Boolean).pop() || "media";
    return name;
  } catch {
    return "media";
  }
}

function filenameFromContentDisposition(cd) {
  const s = String(cd || "");
  // filename*=UTF-8''...
  const m1 = s.match(/filename\*\s*=\s*([^;]+)/i);
  if (m1) {
    const v = m1[1].trim().replace(/^UTF-8''/i, "").replace(/^["']|["']$/g, "");
    try {
      return decodeURIComponent(v) || null;
    } catch {
      return v || null;
    }
  }
  // filename="..."
  const m2 = s.match(/filename\s*=\s*([^;]+)/i);
  if (m2) {
    const v = m2[1].trim().replace(/^["']|["']$/g, "");
    return v || null;
  }
  return null;
}

function makeAbortError(message) {
  const e = new Error(message || "Aborted");
  e.name = "AbortError";
  return e;
}

// Fetch with streaming progress. If CORS blocks the direct URL, fallback to same-origin proxy.
export async function downloadMediaFileFromUrl(url, { onProgress, signal } = {}) {
  const clean = String(url || "").trim();
  if (!clean) throw new Error("Missing URL");

  if (signal?.aborted) throw makeAbortError("Aborted");

  const tryFetch = async (u) => {
    return fetch(u, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      redirect: "follow",
      signal,
    });
  };

  let res;
  try {
    res = await tryFetch(clean);
  } catch (e) {
    if (signal?.aborted) throw makeAbortError("Aborted");
    res = null;
  }

  // If CORS blocked, do a same-origin proxy (you’ll add this endpoint in step 2)
  if (!res || !res.ok) {
    if (signal?.aborted) throw makeAbortError("Aborted");
    const proxied = `/api/threads/draft/proxy?url=${encodeURIComponent(clean)}`;
    try {
      res = await tryFetch(proxied);
    } catch (e) {
      if (signal?.aborted) throw makeAbortError("Aborted");
      res = null;
    }
  }

  if (!res || !res.ok) {
    const msg = `Download failed (${res?.status || "no response"})`;
    throw new Error(msg);
  }

  const contentType = String(res.headers.get("content-type") || "").split(";")[0].trim();
  const cd = res.headers.get("content-disposition") || "";
  const guessed = contentType || guessMimeFromUrl(clean) || "application/octet-stream";

  const isMedia = guessed.startsWith("audio/") || guessed.startsWith("video/");
  if (!isMedia) {
    throw new Error(`URL is not audio/video (content-type: ${guessed || "unknown"})`);
  }

  const totalBytes = Number(res.headers.get("content-length") || 0) || null;

  let buf;
  if (res.body && typeof res.body.getReader === "function") {
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;

    try {
      while (true) {
        if (signal?.aborted) {
          try {
            await reader.cancel();
          } catch {}
          throw makeAbortError("Aborted");
        }

        let out;
        try {
          out = await reader.read();
        } catch (err) {
          if (signal?.aborted) throw makeAbortError("Aborted");
          throw err;
        }

        const { done, value } = out;
        if (done) break;

        chunks.push(value);
        received += value.byteLength || value.length || 0;

        if (typeof onProgress === "function") {
          const pct = totalBytes ? Math.round((received / totalBytes) * 100) : null;
          onProgress({
            stage: "downloading",
            pct,
            receivedBytes: received,
            totalBytes,
          });
        }
      }
    } finally {
      // reader will close naturally; cancel handled above on abort
    }

    buf = new Blob(chunks, { type: guessed });
  } else {
    // Fallback (no progress)
    if (signal?.aborted) throw makeAbortError("Aborted");
    const ab = await res.arrayBuffer().catch((e) => {
      if (signal?.aborted) throw makeAbortError("Aborted");
      throw e;
    });

    buf = new Blob([ab], { type: guessed });

    if (typeof onProgress === "function") {
      onProgress({ stage: "downloading", pct: 100, receivedBytes: buf.size, totalBytes: buf.size });
    }
  }

  const nameFromCd = filenameFromContentDisposition(cd);
  const nameFromPath = filenameFromUrl(clean);
  const filename = (nameFromCd || nameFromPath || "media").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");

  const file = new File([buf], filename, { type: guessed, lastModified: Date.now() });

  return { file, mime: guessed };
}
