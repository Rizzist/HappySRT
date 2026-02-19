// pages/og.js
import Head from "next/head";
import { useEffect, useMemo, useRef, useState } from "react";
import styled from "styled-components";

import { Download } from "@styled-icons/feather/Download";
import { Code } from "@styled-icons/feather/Code";

import { Mic } from "@styled-icons/feather/Mic";
import { Globe } from "@styled-icons/feather/Globe";
import { FileText } from "@styled-icons/feather/FileText";
import { Github } from "@styled-icons/feather/Github";
import { Zap } from "@styled-icons/feather/Zap";

function safeNowName(prefix, ext) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(
    d.getMinutes()
  )}${pad(d.getSeconds())}`;
  return `${prefix}_${ts}.${ext}`;
}

async function fetchAsDataUrl(path) {
  const res = await fetch(path, { cache: "force-cache" }).catch(() => null);
  if (!res || !res.ok) return "";
  const blob = await res.blob();
  return await new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => resolve("");
    r.readAsDataURL(blob);
  });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function serializeSvg(svgEl) {
  if (!svgEl) return "";
  const clone = svgEl.cloneNode(true);

  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");

  const imgs = clone.querySelectorAll("image");
  imgs.forEach((img) => {
    const href = img.getAttribute("href") || img.getAttribute("xlink:href");
    if (href && !img.getAttribute("href")) img.setAttribute("href", href);
  });

  const xml = new XMLSerializer().serializeToString(clone);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`;
}

