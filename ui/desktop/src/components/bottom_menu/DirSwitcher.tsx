import { getAcpControlClient } from '../../acp/acpConnection';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Folder, FolderOpen, Plus, X } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { toast } from 'react-toastify';
import { defineMessages, useIntl } from '../../i18n';
import { DropdownChevron } from '../ui/DropdownChevron';
import { ProjectCreator } from '../Layout/ProjectCreator';
import { getProjectAlias } from '../../utils/projectAliases';

const i18n = defineMessages({
  clearWorkspace: { id: 'codeProHub.clearWorkspace', defaultMessage: 'Clear selected workspace' },
  failedToUpdateWorkingDir: {
    id: 'dirSwitcher.failedToUpdateWorkingDir',
    defaultMessage: 'Failed to update working directory',
  },
  currentDirectory: {
    id: 'dirSwitcher.currentDirectory',
    defaultMessage: 'Current project',
  },
  recentDirectories: {
    id: 'dirSwitcher.recentDirectories',
    defaultMessage: 'Recent projects',
  },
  chooseDirectory: {
    id: 'dirSwitcher.chooseDirectory',
    defaultMessage: 'Choose workspace…',
  },
  chooseFolder: {
    id: 'dirSwitcher.chooseFolder',
    defaultMessage: 'Select workspace',
  },
  openInFinder: {
    id: 'dirSwitcher.openInFinder',
    defaultMessage: 'Open in file manager',
  },
});

const splitDirPath = (dir: string): { name: string; parent: string } => {
  const normalized = dir.replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/);
  const name = parts.pop() || dir;
  const parent = parts.join('/');
  return { name, parent };
};

const DirNameLabel: React.FC<{ dir: string }> = ({ dir }) => {
  const { name, parent } = splitDirPath(dir);
  return (
    <div className="flex flex-col min-w-0 flex-1">
      <span className="truncate text-sm leading-5 text-text-primary">{getProjectAlias(dir, name)}</span>
      {parent && <span className="truncate text-xs leading-4 text-text-secondary">{parent}</span>}
    </div>
  );
};

interface DirSwitcherProps {
  allowClear?: boolean;
  className: string;
  sessionId: string | undefined;
  workingDir: string;
  onWorkingDirChange?: (newDir: string) => Promise<void> | void;
  onRestartStart?: () => void;
  onRestartEnd?: () => void;
}

