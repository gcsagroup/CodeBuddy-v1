import { Archive, Atom, MessageCircleQuestionMark, MessageSquareText } from 'lucide-react';
import ConversationSpinner from './ConversationSpinner';

interface AnimatedIconsProps {
  className?: string;
  variant?: 'thinking' | 'waiting' | 'streaming' | 'question' | 'compacting';
  animated?: boolean;
}

export default function AnimatedIcons({
  className = '',
  variant = 'thinking',
  animated = true,
}: AnimatedIconsProps) {
  if (variant === 'waiting') return <ConversationSpinner />;
  const Icon = variant === 'streaming' ? MessageSquareText
    : variant === 'question' ? MessageCircleQuestionMark
    : variant === 'compacting' ? Archive
    : Atom;
  const animationClass = !animated ? ''
    : variant === 'thinking' ? 'motion-safe:animate-spin [animation-duration:4s]'
    : 'motion-safe:animate-pulse';
  return (
    <span aria-hidden="true" className={`inline-grid size-4 shrink-0 place-items-center ${className}`}>
      <Icon className={`size-full ${animationClass}`} strokeWidth={1.8} />
    </span>
  );
}
