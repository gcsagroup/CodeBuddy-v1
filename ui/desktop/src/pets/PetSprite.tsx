/* global HTMLImageElement, Image */
import { useEffect, useRef, useState } from 'react';
import { petActionCycles, petStates, type PetAnimation, type PetAsset } from './petTypes';

export function PetSprite({
  pet,
  animation = 'idle',
  reducedMotion = false,
  gazeFrame,
  playbackKey,
  onAlphaMap,
}: {
  pet: PetAsset;
  animation?: PetAnimation;
  reducedMotion?: boolean;
  gazeFrame?: number;
  playbackKey?: string | number;
  onAlphaMap?: (alpha: Uint8ClampedArray) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [pose, setPose] = useState({ animation, frame: 0 });
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
    setPose({ animation, frame: 0 });
    if (reducedMotion || (animation === 'look' && hasGazeFrame)) return;
    let timer: ReturnType<typeof setTimeout>;
    // Hold the neutral drawing between brief idle gestures. Do not scale the
    // entire character: that moves its feet and makes it look like a balloon.
    const rest = () => {
      setPose({ animation: 'idle', frame: 0 });
      timer = setTimeout(() => play('idle', 1), 4000 + Math.random() * 3000);
    };
    const play = (state: PetAnimation, step: number) => {
      setPose({ animation: state, frame: step % 6 });
      const end = state === 'idle' ? 6 : 6 * petActionCycles;
      const fps = state === 'idle' ? Math.max(10, pet.fps) : pet.fps;
      timer = setTimeout(() => {
        if (step + 1 >= end) rest();
        else play(state, step + 1);
      }, 1000 / fps);
    };
    if (animation === 'idle') rest();
    else play(animation, 0);
    return () => clearTimeout(timer);
  }, [pet.id, pet.imageUrl, pet.fps, animation, reducedMotion, hasGazeFrame, playbackKey]);
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d', { willReadFrequently: Boolean(onAlphaMap) });
    if (!ctx || !image) return;
    const displayedAnimation = animation === 'look' && hasGazeFrame ? 'look' : pose.animation;
    const column = reducedMotion
      ? 0
      : displayedAnimation === 'look'
        ? (gazeFrame ?? pose.frame)
        : pose.frame;
    ctx.clearRect(0, 0, 192, 208);
    ctx.drawImage(
      image,
      column * 192,
      petStates.indexOf(displayedAnimation) * 208,
      192,
      208,
      0,
      0,
      192,
      208
    );
    onAlphaMap?.(ctx.getImageData(0, 0, 192, 208).data);
  }, [image, pose, animation, reducedMotion, gazeFrame, hasGazeFrame, onAlphaMap]);
  return (
    <canvas
      ref={canvas}
      width={192}
      height={208}
      data-animation={animation === 'look' && hasGazeFrame ? 'look' : pose.animation}
      data-frame={reducedMotion ? 0 : animation === 'look' && hasGazeFrame ? gazeFrame : pose.frame}
      style={{ width: '100%', height: '100%', objectFit: 'contain' }}
      aria-label={pet.name}
      role="img"
    />
  );
}
