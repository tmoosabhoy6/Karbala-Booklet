import { Booklet } from './model';

/** What the print browser loads: the booklet, and data URLs for the few
 * images not kept as files (very old SVG entries, images a page sent along).
 * Every other image it loads from the server's /media files, whose names
 * carry their revision. */
export interface PrintPayload { doc: Booklet; assets: Record<string, string> }

/** A PDF request. The server prints from its own files; `assets` (data URLs)
 * are only for pages that still send their images along. */
export interface ExportRequest { doc: Booklet; filename: string; title: string; assets?: Record<string, string> }
