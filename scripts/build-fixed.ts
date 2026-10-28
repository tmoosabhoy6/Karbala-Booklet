// Cleans the built-in default pages once at build time (a few seconds on the host), so
// a server start only copies the finished files.
import { buildFixedMedia } from '../server/store';

await buildFixedMedia();
