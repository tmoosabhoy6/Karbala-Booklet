# Karbala Matam Majlis Booklet

A local app that builds Matam Majlis booklets (A4 PDF) for majalis in Karbala Mualla, styled on the 5mi Raat reference in maroon.

## Run

```bash
npm install
npx playwright install chromium
npm run dev
```

Open http://127.0.0.1:5173. **Download PDF** renders the booklet with headless Chromium, the same engine as the preview.

## Put it online (Render)

The app needs a real server (it cleans screenshots with sharp and prints the PDF with Chromium), so it runs on Render as a Docker service. `render.yaml` sets it all up:

1. In the Render dashboard: **New → Blueprint**, connect GitHub and pick this repo, then **Apply**.
2. There is no password, so keep the link to yourself. To add one later, set `APP_PASSWORD` in the service's Environment tab (any username works).
3. The first build takes about 10 minutes. Then open the `onrender.com` link it gives you, on your laptop or phone. On iPhone, Share → Add to Home Screen makes it an app icon.

It runs on the free plan in Frankfurt. The free plan has no persistent disk, so server files can disappear on restart or redeploy. The app keeps the working booklet, pinned defaults, original screenshots and their finished (cleaned) images in the browser's IndexedDB. When that browser opens the booklet after a restart, it hands the finished images back under their original names and the server saves them as they are: no re-cleaning, nothing downloaded twice, byte-for-byte the same lettering. Older browser copies get their finished images added quietly in the background. Keep using the same browser and do not clear its website data. This does not provide cross-device server storage: use a persistent disk at `/data` for that. The free service also sleeps when idle. Every push to `main` redeploys it, except pushes that only touch docs, tests, reference files, tools or Markdown (the `buildFilter` in `render.yaml`).

**Start-up:** `npm run build` compiles the server to `build/server.js` and cleans the fixed Matam page ahead of time, so a start only copies it. Chromium, the PDF library and OCR load on first use. The live image keeps no build-only tools (`npm prune --omit=dev`).

**On a phone:** Kalams / Preview tabs switch panels; tap a kalam's box to add screenshots from Photos. After **Download PDF**, tap **Save …pdf**: it goes to Files (iPhone) or Downloads (Android), ready to share on WhatsApp.

**Without hosting:** `HOST=0.0.0.0 APP_PASSWORD=yourpassword npm start` on the Mac, then open `http://<the Mac's Wi-Fi IP>:3001` on a phone on the same Wi-Fi.

## Using it

1. **Karbala / Najaf:** the tabs at the top switch between two separate workspaces, each with its own booklet and pinned defaults (`?city=najaf` opens Najaf directly). Najaf prints the same booklet in green, with Amirul Mumineen AS na Haram Mubarak as its one venue and the Najmi Masjid heading for the standing section.
2. **Date and venue:** the date defaults to today and the title (e.g. ١٨ مي رات) follows it. In Karbala, pick Haram Mubarak or Najmi Masjid; your content stays when you switch.
3. **Add screenshots:**
   - Click a kalam card, then press ⌘V to paste, drag images onto it, or click its drop area to choose files.
   - Paper/dark backgrounds become transparent. A linear ink matte preserves thin strokes, detached dots, and antialiased edges in a lossless transparent PNG. The original is retained. Small screenshots can be restored using the six-booklet visual reference bank; cleanup alone does not invent missing resolution.
   - Isolated straight rules, clipped edge fragments, distant specks and recognized standalone page numbers are removed. Crop/erase remains available for ambiguous marks; turn off automatic cleanup to recover anything it mistakenly removed.
   - Verse/stanza numbers and numbered badges in the margin, and dashed frame lines at the edges, are removed automatically, so they never print or merge two rows.
   - Each kalam prints at one lettering size: screenshots at other zooms or in other fonts are matched by line pitch. Rows are never independently enlarged/shrunk by their glyph bounds. Stanzas keep the source's baseline spacing and column relationships; gaps appear only where the source has a stanza break, and every stanza gap in a kalam is identical. A kalam that fits on one page is never split across pages.
4. **Order:** each screenshot has a numbered badge. Drag to reorder, or click the number and type a new position. Kalams move with ↑ ↓.
5. **Name:** unnamed kalams automatically show a clean crop of their opening verse/up to five words in the fihrist, including Urdu, in the same navy as typed names and with the correct page link. Type a name in the card or click the entry in **Edit text** to replace it. Local Arabic/Urdu OCR helps detect page numbers. The app never substitutes recognized words into the actual verse artwork.
6. **Clean up:** ✎ opens the crop/erase editor. Drag boxes over verse-number badges, timestamps or other marks.
7. **Defaults:** ★ pins a kalam (name + screenshots) as the default for new booklets. Click again to unpin.
   **AI lettering restoration:** the **AI** button beside a screenshot opens an original/draft comparison. Create a draft, inspect every word and dot, then choose **Use restored lettering** or **Keep original**. Drafts use the untouched source with your crop/erase edits and script-specific samples extracted from all six reference booklets. Select Urdu Nastaliq, Arabic, Lisan al-Dawat, or automatic matching. High-quality, aspect-matched output preserves stanza layout and existing colours. Drafts with missing rows, opaque backgrounds or insufficient resolution are rejected. Use full-size comparison to check the words; structural checks do not prove spelling. Accepted drafts retain their high-resolution transparent PNG without threshold tracing.
