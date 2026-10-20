/* global HTMLImageElement, Image */
import { useEffect, useRef, useState } from 'react';
import { petStates, type PetAnimation, type PetAsset } from './petTypes';

export function PetSprite({
  pet,
  animation = 'idle',
  reducedMotion = false,
  gazeFrame,
  onAlphaMap,
}: {
  pet: PetAsset;
  animation?: PetAnimation;
  reducedMotion?: boolean;
  gazeFrame?: number;
  onAlphaMap?: (alpha: Uint8ClampedArray) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    let active = true;
    const img = new Image();
    img.onload = () => {
      if (active) setImage(img);
    };
    img.onerror = () => {
      if (active) setImage(null);
    };
    img.src = pet.imageUrl;
    return () => {
      active = false;
    };
  }, [pet.imageUrl]);
  useEffect(() => {
    setFrame(0);
    if (reducedMotion || animation === 'look') return;
    const timer = setInterval(() => setFrame((f) => (f + 1) % 6), 1000 / pet.fps);
    return () => clearInterval(timer);
  }, [pet.id, pet.fps, animation, reducedMotion]);
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d', { willReadFrequently: Boolean(onAlphaMap) });
    if (!ctx || !image) return;
    const column = animation === 'look' ? (gazeFrame ?? 0) : reducedMotion ? 0 : frame;
    ctx.clearRect(0, 0, 192, 208);
    ctx.drawImage(
      image,
      column * 192,
      petStates.indexOf(animation) * 208,
      192,
      208,
      0,
      0,
      192,
      208
    );
    onAlphaMap?.(ctx.getImageData(0, 0, 192, 208).data);
  }, [image, frame, animation, reducedMotion, gazeFrame, onAlphaMap]);
  return (
    <canvas
      ref={canvas}
      width={192}
      height={208}
      style={{ width: '100%', height: '100%', objectFit: 'contain' }}
      aria-label={pet.name}
      role="img"
    />
  );
}
