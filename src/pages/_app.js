// _app.js
import Head from "next/head";
import { AuthProvider } from "../contexts/AuthContext";
import { ThreadsProvider } from "@/contexts/threadsContext";
import { FfmpegProvider } from "../contexts/FfmpegContext";
import { createGlobalStyle } from "styled-components";

const GlobalStyle = createGlobalStyle`
  :root{
    --bg:#ffffff;
    --panel:#ffffff;
    --panel-2:#f7f7f8;
    --text:#111827;
    --muted:#6b7280;
    --border:#e5e7eb;
    --hover:#f3f4f6;
    --accent:#ef4444;
    --shadow:0 1px 2px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.06);
  }
  *{ box-sizing:border-box; }
  html, body, #__next { height:100%; }
  body{
    margin:0; padding:0;
    background:var(--bg);
    color:var(--text);
    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
  }
`;

export default function App({ Component, pageProps }) {
  return (
    <AuthProvider>
      <FfmpegProvider>
        <ThreadsProvider>
          <GlobalStyle />
            <Head>
              <link rel="icon" href="/favicon.ico" sizes="any" />
              <link rel="manifest" href="/manifest.json" />
              <meta name="theme-color" content="#ffffff" />
              <link rel="apple-touch-icon" href="/icons/icon-192.png" />
            </Head>
          <Component {...pageProps} />
        </ThreadsProvider>
      </FfmpegProvider>
    </AuthProvider>
  );
}
