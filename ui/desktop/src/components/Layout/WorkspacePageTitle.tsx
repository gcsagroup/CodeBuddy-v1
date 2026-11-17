import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export function WorkspacePageTitle({
  icon: Icon,
  children,
  description,
}: {
  icon: LucideIcon;
  children: ReactNode;
  description?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-background-secondary text-text-secondary">
        <Icon className="size-4.5" aria-hidden="true" />
      </span>
      <div className="min-w-0 self-center">
        <h1 className="break-words text-xl font-semibold leading-tight tracking-tight">
          {children}
        </h1>
        {description && (
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-text-secondary">
            {description}
          </p>
        )}
      </div>
    </div>
  );
}
