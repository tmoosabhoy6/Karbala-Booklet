// Cleans the fixed Matam page once at build time (about 3 s on the host), so
// a server start only copies the finished files.
import { buildFixedMedia } from '../server/store';

await buildFixedMedia();
