import { Atom } from 'lucide-react';

/** Match the operation icons while keeping reasoning activity recognizable. */
export default function ThinkingIcon({ active = false }: { active?: boolean }) {
  return (
    <Atom
      aria-hidden="true"
      className={`codepro-thinking-icon h-4 w-4 shrink-0${active ? ' motion-safe:animate-spin [animation-duration:4s]' : ''}`}
    />
  );
}
