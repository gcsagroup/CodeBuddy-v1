import { useEffect, useRef } from 'react';

export function VideoFirstFrame({ src }: { src: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || typeof IntersectionObserver === 'undefined') return;
    let video: HTMLVideoElement | undefined;
    const release = () => {
      if (!video) return;
      video.onloadeddata = null;
      video.onerror = null;
      video.removeAttribute('src');
      video.load();
      video = undefined;
    };
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      const decoder = document.createElement('video');
      video = decoder;
      decoder.preload = 'auto';
      decoder.muted = true;
      decoder.onloadeddata = () => {
        const { videoWidth: w, videoHeight: h } = decoder;
        const side = Math.min(w, h);
        if (side > 0) {
          canvas
            .getContext('2d')
            ?.drawImage(
              decoder,
              (w - side) / 2,
              (h - side) / 2,
              side,
              side,
              0,
              0,
              canvas.width,
              canvas.height
            );
        }
        release();
      };
      decoder.onerror = release;
      decoder.src = src;
    });
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      release();
    };
  }, [src]);
  return <canvas ref={ref} width={128} height={128} aria-hidden="true" />;
}
