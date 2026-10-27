# Karbala Matam Majlis Booklet Generator: Build Plan

Master template: `references/HA_5mi Raat Majlis 1448h.pdf` (A4, 22 pages).
Every other PDF in `references/` is only there for context.

## 1. What I found in the references

| Element in the 5mi Raat PDF | How it is built | What we do with it |
|---|---|---|
| Cover artwork (grid, purple strip, side ornaments, maroon bar, logos) | One flattened JPEG, **991×1402 px (~120 dpi)** | Recolor purple to maroon and keep gold and the grid exactly as they are. Erase the old logos and the bar text, then redraw them. The low resolution means it prints soft (see Q8). |
| Cover title `پانچمي رات` / `مجلس` | Live text, AL-KANZ font, `#501549` | Replace with Kanz al-Marjaan in maroon |
| `سنة الشكر والبركات البديعة / سنة ١٤٤٨هـ` | **Vector** paths, blue `#424E75` | Lift the exact vectors and keep them static and blue |
| Maroon bar | `rgb(127,52,59)` = **`#7F343B`**, our base color | Holds only the location, in Kanz al-Marjaan |
| Inner-page border | Full-page JPEG, 2480×3508 (300 dpi), lavender | Recolor to a soft maroon with the same pattern |
| End ornament (blue lines + red teardrop) | 551×80 image | Keep unchanged (you said it's fine) |
| Verses (Marathi, Salam, Noha…) | **Screenshots pasted as PNGs** | Rebuild as clean vector ink (see §3) |
| `حسين حسين، پنجتن ماتم` page 20 | One 1300×1919 image | Fixed content. I'll rebuild it crisp |
| Headings | Kanz al-Marjaan 24pt, Word purple `#7030A0` | Maroon |
| Fihrist bars | Lavender header bar plus green section bars | Light maroon or rose tints |
| Last page (Sautuliman app ad) | n/a | Replaced by a back cover: the cover's grid background only, with both logos centered at medium size |

**Font:** Kanz al-Marjaan v0.1.7 (OFL licence) has 1,566 glyphs, full GSUB/GPOS, and every Lisan al-Dawat letter (ٹ ڈ ڑ ں ھ ے ۓ), Arabic-Indic digits and Latin. I tested it in Chromium and the shaping is correct.

**Calendar:** The Fatemi/Misri tabular calendar (Thursday epoch, leap years 2,5,8,10,13,16,19,21,24,27,29) gives **Tuesday 27 Oct 2026 = 17 Jumada al-Ula 1448**, which matches what you told me. It runs fully offline with no API.

## 2. Architecture

A local web app on your Mac, opened with one command (or a double-click launcher), at `http://localhost`. There's no sign-in.

- **UI:** Vite + React + TypeScript. Left: the form (date, venue, sections). Center: a live A4 page preview. Right: an inspector for the selected kalam or screenshot.
- **PDF engine:** Headless Chromium (Playwright) prints the *same* HTML you see in the preview, so preview and PDF are identical.
  - HarfBuzz shaping renders Kanz al-Marjaan correctly. pdf-lib and jsPDF can't shape Lisan al-Dawat reliably.
  - Text stays vector, and fonts are subset-embedded.
  - `<a href="#…">` links become real PDF links.
- **Post-process (pdf-lib):** Sets the PDF title and metadata, adds bookmarks (the sidebar outline on phones), and saves under the booklet title.
- **Image pipeline:** Runs in Node with `sharp` + `potrace`. Each screenshot is processed once when you paste it and then cached, so the editor stays fast.
- **Storage:** Booklets are saved as JSON plus images in `data/` (git-ignored). The editor autosaves, keeps a drafts list, and lets you duplicate last night's booklet.

## 3. Screenshot → print-quality ink (the core feature)

1. **Input:** Cmd+V paste, drag-and-drop, or multi-select. iPhone HEIC files work.
2. **Auto-crop:** Detects the background color from the image edges, so any background works: cream, dark mode, colored app themes.
3. **Ink matte:** Measures each pixel's distance from the background to get a soft, anti-aliased ink mask instead of a harsh threshold.
   - Neutral ink becomes clean black.
   - Colored ink (e.g. the red `ذكر الحسين خير زاد الذاكرين`) keeps its color.
4. **Vectorize:** Upscale 4×, then trace with potrace into SVG paths for each color layer, on pure white.
   - It traces the actual letters, so the original calligraphy and font are preserved exactly, and they stay sharp at any zoom or in print.
   - Fallback toggle: a 600 dpi raster matte for any screenshot that traces badly.
5. **Size normalization:** Detects line height from a horizontal projection profile. Every screenshot is scaled to the same text size whatever the zoom it was captured at, so four huge zoomed screenshots come out at the reference page's normal size. A slider overrides it per item.
6. **Line splitting:** Splits each screenshot into verse rows so pages break *between* lines, never through a line. Beyt pairs stay together. You can reorder or delete lines.
7. **Cleanup tools:** Crop handles and an eraser brush for stray UI (timestamps, app chrome).

## 4. Document model and venue templates

```
Booklet { date, hijri (computed), venue: 'haram' | 'najmi', title (auto, overridable), sections[] }
Section → Tartib entries (category + label) → Kalams { fihrist name, blocks[], separator, newPage }
Block = cleaned screenshot line group | typed Kanz text
```

**Haram Mubarak:** `امام حسين عليه السلام حرم مبارك`
- §1 `بيٹهي نے تلاوة`
  - القرآن الكريم (optional)
  - المراثي المباركة: always these three, in this order, each with a fixed name:
    - يا سيد الشهداء
    - فلك الحسين بكربلاء
    - ذكر الحسين خير زاد الذاكرين
  - Then `سواري غم ني آوي كربلا ما` (default) and any extras you add
  - النصيحة الشريفة (optional)
  - سلام ×n
  - ماتمي نوحه ×n
  - ماتم: حسين حسين، پنجتن ماتم (fixed; see Q4)
- §2 `كهڑا رهي نے تلاوة (فقط مردو كهڑا تهائے)`
  - سلام عرض (fixed)
  - رثاء
  - مدح

**Najmi Masjid:** `نجمي مسجد`
- §1 `بيٹهي نے تلاوة`
  - Quran (optional)
  - Marathi (same as above)
  - Nasihat (optional)
  - سلام ×n
- §2 `كهڑا رهي نے ماتم درميان تلاوة`
  - ماتمي نوحه ×n
  - ماتم (fixed)
  - سلام عرض
  - رثاء
  - مدح

**Rules:**
- Any empty category disappears from both the fihrist and the body.
- Every kalam in every category takes any number of screenshots, which you can reorder by dragging.
- Within one tartib group (e.g. Marathi), different kalams are separated by a thin maroon line. Verses of the same kalam get no line.
- Each Salam, Noha, Nasihat, etc. ends with the end ornament and the next one starts on a new page, as in the reference. You can toggle that per kalam.
- **Fihrist:** columns `ترتيب | كلام | الصفحة` (the `رقم` column is removed). Page numbers are filled in automatically after layout. `حكيمي پارٹي`-style tags are never generated.

## 5. Cover

- **Logos:** Logo 1 (`كربلاء المعلى`) and Logo 2 (`فيض حسيني`). Background cut out, recolored maroon, **10% larger** than the old logos.
- **Title:** `١٨ مي رات`, the night after the selected date. Nights 1–9 use the names below; from 10 up it's digits + `مي رات`. Under the title, `ماتم مجلس` sits larger than the old `مجلس` (~44pt instead of 36pt).
- **Maroon bar:** The location only.
- **Bottom:** `سنة الشكر…` and `سنة ١٤٤٨هـ` are static, in the original blue vectors.

Night names (confirmed): پهلي · بيجي · تيجي · چوتهي · پانچمي · چهٹي · ساتمي · اٰٹهمي · نومي. From ١٠ up it's digits + `مي رات`.

The cover also has a small blue date line under `ماتم مجلس` showing the day the majlis is held, e.g. `يوم الثلاثاء، ١٧ جمادى الاولى ١٤٤٨هـ`.

## 6. Hyperlinks and the output file

- Each fihrist kalam name and tartib label links to its page.
- Each page heading (`سلام`, `ماتمي نوحه`…) links back to the fihrist.
- PDF bookmarks are added too.
- I'll test the links in iOS Files/Books, Android Drive/Chrome and WhatsApp's viewer.
- The download is named after the title, e.g. `18mi Raat Matam Majlis.pdf`.

## 7. Editing

- Click any text in the preview to edit it inline in Kanz al-Marjaan.
- "Add text" places a free text box anywhere on a page.
- Drag to reorder kalams and screenshots.
- Undo/redo, plus a zoomable page preview.

## 8. Phases (each one ends with a review from you)

1. **Look:** Recolored assets, cover, fihrist, and one Salam page matching the reference side by side.
2. **Engine:** Data model, venue templates, Hijri dates, pagination, auto fihrist, links, export.
3. **Screenshot pipeline:** Clean ink, vectorizing, normalization, line splitting, crop/erase.
4. **Editor UX:** Drag reorder, inline text, autosave, defaults library.
5. **QA:** Pixel overlay against the reference, link tests on phones, A4 print test.

## 9. Decisions (27 Oct 2026)

- **Wazifat al-Shukr is removed everywhere**: no section, no option.
- **Logos:** recreate both as HD maroon vectors from the current files.
- **No source Word file exists.** The cover is cleaned and upscaled from the PDF's image.
- **Date line:** the day the majlis is held.
- **Haram:** the Matam goes at the end of the seated part (بيٹهي نے تلاوة).
- **Salam Arz:** `السلام عليك يا ابا عبد الله ×٢` opens it, the other lines follow as in the screenshot, and the opening line with `×٢` closes it.
- **Back page:** the cover's grid background only, with both logos centered at medium size.
- **Mac only** for now.
- **No prefilled verses.** Any processed screenshot can be pinned as the default for its kalam slot and unpinned later.
- **Commits:** every change is committed and pushed to `main`, references included.
