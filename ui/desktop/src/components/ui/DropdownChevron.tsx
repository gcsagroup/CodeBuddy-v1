import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

export function DropdownChevron({ open, className = '' }: { open: boolean; className?: string }) {
  const previousOpen = useRef(open);
  const [rotation, setRotation] = useState(open ? 180 : 0);
  useEffect(() => {
    if (previousOpen.current === open) return;
    previousOpen.current = open;
    // Keep increasing so closing continues clockwise instead of reversing.
    setRotation((angle) => angle + 180);
  }, [open]);

  return (
    <ChevronDown
      aria-hidden="true"
      className={`shrink-0 transition-transform duration-200 ease-in-out motion-reduce:transition-none ${className}`}
      style={{ transform: `rotate(${rotation}deg)` }}
    />
  );
}