export const DirSwitcher: React.FC<DirSwitcherProps> = ({
  className,
  allowClear = false,
  sessionId,
  workingDir,
  onWorkingDirChange,
  onRestartStart,
  onRestartEnd,
}) => {
  const intl = useIntl();
  const [isDirectoryChooserOpen, setIsDirectoryChooserOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [recentDirs, setRecentDirs] = useState<string[]>([]);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const refreshVersionRef = useRef(0);

  const refreshMenuData = useCallback(async () => {
    const version = ++refreshVersionRef.current;
    setRecentDirs([]);

    const [recent, agentWorkspaces] = await Promise.all([
      window.electron.listRecentDirs().catch(() => []),
      getAcpControlClient()
        .then(
          (client) =>
            client.extMethod('_codebuddy/agents/workspaces', {}) as Promise<{
              directories: string[];
            }>
        )
        .then((result) => result.directories)
        .catch(() => []),
    ]);

    if (version !== refreshVersionRef.current) return;

    setRecentDirs([...new Set([...recent, ...agentWorkspaces])]);
  }, []);

  useEffect(() => {
    if (!isMenuOpen) {
      return;
    }

    void refreshMenuData();
  }, [isMenuOpen, refreshMenuData]);

  const applyDirectoryChange = async (newDir: string) => {
    window.electron.addRecentDir(newDir);
    setRecentDirs((previous) => [newDir, ...previous.filter((dir) => dir !== newDir)].slice(0, 10));

    if (sessionId) {
      onRestartStart?.();

      try {
        await onWorkingDirChange?.(newDir);
      } catch (error) {
        console.error('[DirSwitcher] Failed to update working directory:', error);
        toast.error(intl.formatMessage(i18n.failedToUpdateWorkingDir));
      } finally {
        onRestartEnd?.();
      }
    } else {
      await onWorkingDirChange?.(newDir);
    }
  };

  const handleDirectoryChange = async () => {
    if (!sessionId) { setIsMenuOpen(false); setCreating(true); return; }
    if (isDirectoryChooserOpen) return;
    setIsDirectoryChooserOpen(true);

    let result;
    try {
      result = await window.electron.directoryChooser();
    } finally {
      setIsDirectoryChooserOpen(false);
    }

    if (result.canceled || result.filePaths.length === 0) {
      return;
    }

    const newDir = result.filePaths[0];
    await applyDirectoryChange(newDir);
  };

  const handleSelectDirectory = async (newDir: string) => {
    if (newDir === workingDir) {
      setIsMenuOpen(false);
      return;
    }

    setIsMenuOpen(false);
    await applyDirectoryChange(newDir);
  };

  const handleDirectoryClick = async (event: React.MouseEvent) => {
    if (isDirectoryChooserOpen) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const isCmdOrCtrlClick = event.metaKey || event.ctrlKey;

    if (isCmdOrCtrlClick && workingDir) {
      event.preventDefault();
      event.stopPropagation();
      await window.electron.openDirectoryInExplorer(workingDir);
      return;
    }

    setIsMenuOpen((open) => !open);
  };

  const filteredRecentDirs = useMemo(
    () => recentDirs.filter((dir) => dir && dir !== workingDir),
    [recentDirs, workingDir]
  );

  const canClear = Boolean(allowClear && !sessionId && workingDir && onWorkingDirChange);
  const picker = (
    <DropdownMenu open={isMenuOpen} onOpenChange={setIsMenuOpen} modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          ref={triggerRef}
          className={`flex min-h-8 min-w-0 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-text-primary transition-colors hover:bg-background-tertiary/60 focus-visible:outline-2 disabled:opacity-50 ${className}`}
          onPointerDown={(event) => {
            // Radix opens on pointer-down; wait for click to finish before showing a menu item
            // under the pointer, or the same gesture can select a recent directory.
            if (event.button === 0 && !event.ctrlKey) event.preventDefault();
          }}
          onClick={handleDirectoryClick}
          disabled={isDirectoryChooserOpen}
          title={workingDir || intl.formatMessage(i18n.chooseFolder)}
          aria-label={workingDir || intl.formatMessage(i18n.chooseFolder)}
        >
          <Folder
            className={`size-4 shrink-0 ${canClear ? 'group-hover/workspace:opacity-0 group-focus-within/workspace:opacity-0' : ''}`}
            aria-hidden="true"
          />
          <div className="max-w-[200px] truncate group-data-[compact=true]/composer-toolbar:hidden">
            {workingDir
              ? getProjectAlias(workingDir, workingDir
                  .replace(/[\\/]+$/, '')
                  .split(/[\\/]/)
                  .pop() || workingDir)
              : intl.formatMessage(i18n.chooseFolder)}
          </div>
          <DropdownChevron
            open={isMenuOpen}
            className="size-3 group-data-[compact=true]/composer-toolbar:hidden"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        updatePositionStrategy="always"
        className="flex w-[min(19rem,calc(100vw-2rem))] max-h-[var(--radix-dropdown-menu-content-available-height)] flex-col overflow-hidden rounded-xl border-border-primary p-1.5 text-sm"
        side="top"
        align="start"
        onInteractOutside={(event) => {
          // The trigger handles its own toggle after click; do not dismiss it on pointer-down.
          if (event.target instanceof Node && triggerRef.current?.contains(event.target)) {
            event.preventDefault();
          }
        }}
      >
        <div className="max-h-56 min-h-0 overflow-x-hidden overflow-y-auto">
          {workingDir && (
            <>
              <DropdownMenuLabel className="py-1.5 text-xs font-medium text-text-secondary">
                {intl.formatMessage(i18n.currentDirectory)}
              </DropdownMenuLabel>
              <DropdownMenuItem
                className="rounded-lg py-2"
                onSelect={() => void window.electron.openDirectoryInExplorer(workingDir)}
              >
                <FolderOpen className="size-4" />
                <DirNameLabel dir={workingDir} />
                <Check className="ml-auto h-4 w-4 flex-shrink-0" />
              </DropdownMenuItem>
            </>
          )}

          {filteredRecentDirs.length > 0 && (
            <>
              {workingDir && <DropdownMenuSeparator />}
              <DropdownMenuLabel className="py-1.5 text-xs font-medium text-text-secondary">
                {intl.formatMessage(i18n.recentDirectories)}
              </DropdownMenuLabel>
              {filteredRecentDirs.map((dir) => (
                <DropdownMenuItem
                  className="rounded-lg py-2"
                  key={`recent-${dir}`}
                  onSelect={() => void handleSelectDirectory(dir)}
                >
                  <Folder className="size-4" />
                  <DirNameLabel dir={dir} />
                </DropdownMenuItem>
              ))}
            </>
          )}
        </div>
        {(workingDir || filteredRecentDirs.length > 0) && (
          <DropdownMenuSeparator className="shrink-0" />
        )}
        <DropdownMenuItem
          className="shrink-0 rounded-lg py-2"
          onSelect={() => void handleDirectoryChange()}
        >
          <Plus className="size-4" />
          <span>{intl.formatMessage(i18n.chooseDirectory)}</span>
        </DropdownMenuItem>
        {workingDir && (
          <DropdownMenuItem
            className="shrink-0 rounded-lg py-2"
            onSelect={() => void window.electron.openDirectoryInExplorer(workingDir)}
          >
            <FolderOpen className="size-4" />
            <span>{intl.formatMessage(i18n.openInFinder)}</span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const creator = creating && <ProjectCreator onClose={() => setCreating(false)} onCreated={applyDirectoryChange} />;
  if (!allowClear || sessionId) return <>{picker}{creator}</>;
  return (
    <span className="group/workspace relative inline-flex max-w-full rounded-lg hover:bg-background-tertiary/60 focus-within:bg-background-tertiary/60">
      {picker}
      {creator}
      {canClear && (
        <button
          type="button"
          aria-label={intl.formatMessage(i18n.clearWorkspace)}
          title={intl.formatMessage(i18n.clearWorkspace)}
          className="pointer-events-none absolute inset-y-0 left-0 grid w-8 place-items-center rounded-lg text-text-secondary opacity-0 group-hover/workspace:pointer-events-auto group-hover/workspace:opacity-100 group-focus-within/workspace:pointer-events-auto group-focus-within/workspace:opacity-100 hover:text-text-primary focus-visible:outline-2"
          onClick={() => {
            setIsMenuOpen(false);
            triggerRef.current?.focus();
            void onWorkingDirChange?.('');
          }}
        >
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </span>
  );
};