function OgArt({ svgRef, logoDataUrl }) {
  const W = 1200;
  const H = 630;

  // ✅ inner padding so NOTHING clips (including shadows)
  const PAD = 34;
  const IX = PAD;
  const IY = PAD;
  const IW = W - PAD * 2;
  const IH = H - PAD * 2;

  const title = "HappySRT";
  const tagline = "AI transcription, translation & summarization";
  const sub = "Fast • Private-friendly • Built for creators";

  return (
    <svg ref={svgRef} width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="HappySRT OG image">
      <defs>
        {/* Brand reds */}
        <linearGradient id="brand" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#ef4444" />
          <stop offset="1" stopColor="#fb7185" />
        </linearGradient>

        {/* Background */}
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#fff5f5" />
        </linearGradient>

        <radialGradient id="softRed" cx="22%" cy="20%" r="70%">
          <stop offset="0" stopColor="rgba(239,68,68,0.14)" />
          <stop offset="0.50" stopColor="rgba(239,68,68,0.06)" />
          <stop offset="1" stopColor="rgba(239,68,68,0)" />
        </radialGradient>

        <radialGradient id="softInk" cx="78%" cy="82%" r="75%">
          <stop offset="0" stopColor="rgba(17,24,39,0.06)" />
          <stop offset="0.55" stopColor="rgba(17,24,39,0.03)" />
          <stop offset="1" stopColor="rgba(17,24,39,0)" />
        </radialGradient>

        <filter id="shadow" x="-25%" y="-25%" width="150%" height="150%">
          <feDropShadow dx="0" dy="4" stdDeviation="18" floodColor="rgba(17,24,39,0.14)" />
        </filter>

        <filter id="softShadow" x="-25%" y="-25%" width="150%" height="150%">
          <feDropShadow dx="0" dy="6" stdDeviation="10" floodColor="rgba(17,24,39,0.10)" />
        </filter>

        {/* Diagonal stripes pattern */}
        <pattern id="stripes" patternUnits="userSpaceOnUse" width="22" height="22" patternTransform="rotate(45)">
          <rect width="22" height="22" fill="transparent" />
          <rect x="0" y="0" width="8" height="22" fill="rgba(17,24,39,0.035)" />
        </pattern>

        {/* Card */}
        <linearGradient id="card" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="rgba(255,255,255,0.94)" />
          <stop offset="1" stopColor="rgba(255,255,255,0.76)" />
        </linearGradient>
      </defs>

      {/* Background */}
      <rect x="0" y="0" width={W} height={H} fill="url(#bg)" />
      <rect x="0" y="0" width={W} height={H} fill="url(#softRed)" />
      <rect x="0" y="0" width={W} height={H} fill="url(#softInk)" />
      <rect x="0" y="0" width={W} height={H} fill="url(#stripes)" opacity="0.33" />

      {/* ✅ Inner frame (purely for layout) */}
      <g transform={`translate(${IX},${IY})`}>
        {/* Top row */}
        <g transform="translate(0,0)">
          {/* Top-left brand mark */}
          <g filter="url(#softShadow)">
            {/* rounded rect instead of oval */}
            <rect
              x="0"
              y="0"
              rx="18"
              ry="18"
              width="320"
              height="56"
              fill="rgba(255,255,255,0.72)"
              stroke="rgba(17,24,39,0.10)"
            />
          </g>

          <g transform="translate(14,10)">
            <rect x="0" y="0" rx="12" ry="12" width="36" height="36" fill="rgba(239,68,68,0.10)" stroke="rgba(239,68,68,0.18)" />
            {logoDataUrl ? (
              <image href={logoDataUrl} x="5" y="5" width="26" height="26" preserveAspectRatio="xMidYMid meet" />
            ) : (
              <text x="18" y="25" textAnchor="middle" fontSize="16" fontWeight="900" fill="#111827">
                H
              </text>
            )}
          </g>

          <text
            x="62"
            y="34"
            fontSize="18"
            fontWeight="950"
            fill="#111827"
            fontFamily="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial"
          >
            {title}
          </text>

          {/* Top-right Open Source badge */}
          <g transform={`translate(${IW - 330},2)`} filter="url(#softShadow)">
            {/* rounded rectangle instead of pill */}
            <rect
              x="0"
              y="0"
              rx="16"
              ry="16"
              width="330"
              height="52"
              fill="rgba(255,255,255,0.76)"
              stroke="rgba(17,24,39,0.10)"
            />

            <g transform="translate(14,16)">
              <Github width="18" height="18" color="#111827" />
            </g>

            <text
              x="44"
              y="32"
              fontSize="12"
              fontWeight="950"
              fill="#111827"
              fontFamily="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial"
            >
              Open source on GitHub
            </text>

            {/* OSS tag - rounded rectangle */}
            <g transform="translate(252,13)">
              <rect x="0" y="0" rx="10" ry="10" width="64" height="26" fill="rgba(239,68,68,0.10)" stroke="rgba(239,68,68,0.22)" />
              <text
                x="32"
                y="18"
                textAnchor="middle"
                fontSize="11"
                fontWeight="950"
                fill="#ef4444"
                fontFamily="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial"
              >
                OSS
              </text>
            </g>
          </g>
        </g>

        {/* Title area */}
        <g transform="translate(0,118)">
          <text
            x="0"
            y="80"
            fontSize="92"
            fontWeight="1000"
            fill="#111827"
            letterSpacing="-1.6"
            fontFamily="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial"
          >
            Happy
          </text>

          <text
            x="318"
            y="80"
            fontSize="92"
            fontWeight="1000"
            fill="url(#brand)"
            letterSpacing="-1.6"
            fontFamily="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial"
          >
            SRT
          </text>

          {/* highlight bars -> rounded rectangles (no mega-oval corners) */}
          <rect x="0" y="98" width="520" height="10" rx="6" ry="6" fill="rgba(239,68,68,0.14)" />
          <rect x="0" y="98" width="220" height="10" rx="6" ry="6" fill="rgba(239,68,68,0.28)" />
        </g>

        {/* Taglines */}
        <g transform="translate(0,272)">
          <text
            x="0"
            y="0"
            fontSize="26"
            fontWeight="900"
            fill="#111827"
            fontFamily="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial"
          >
            {tagline}
          </text>

          <text
            x="0"
            y="34"
            fontSize="16"
            fontWeight="800"
            fill="rgba(17,24,39,0.66)"
            fontFamily="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial"
          >
            {sub}
          </text>
        </g>

        {/* Feature cards */}
        <g transform="translate(0,330)">
          <FeatureCard x={0} label="Transcription" hint="Clean SRT from audio/video" Icon={Mic} />
          <FeatureCard x={350} label="Translation" hint="Multi-language subtitle tracks" Icon={Globe} />
          <FeatureCard x={700} label="Summarization" hint="Fast notes + highlights" Icon={FileText} />
        </g>

        {/* Bottom line (kept fully inside canvas now) */}
        <g transform={`translate(0,${IH - 58})`}>
          <g filter="url(#softShadow)">
            <rect
              x="0"
              y="0"
              rx="16"
              ry="16"
              width="520"
              height="54"
              fill="rgba(255,255,255,0.74)"
              stroke="rgba(17,24,39,0.10)"
            />
          </g>

          <g transform="translate(16,14)">
            <rect x="0" y="0" rx="10" ry="10" width="34" height="26" fill="rgba(239,68,68,0.10)" stroke="rgba(239,68,68,0.22)" />
            <g transform="translate(9,5)">
              <Zap width="16" height="16" color="#ef4444" />
            </g>

            <text
              x="48"
              y="18"
              fontSize="13"
              fontWeight="950"
              fill="#111827"
              fontFamily="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial"
            >
              www.happysrt.com
            </text>

            <text
              x="188"
              y="18"
              fontSize="13"
              fontWeight="850"
              fill="rgba(17,24,39,0.58)"
              fontFamily="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial"
            >
              • Next.js • FFmpeg • Realtime
            </text>
          </g>
        </g>
      </g>

      {/* Outer stroke */}
      <rect
        x="12"
        y="12"
        width={W - 24}
        height={H - 24}
        rx="26"
        ry="26"
        fill="transparent"
        stroke="rgba(17,24,39,0.10)"
      />
    </svg>
  );
}

