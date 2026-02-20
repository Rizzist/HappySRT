export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const url = searchParams.get("url");

  if (!url) return new Response("Missing url", { status: 400 });

  let u;
  try {
    u = new URL(url);
  } catch {
    return new Response("Bad url", { status: 400 });
  }

  if (!["http:", "https:"].includes(u.protocol)) {
    return new Response("Bad protocol", { status: 400 });
  }

  // IMPORTANT: SSRF safety (at minimum, block localhost)
  const host = (u.hostname || "").toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return new Response("Blocked host", { status: 403 });
  }

  const upstream = await fetch(url, { redirect: "follow" });
  if (!upstream.ok) {
    return new Response(`Upstream failed: ${upstream.status}`, { status: upstream.status });
  }

  const ct = upstream.headers.get("content-type") || "application/octet-stream";
  const cl = upstream.headers.get("content-length");
  const cd = upstream.headers.get("content-disposition");

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": ct,
      ...(cl ? { "content-length": cl } : {}),
      ...(cd ? { "content-disposition": cd } : {}),
      "cache-control": "no-store",
    },
  });
}
