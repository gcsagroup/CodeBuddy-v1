import mark from '../images/mark.png';
import mark2x from '../images/mark@2x.png';

interface CodeBuddyMarkProps {
  className?: string;
}

export function CodeBuddyMark({ className = '' }: CodeBuddyMarkProps) {
  return (
    <img
      aria-hidden="true"
      alt=""
      className={className}
      src={mark}
      srcSet={`${mark} 1x, ${mark2x} 2x`}
      width={64}
      height={64}
      draggable={false}
    />
  );
}