8. **Edit text:** click **✎ Edit text** above the preview, then click any text on the pages to retype it in Kanz al-Marjaan: cover title, date line and location, the fihrist (headings, section titles, kalam names, page numbers), page headings, Salam Arz lines and page numbers. Enter saves, Esc cancels; A− / A+ resize it and ↺ Original undoes the edit. **+ Text box** then a click on a page adds your own text there: drag to move it, click to type (Shift+Enter for a new line), pick a size and colour, or 🗑 to delete. Edited text has a blue dashed outline. Edits to generated text (e.g. the title) drop away by themselves if the date or venue changes it. **New booklet** keeps your cover and fihrist wording and clears headings, page-number edits and text boxes.
9. **Download PDF:** the file is named after the title, e.g. `18mi Raat Matam Majlis.pdf`. The phone sends only the booklet: the server prints from its own copies of the images and asks the browser for any it has lost, which go back once as plain bytes. The print snapshot is self-contained, every image and font is checked, and it fails explicitly if something is still missing. A small completed-PDF cache makes repeated downloads immediate. OCR/cleaning and printing share one work queue, and Chromium is closed after printing to keep the free host within its memory limit.

Kalams without screenshots are left out of the booklet and the fihrist. Work autosaves to `data/` (git-ignored). Undo with ⌘Z and redo with ⇧⌘Z.

## Layout

- `src/booklet/`: the document model, venue templates, pagination and page components (`Editable.tsx`: typing on the pages)
- `src/lib/hijri.ts`: the Fatemi (Misri) Hijri calendar and the title and date-line wording
- `server/`: screenshot ink and row/stanza geometry (`ink.ts`), packaged offline Arabic/Urdu OCR (`recognize.ts`), optional image restoration (`restore.ts`), storage (`store.ts`) and PDF export (Playwright + pdf-lib)
- `src/editor/`: the input panel, crop/erase editor, autosave and undo
- `scripts/`: the server build (`build-server.mjs`) and the build-time cleaning of the fixed Matam page
- `public/assets/`: the recolored artwork, generated by `tools/build_assets.py` (cover, border, ornaments), `tools/build-logos.mjs` (logos) and `tools/build_najaf.py` (the `-najaf` green copies, made from the finished maroon files), then losslessly recompressed by `tools/optimize_assets.py`, which also makes the half-size `*.preview.jpg` backgrounds the on-screen preview uses (the PDF always uses the full 2480×3508 images) and the WOFF2 font. Rerun it after regenerating artwork.
- `public/fonts/`: Kanz al-Marjaan v0.1.7 (SIL OFL), served as WOFF2 with the TTF as fallback
- `docs/PLAN.md`: the full plan and recorded decisions
- `docs/REFERENCE_STYLE.md`: measured conventions from all 153 pages of the six reference PDFs and the typography rules future changes must preserve

## Optional OpenAI image restoration

Configure `OPENAI_API_KEY` as a server environment secret (Render's Environment page). It must permit image edits; never put it into browser code or commit it. No key is needed for source-preserving background removal and uniform layout.

The default is `OPENAI_IMAGE_MODEL=gpt-image-2.5-flare`, `quality=high`, one transparent PNG per request with an aspect-matched canvas up to 2048 pixels per edge. There is no high reasoning setting. `AI_DAILY_LIMIT` defaults to 10 drafts per UTC day on the running instance, with at most three queued; identical source/revision requests reuse the job. The limit is an app request cap, not an account billing limit, and resets if the ephemeral service restarts. Restorations use existing API credits. Billing, credit purchases and auto-reload are managed in the OpenAI account.

Generation runs as a queued job so it does not hold an HTTP request open for the whole image edit. A failed/refused/limited request leaves the source untouched. A generated draft requires explicit acceptance and remains undoable.

## Verification and source quality

`npm run verify` builds the production app and tests an isolated data directory: actual uploads and downloads, Arabic typography, automatic fihrist entries, whole-stanza pagination, A4 bounds, embedded artwork surviving missing server files, repeat-export caching, and explicit rejection of missing/corrupt images. Test artifacts stay in ignored `work/verify-*` folders.

The reference bank is visual context, not fine-tuning: the configured image model does not support fine-tuning. Rebuild it with `python tools/build_lettering_bank.py` (PyMuPDF and Pillow). The checked-in `server/lettering-bank/manifest.json` records source hashes, all 153 pages, fonts, crop coordinates and sample styles.

Each screenshot is stored once: the untouched original, `<id>.<rev>.png` and the fihrist's `<id>.<rev>.opening.png`. Very old booklet entries that ask for an `.svg` get it rebuilt around the PNG on request. Existing screenshots are reprocessed once from their untouched originals when opened. Sources deleted by an older free-hosting instance can sometimes be rescued from the old browser's cached preview; this cannot recover detail already lost by the old tracer. If both the original and the browser copy are gone, re-add the screenshot. Very small screenshots are flagged: upscaling cannot reconstruct missing dots or letter detail. Larger originals or the source PDF give the best print quality.
