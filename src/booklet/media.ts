import type { ImageBlock } from './model';
export const mediaSrc = (b: ImageBlock) => b.format === 'png'
  ? `/media/${b.mediaId}.${b.rev}.png`
  : `/media/${b.mediaId}.svg?v=${b.rev}`;
