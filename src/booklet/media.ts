import type { ImageBlock } from './model';
export const mediaSrc = (b: ImageBlock) => b.format
  ? `/media/${b.mediaId}.${b.rev}.${b.format}`
  : `/media/${b.mediaId}.svg?v=${b.rev}`;
