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
  const hasGazeFrame = gazeFrame !== undefined;
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
    if (reducedMotion || (animation === 'look' && hasGazeFrame)) return;
    const timer = setInterval(() => setFrame((f) => (f + 1) % 6), 1000 / pet.fps);
    return () => clearInterval(timer);
  }, [pet.id, pet.fps, animation, reducedMotion, hasGazeFrame]);
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d', { willReadFrequently: Boolean(onAlphaMap) });
    if (!ctx || !image) return;
    const column = reducedMotion ? 0 : animation === 'look' ? (gazeFrame ?? frame) : frame;
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
      className={
        !reducedMotion && (animation === 'idle' || animation === 'look')
          ? 'pet-breathing'
          : undefined
      }
      style={{ width: '100%', height: '100%', objectFit: 'contain' }}
      aria-label={pet.name}
      role="img"
    />
  );
}
