import Head from "next/head";

export default function SEOHead({
  title,
  description,
  path = "/",
  noindex = false,
}) {
  const siteName = "HappySRT";
  const siteUrl = "https://www.happysrt.com";
  const githubUrl = "https://github.com/Rizzist/happysrt";
  const url = new URL(path, siteUrl).toString();
  const ogImage = new URL("/og.png", siteUrl).toString();

  const defaultTitle = "AI Transcription, Translation & Summarization";
  const defaultDescription =
    "Open-source AI transcription, translation, and summarization in your browser. Upload audio/video, get accurate transcripts, translations, and summaries.";

  const finalTitle = title ? `${title} | ${siteName}` : `${siteName} — ${defaultTitle}`;
  const finalDesc = description || defaultDescription;

  const schema = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: siteName,
    description: finalDesc,
    url,
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
    },
    isAccessibleForFree: true,
    ...(githubUrl ? { sameAs: [githubUrl] } : {}),
  };

  return (
    <Head>
      {/* Basic */}
      <title>{finalTitle}</title>
      <meta name="description" content={finalDesc} />
      <link rel="canonical" href={url} />

      {/* Robots */}
      <meta
        name="robots"
        content={
          noindex
            ? "noindex, nofollow"
            : "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1"
        }
      />

      {/* Open Graph */}
      <meta property="og:type" content="website" />
      <meta property="og:site_name" content={siteName} />
      <meta property="og:title" content={finalTitle} />
      <meta property="og:description" content={finalDesc} />
      <meta property="og:url" content={url} />
      <meta property="og:image" content={ogImage} />
      <meta property="og:image:width" content="512" />
      <meta property="og:image:height" content="512" />

      {/* Twitter */}
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={finalTitle} />
      <meta name="twitter:description" content={finalDesc} />
      <meta name="twitter:image" content={ogImage} />

      {/* JSON-LD */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
      />
    </Head>
  );
}