function FeatureCard({ x, label, hint, Icon }) {
  return (
    <g transform={`translate(${x},0)`} filter="url(#shadow)">
      <rect x="0" y="0" rx="22" ry="22" width="320" height="124" fill="url(#card)" stroke="rgba(17,24,39,0.10)" />

      <g transform="translate(18,18)">
        <rect x="0" y="0" rx="14" ry="14" width="44" height="44" fill="rgba(239,68,68,0.10)" stroke="rgba(239,68,68,0.20)" />
        <g transform="translate(11,11)">
          <Icon width="22" height="22" color="#ef4444" />
        </g>

        <text
          x="62"
          y="20"
          fontSize="18"
          fontWeight="1000"
          fill="#111827"
          fontFamily="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial"
        >
          {label}
        </text>

        <text
          x="62"
          y="40"
          fontSize="13"
          fontWeight="850"
          fill="rgba(17,24,39,0.62)"
          fontFamily="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial"
        >
          {hint}
        </text>

        {/* ✅ rounded rectangle (not oval) */}
        <g transform="translate(0,60)">
          <rect x="0" y="0" rx="12" ry="12" width="284" height="34" fill="rgba(17,24,39,0.03)" stroke="rgba(17,24,39,0.06)" />
          <text
            x="142"
            y="22"
            textAnchor="middle"
            fontSize="12"
            fontWeight="950"
            fill="rgba(17,24,39,0.70)"
            fontFamily="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial"
          >
            Upload → Process → Export
          </text>
        </g>
      </g>
    </g>
  );
}

