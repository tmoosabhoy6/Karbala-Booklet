# Booklet lettering contract

These six supplied PDFs are the visual reference set. All 153 pages were inventoried for fonts, color, image placement and effective image resolution:

| Reference | Pages |
| --- | ---: |
| HA_5mi Raat Majlis 1448h | 22 |
| Ai_15mi Raat Urs SMB RA 1448h | 54 |
| Ai_Shahadat Imam Hasan AS | 17 |
| Ai_Milad Imam al-Zaman AS | 17 |
| Ai_Milad un Nabi SAW 1448h | 27 |
| Ai_Chehlum 1448H | 16 |

The 5mi Raat booklet remains the geometry template; the existing approved maroon artwork replaces its purple decoration. The other references confirm the lettering and stanza conventions.

## Measured conventions

- A4 pages; the master content width is about 451pt. Other references use narrower, centered groups where appropriate.
- Embedded native fonts include Kanz al-Marjaan, AL-KANZ and Alvi Nastaleeq. Arabic/Lisan al-Dawat Naskh and Urdu Nastaliq are intentionally distinct script styles. Do not force Urdu into an unrelated Arabic face.
- Native body artwork is commonly about 190–260 DPI at its printed size, with some master screenshots around 145–160 DPI. Small pasted screenshots can be below 100 DPI when enlarged; their original grey pixels alone do not meet the crispness of the reference.
- Body text is black. Existing repeated/refrain phrases can be red. All fihrist entries, including automatically cropped opening words, use the same navy `#3a456a`.
- Representative black-ink line extents measured at twice the printed page resolution mostly have medians around 31–38pt. The target remains 34pt; glyph ascenders/descenders may naturally have different bounds while the underlying lettering scale stays identical.
- Couplet/stanza groups keep their original internal baseline spacing and column relationships, with clear space between stanzas. Complete ordinary stanzas stay on one page.

## Required implementation rules

1. Never independently fit each verse row to a target height or width. Derive one scale for a kalam's screenshots captured at the same zoom. Different capture zooms can form separate calibrated groups.
2. Place each stanza as one crop with its source baseline spacing. A short row must not be enlarged just because it contains fewer words.
3. Source-preserving vector contours use a linear ink matte, subpixel contour fitting, zero dot removal and tight curve tolerance. Keep untouched uploads and lossless PNGs as recovery sources. The fixed Husain/Panjatan artwork stays at its approved size.
4. Automatic fihrist openings use up to five opening words; manually entered names take precedence. This booklet's Noha name is `مارا گیا بھائی رن میں` (five words).
5. Image restoration uses the original plus the canonical lettering reference, one medium-quality image at a time. Generated drafts must be compared with the original before acceptance because image models can alter letters or dots.
6. Export must embed the exact reviewed artwork, reject decoding failures and keep all page links and numbers correct.

## Verification

`npm run verify` checks true path-based SVG output, shared scale across deliberately different glyph extents, whole-stanza pagination, actual PDF downloads, typography, bounds, missing-image failure and browser recovery. A final review must also render all output pages and compare the fihrist, Noha and Madh with the references at the same page scale.
