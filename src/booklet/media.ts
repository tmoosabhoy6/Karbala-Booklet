import type { ImageBlock } from './model';
export const mediaSrc = (b: ImageBlock) => b.format
  ? `/media/${b.mediaId}.${b.rev}.${b.format}`
  : `/media/${b.mediaId}.svg?v=${b.rev}`;
/** The fihrist's opening words: a plain navy PNG, no CSS masking. */
export const openingSrc = (b: ImageBlock) => b.openingImage && b.format === 'png' ? `/media/${b.mediaId}.${b.rev}.opening.png` : null;