export default function OgPage() {
  const svgRef = useRef(null);
  const [logoDataUrl, setLogoDataUrl] = useState("");

  useEffect(() => {
    fetchAsDataUrl("/icons/icon-192.png")
      .then((u) => setLogoDataUrl(String(u || "")))
      .catch(() => setLogoDataUrl(""));
  }, []);

  const onDownloadSvg = async () => {
    const svgString = serializeSvg(svgRef.current);
    if (!svgString) return;
    const blob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
    downloadBlob(blob, safeNowName("happysrt_og", "svg"));
  };

  const onDownloadPng = async () => {
    const svgString = serializeSvg(svgRef.current);
    if (!svgString) return;

    const svgDataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgString)}`;
    const img = new Image();
    img.decoding = "async";

    await new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = (e) => reject(e);
      img.src = svgDataUrl;
    }).catch(() => null);

    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 630;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    await new Promise((resolve) => {
      canvas.toBlob((blob) => {
        if (blob) downloadBlob(blob, safeNowName("happysrt_og", "png"));
        resolve();
      }, "image/png");
    });
  };

  const tips = useMemo(
    () => [
      "Open /og in production, click Download PNG, then place it in /public/og.png",
      "Use <meta property='og:image' content='https://yourdomain.com/og.png' />",
      "OG size is 1200×630 (this matches exactly).",
    ],
    []
  );

  return (
    <Wrap>
      <Head>
        <title>HappySRT OG Generator</title>
        <meta name="robots" content="noindex,nofollow" />
      </Head>

      <Card>
        <Top>
          <TitleRow>
            <Title>OG Image Builder</Title>
            <Pill>1200×630</Pill>
          </TitleRow>

          <Sub>
            Preview + download a crisp PNG/SVG. Then drop the PNG into <b>/public/og.png</b>.
          </Sub>
        </Top>

        <PreviewOuter>
          <PreviewInner>
            <OgArt svgRef={svgRef} logoDataUrl={logoDataUrl} />
          </PreviewInner>
        </PreviewOuter>

        <Actions>
          <Primary type="button" onClick={onDownloadPng}>
            <BtnIcon as={Download} aria-hidden="true" />
            Download PNG
          </Primary>

          <Secondary type="button" onClick={onDownloadSvg}>
            <BtnIcon as={Code} aria-hidden="true" />
            Download SVG
          </Secondary>
        </Actions>

        <Tips>
          {tips.map((t) => (
            <Tip key={t}>{t}</Tip>
          ))}
        </Tips>
      </Card>
    </Wrap>
  );
}

const Wrap = styled.div`
  min-height: 100vh;
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: 18px;
  background: var(--bg);
`;

const Card = styled.div`
  width: min(1040px, 100%);
  border-radius: 18px;
  border: 1px solid var(--border);
  background: var(--panel);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.18);
  overflow: hidden;
`;

const Top = styled.div`
  padding: 16px 16px 10px 16px;
`;

const TitleRow = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
`;

const Title = styled.div`
  font-size: 16px;
  font-weight: 950;
  color: var(--text);
`;

const Pill = styled.div`
  font-size: 11px;
  font-weight: 900;
  padding: 5px 9px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: rgba(0, 0, 0, 0.02);
  color: var(--muted);
`;

const Sub = styled.div`
  margin-top: 6px;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.4;

  b {
    color: var(--text);
    font-weight: 950;
  }
`;

const PreviewOuter = styled.div`
  padding: 14px 16px 8px 16px;
`;

const PreviewInner = styled.div`
  border-radius: 16px;
  overflow: hidden;
  border: 1px solid var(--border);
  background: rgba(0, 0, 0, 0.02);

  width: 100%;
  aspect-ratio: 1200 / 630;

  display: grid;
  place-items: center;

  svg {
    width: 100%;
    height: 100%;
    display: block;
  }
`;

const Actions = styled.div`
  padding: 10px 16px 14px 16px;
  border-top: 1px solid var(--border);
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
`;

const Primary = styled.button`
  border-radius: 14px;
  padding: 11px 12px;
  cursor: pointer;

  border: 1px solid rgba(239, 68, 68, 0.24);
  background: rgba(239, 68, 68, 0.08);
  color: var(--text);
  font-weight: 950;

  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 10px;

  &:hover {
    background: rgba(239, 68, 68, 0.11);
  }
`;

const Secondary = styled.button`
  border-radius: 14px;
  padding: 11px 12px;
  cursor: pointer;

  border: 1px solid var(--border);
  background: rgba(0, 0, 0, 0.02);
  color: var(--text);
  font-weight: 950;

  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 10px;

  &:hover {
    background: var(--hover);
  }
`;

const BtnIcon = styled.span`
  width: 16px;
  height: 16px;
  opacity: 0.9;
`;

const Tips = styled.div`
  padding: 0 16px 16px 16px;
  display: grid;
  gap: 6px;
`;

const Tip = styled.div`
  font-size: 11px;
  color: var(--muted);
  line-height: 1.35;
`;
