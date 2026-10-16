import { Bot } from 'lucide-react';
import { cn } from '../utils';

const tones = [
  'text-[#d39460] dark:text-[#efbb8e]',
  'text-[#b59a43] dark:text-[#e5cc80]',
  'text-[#54a9ab] dark:text-[#8ed1d2]',
  'text-[#88a765] dark:text-[#b8d397]',
  'text-[#79a6d0] dark:text-[#accbea]',
];

export function SubagentAvatar({
  sessionId,
  small = false,
}: {
  sessionId: string;
  small?: boolean;
}) {
  // Derive identity from the native child ID so every entry point agrees.
  let identity = 0;
  for (let index = 0; index < sessionId.length; index += 1) {
    identity = (Math.imul(identity, 31) + sessionId.charCodeAt(index)) >>> 0;
  }
  return (
    <span
      aria-hidden="true"
      data-subagent-avatar={sessionId}
      className={cn(
        'inline-flex shrink-0 items-center justify-center',
        small ? 'h-4 w-4' : 'h-5 w-5',
        tones[identity % tones.length]
      )}
    >
      <Bot size={small ? 14 : 18} strokeWidth={1.8} />
    </span>
  );
}
