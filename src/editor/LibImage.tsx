import { useEffect, useRef, useState } from 'react';
import { previewUrl, useLocalStatus } from '../library/client';

interface Props {
  source: string;
  n: number;
  what: 'title' | [number, number];
  className?: string;
  alt?: string;
}

/** A library preview (a kalam's title, or a verse), made on this device when
 * it can, and only once it scrolls near the screen. */
export function LibImage({ source, n, what, className, alt = '' }: Props) {
  const ref = useRef<HTMLImageElement>(null);
  const [near, setNear] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const key = what === 'title' ? 'title' : what.join('-');
  // A Zikre Husain preview still on its way from the server is made on this
  // device instead as soon as its copy is ready.
  const local = useLocalStatus().state === 'ready' && source === 'zh';
  const upgrade = local && !loaded;

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') { setNear(true); return; }
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { setNear(true); io.disconnect(); } }, { rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!near) return;
    let live = true;
    setFailed(false);
    previewUrl(source, n, what).then((url) => { if (live) { setSrc((old) => { if (old !== url) setLoaded(false); return url; }); } }, () => live && setFailed(true));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [near, source, n, key, upgrade]);

  return (
    <img
      ref={ref}
      className={`${className ?? ''}${src ? '' : ' loading'}${failed ? ' failed' : ''}`}
      src={src ?? 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='}
      alt={alt}
      draggable={false}
      onLoad={() => src && setLoaded(true)}
      onError={() => setFailed(true)}
    />
  );
}
