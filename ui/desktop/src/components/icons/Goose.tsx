import { CodeBuddyMark } from '../CodeBuddyMark';

// Preserve the legacy import name while rendering the current product mark.
export function Goose({ className = 'size-6' }) {
  return <CodeBuddyMark className={className} />;
}
