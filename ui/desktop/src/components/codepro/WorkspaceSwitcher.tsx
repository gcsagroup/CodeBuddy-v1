import { cn } from '../../utils';
import { defineMessages, useIntl } from '../../i18n';

const i18n = defineMessages({
  workspaceSwitcher: {
    id: 'workspaceSwitcher.workspaceSwitcher',
    defaultMessage: 'Workspace switcher',
  },
});

export type WorkspaceMode = 'code' | 'codepro';

interface WorkspaceSwitcherProps {
  mode: WorkspaceMode;
  onChange: (mode: WorkspaceMode) => void;
  unifiedMode?: boolean;
}

export function WorkspaceSwitcher({ mode, onChange, unifiedMode = false }: WorkspaceSwitcherProps) {
  const intl = useIntl();
  if (unifiedMode) {
    return null;
  }

  return (
    <div
      role="group"
      aria-label={intl.formatMessage(i18n.workspaceSwitcher)}
      className="no-drag inline-flex h-9 w-36 items-center gap-0.5 rounded-lg border border-border-primary bg-background-secondary p-1"
    >
      {(['code', 'codepro'] as const).map((workspace) => {
        const selected = workspace === mode;
        const label = workspace === 'code' ? 'Code' : 'CodePro';
        return (
          <button
            key={workspace}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(workspace)}
            className={cn(
              'h-7 flex-1 cursor-pointer rounded-md px-2 text-sm font-medium leading-none transition-[background-color,color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              selected
                ? 'bg-background-primary text-text-primary shadow-sm'
                : 'text-text-secondary hover:bg-background-tertiary hover:text-text-primary'
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
