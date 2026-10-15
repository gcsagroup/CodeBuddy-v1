interface CodeBuddyMarkProps {
  className?: string;
}

export function CodeBuddyMark({ className = '' }: CodeBuddyMarkProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width="64" height="64" rx="15" fill="#0B1730" />
      <path
        d="M22 18L12 32L22 46"
        fill="none"
        stroke="#67E8F9"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="5"
      />
      <path
        d="M42 18L52 32L42 46"
        fill="none"
        stroke="#67E8F9"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="5"
      />
      <path d="M36 16L28 48" fill="none" stroke="#A3E635" strokeLinecap="round" strokeWidth="4" />
    </svg>
  );
}
