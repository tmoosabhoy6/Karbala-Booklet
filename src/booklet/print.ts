import { Booklet } from './model';

/** What the print browser loads: the booklet and the server's own copy of
 * every image it shows, so a fresh print never depends on an HTTP cache. */
export interface PrintPayload { doc: Booklet; assets: Record<string, string> }

/** A PDF request. The server prints from its own files; `assets` (data URLs)
 * are only for pages that still send their images along. */
export interface ExportRequest { doc: Booklet; filename: string; title: string; assets?: Record<string, string> }
