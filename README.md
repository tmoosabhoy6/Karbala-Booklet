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

The app needs a real server (it cleans screenshots with sharp/potrace and prints the PDF with Chromium), so it runs on Render as a Docker service. `render.yaml` sets it all up:

1. In the Render dashboard: **New → Blueprint**, connect GitHub and pick this repo, then **Apply**.
2. There is no password, so keep the link to yourself. To add one later, set `APP_PASSWORD` in the service's Environment tab (any username works).
3. The first build takes about 10 minutes. Then open the `onrender.com` link it gives you, on your laptop or phone. On iPhone, Share → Add to Home Screen makes it an app icon.

It runs on the free plan in Frankfurt. The free plan has no persistent disk, so server files can disappear on restart or redeploy. The app now keeps the working booklet, pinned defaults, and original screenshots in the browser's IndexedDB and restores missing server screenshots when that browser opens the booklet again. Keep using the same browser and do not clear its website data. This does not provide cross-device server storage: use a persistent disk at `/data` for that. The free service also sleeps when idle. Every push to `main` redeploys it.

**On a phone:** Kalams / Preview tabs switch panels; tap a kalam's box to add screenshots from Photos. After **Download PDF**, tap **Save …pdf**: it goes to Files (iPhone) or Downloads (Android), ready to share on WhatsApp.

**Without hosting:** `HOST=0.0.0.0 APP_PASSWORD=yourpassword npm start` on the Mac, then open `http://<the Mac's Wi-Fi IP>:3001` on a phone on the same Wi-Fi.

## Using it

1. **Date and venue:** the date defaults to today and the title (e.g. ١٨ مي رات) follows it. Pick Haram Mubarak or Najmi Masjid; your content stays when you switch.
2. **Add screenshots:**
   - Click a kalam card, then press ⌘V to paste, drag images onto it, or click its drop area to choose files.
   - Paper/dark backgrounds become transparent. A linear ink matte is fitted to precise vector contours with tight curve tolerance and no dot removal. Untouched originals and lossless PNGs remain as recovery sources. Black lettering and red refrains print sharply at any zoom.
   - Isolated straight rules, clipped edge fragments, distant specks and recognized standalone page numbers are removed. Crop/erase remains available for ambiguous marks; turn off automatic cleanup to recover anything it mistakenly removed.
   - A kalam's screenshots at the same capture zoom share one lettering scale. Rows are never independently enlarged/shrunk by their glyph bounds. Complete stanzas preserve the source's baseline spacing and column relationships; separate capture zooms are calibrated as groups.
3. **Order:** each screenshot has a numbered badge. Drag to reorder, or click the number and type a new position. Kalams move with ↑ ↓.
4. **Name:** unnamed kalams automatically show a clean crop of their opening verse/up to five words in the fihrist, including Urdu, in the same navy as typed names and with the correct page link. Type a name in the card or click the entry in **Edit text** to replace it. Local Arabic/Urdu OCR helps detect page numbers. The app never substitutes recognized words into the actual verse artwork.
5. **Clean up:** ✎ opens the crop/erase editor. Drag boxes over verse-number badges, timestamps or other marks.
6. **Defaults:** ★ pins a kalam (name + screenshots) as the default for new booklets. Click again to unpin.
   **AI lettering restoration:** the **AI** button beside a screenshot opens an original/draft comparison. Create a draft, inspect every word and dot, then choose **Use restored lettering** or **Keep original**. Drafts use the supplied screenshot plus the canonical Husain/Panjatan lettering reference; they do not replace an original automatically.
7. **Edit text:** click **✎ Edit text** above the preview, then click any text on the pages to retype it in Kanz al-Marjaan: cover title, date line and location, the fihrist (headings, section titles, kalam names, page numbers), page headings, Salam Arz lines and page numbers. Enter saves, Esc cancels; A− / A+ resize it and ↺ Original undoes the edit. **+ Text box** then a click on a page adds your own text there: drag to move it, click to type (Shift+Enter for a new line), pick a size and colour, or 🗑 to delete. Edited text has a blue dashed outline. Edits to generated text (e.g. the title) drop away by themselves if the date or venue changes it. **New booklet** keeps your cover and fihrist wording and clears headings, page-number edits and text boxes.
8. **Download PDF:** the file is named after the title, e.g. `18mi Raat Matam Majlis.pdf`. The download carries the preview's artwork into a self-contained print snapshot, checks every image and font, and fails explicitly if something is missing. A small completed-PDF cache makes repeated downloads immediate. OCR/tracing and printing share one work queue, and Chromium is closed after printing to keep the free host within its memory limit.

Kalams without screenshots are left out of the booklet and the fihrist. Work autosaves to `data/` (git-ignored). Undo with ⌘Z and redo with ⇧⌘Z.

## Layout

- `src/booklet/`: the document model, venue templates, pagination and page components (`Editable.tsx`: typing on the pages)
- `src/lib/hijri.ts`: the Fatemi (Misri) Hijri calendar and the title and date-line wording
- `server/`: screenshot ink and row/stanza geometry (`ink.ts`), precision vector contours (`vector.ts`), packaged offline Arabic/Urdu OCR (`recognize.ts`), optional image restoration (`restore.ts`), storage (`store.ts`) and PDF export (Playwright + pdf-lib)
- `src/editor/`: the input panel, crop/erase editor, autosave and undo
- `public/assets/`: the recolored artwork, generated by `tools/build_assets.py` (cover, border, ornaments) and `tools/build-logos.mjs` (logos)
- `public/fonts/`: Kanz al-Marjaan v0.1.7 (SIL OFL)
- `docs/PLAN.md`: the full plan and recorded decisions
- `docs/REFERENCE_STYLE.md`: measured conventions from all 153 pages of the six reference PDFs and the typography rules future changes must preserve

## Optional OpenAI image restoration

Configure `OPENAI_API_KEY` as a server environment secret (Render's Environment page). It must permit image edits; never put it into browser code or commit it. No key is needed for the default vector cleanup and uniform layout.

The default is `OPENAI_IMAGE_MODEL=gpt-image-2.5-flare`, `quality=medium`, one transparent PNG per request. There is no high reasoning setting. `AI_DAILY_LIMIT` defaults to 10 drafts per UTC day on the running instance, with at most three queued; identical source/revision requests reuse the job. The limit is an app request cap, not an account billing limit, and resets if the ephemeral service restarts. Restorations use existing API credits. Billing, credit purchases and auto-reload are managed in the OpenAI account.

Generation runs as a queued job so it does not hold an HTTP request open for the whole image edit. A failed/refused/limited request leaves the source untouched. A generated draft requires explicit acceptance and remains undoable.

## Verification and source quality

`npm run verify` builds the production app and tests an isolated data directory: actual uploads and downloads, Arabic typography, automatic fihrist entries, whole-stanza pagination, A4 bounds, embedded artwork surviving missing server files, repeat-export caching, and explicit rejection of missing/corrupt images. Test artifacts stay in ignored `work/verify-*` folders.

Existing screenshots are reprocessed once from their untouched originals when opened. Sources deleted by an older free-hosting instance can sometimes be rescued from the old browser's cached preview; this cannot recover detail already lost by the old tracer. If both the original and the browser copy are gone, re-add the screenshot. Very small screenshots are flagged: upscaling cannot reconstruct missing dots or letter detail. Larger originals or the source PDF give the best print quality.
