# HappySRT

<p align="center">
  <a href="https://www.happysrt.com">
    <img src="https://www.happysrt.com/logo.png" alt="HappySRT" width="96" height="96" />
  </a>
</p>

<h3 align="center">Open-source AI transcription, translation & summarization</h3>

<p align="center">
  Fast • Private-friendly • Built for creators
</p>

<p align="center">
  <a href="https://www.happysrt.com"><b>Live App</b></a>
  •
  <a href="#features"><b>Features</b></a>
  •
  <a href="#tech-stack"><b>Tech Stack</b></a>
  •
  <a href="#self-hosting"><b>Self-hosting</b></a>
  •
  <a href="#open-graph--social-preview"><b>Social Preview</b></a>
  •
  <a href="#contributing"><b>Contributing</b></a>
</p>

---

## What is HappySRT?

HappySRT is a modern web app for turning audio/video into:

- **Transcripts** (with timestamps / SRT)
- **Translations** (subtitle tracks in other languages)
- **Summaries** (highlights + bullet notes)

It’s built as a **threaded workspace**, so each project can keep its own uploads, outputs, and exports.

> ⭐ If you find this useful, please star the repo — it helps others discover the project.

---

## Features

- **Transcription** → clean text with timestamps (SRT-ready)
- **Translation** → generate multi-language subtitle tracks
- **Summarization** → highlights + bullet points
- **Threads** → separate workspaces per project
- **Exports** → save/copy/download outputs (SRT/Text)
- **Token-based usage UI** → “media tokens” shown in the sidebar + usage badges
- **Billing flow** → upgrade plans + Stripe checkout/portal hooks
- **PWA-ready** (optional) installable app experience
- **Clean UI** → styled-components + minimal “red as accent” design

---

## Tech Stack

- **Next.js** (Pages Router)
- **React**
- **styled-components**
- **Appwrite** (auth / DB / storage)
- **FFmpeg (in-browser)** for media handling
- **Stripe** (billing / checkout / customer portal)

---

## How the app works

### Threads & workflow
1. Create (or open) a thread from the left sidebar.
2. Upload audio/video (or paste a link if enabled).
3. Choose what you want to run:
   - Transcription
   - Translation
   - Summarization
4. Outputs show up inside the thread as the run completes.
5. Export/copy/save results (ex: SRT / Text).

### Media tokens & upgrades
- The UI shows your **Media Tokens** balance.
- Running jobs consumes tokens based on media size/length and selected actions.
- If you’re running low, use **Upgrade** to purchase a plan / more capacity.
- Billing is handled via Stripe (checkout + portal).

---

## Self-hosting

HappySRT is fully open source and self-hostable. You’ll need to provide your own:
- **Appwrite** project (auth + DB + storage)
- **Stripe** keys (if enabling billing)
- Any model/provider credentials you use for transcription/translation/summarization

### Environment variables
Create a `.env.local` file in the project root.

Tip: to see exactly what’s required in *your* codebase, search for `process.env.`.

Common categories:
- Appwrite endpoint / project ID / keys
- Stripe secret key / webhook secret (if used)
- Storage credentials (S3 / B2, if configured)
- Any AI provider keys (if configured)

---

## Open Graph / Social Preview

This repo includes an OG image builder page:

- Visit `/og`
- Click **Download PNG**
- Put the file at `public/og.png`
- Reference it in your SEO tags as the `og:image`

---

## Contributing

Issues and PRs are welcome.

Good first contributions:
- UI/UX polish
- Better export options (SRT/JSON/CSV)
- More language support / presets
- Performance improvements
- Docs + deployment guides (Vercel, Amplify, Docker, etc.)

Suggested workflow:
- Fork → branch → PR

---

## Security / Privacy Notes

- Never commit secrets (use `.env.local`)
- Treat uploaded media and generated transcripts as sensitive data
- If you enable external providers, review their data retention policies

---

## License

Add your license here (MIT / Apache-2.0 / etc).

