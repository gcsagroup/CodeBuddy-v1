import { CodeBuddyMark } from './CodeBuddyMark';

export function MainConversationAuthor({ model }: { model?: string | null }) {
  return <div className="mb-2 flex min-w-0 items-center gap-2 text-sm">
    <CodeBuddyMark className="size-7 shrink-0 rounded-full" />
    <strong className="text-text-primary">CodeBuddy</strong>
    {model && <span className="truncate text-xs text-text-secondary" title={model}>{model}</span>}
  </div>;
}
