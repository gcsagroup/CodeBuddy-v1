import { AlertCircle, X } from 'lucide-react';

interface PromptErrorBannerProps {
  message: string;
  dismissLabel: string;
  onDismiss: () => void;
}

export function PromptErrorBanner({ message, dismissLabel, onDismiss }: PromptErrorBannerProps) {
  return (
    <div
      role="alert"
      className="mx-4 mb-2 flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300"
    >
      <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <p className="min-w-0 flex-1 break-words">{message}</p>
      <button
        type="button"
        aria-label={dismissLabel}
        onClick={onDismiss}
        className="-mr-1 rounded p-1 text-current opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
      >
        <X aria-hidden="true" className="size-4" />
      </button>
    </div>
  );
}
