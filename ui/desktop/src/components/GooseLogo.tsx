import { CodeBuddyMark } from './CodeBuddyMark';
import { cn } from '../utils';

interface GooseLogoProps {
  className?: string;
  size?: 'default' | 'small';
  hover?: boolean;
}

export default function GooseLogo({
  className = '',
  size = 'default',
  hover = true,
}: GooseLogoProps) {
  const sizes = {
    default: {
      frame: 'w-16 h-16',
      mark: 'w-16 h-16',
    },
    small: {
      frame: 'w-8 h-8',
      mark: 'w-8 h-8',
    },
  } as const;

  const currentSize = sizes[size];

  return (
    <div
      className={cn(
        className,
        currentSize.frame,
        'relative overflow-hidden rounded-[24%]',
        hover && 'transition-transform duration-200 hover:scale-105'
      )}
    >
      <CodeBuddyMark className={currentSize.mark} />
    </div>
  );
}
