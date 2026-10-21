import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, FolderDot, FolderOpen, GitBranch, Plus } from 'lucide-react';
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

const i18n = defineMessages({
  failedToUpdateWorkingDir: {
    id: 'dirSwitcher.failedToUpdateWorkingDir',
    defaultMessage: 'Failed to update working directory',
  },
  currentDirectory: {
    id: 'dirSwitcher.currentDirectory',
    defaultMessage: 'Current directory',
  },
  gitWorktrees: {
    id: 'dirSwitcher.gitWorktrees',
    defaultMessage: 'Git worktrees',
  },
  recentDirectories: {
    id: 'dirSwitcher.recentDirectories',
    defaultMessage: 'Recent directories',
  },
  chooseDirectory: {
    id: 'dirSwitcher.chooseDirectory',
    defaultMessage: 'Choose directory…',
  },
  chooseFolder: {
    id: 'dirSwitcher.chooseFolder',
    defaultMessage: 'Choose a folder',
  },
  openInFinder: {
    id: 'dirSwitcher.openInFinder',
    defaultMessage: 'Open in file manager',
  },
  noWorktreesFound: {
    id: 'dirSwitcher.noWorktreesFound',
    defaultMessage: 'No worktrees found',
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
      <span className="truncate text-sm text-text-primary">{name}</span>
      {parent && <span className="truncate text-xs text-text-secondary/70">{parent}</span>}
    </div>
  );
};

interface DirSwitcherProps {
  className: string;
  sessionId: string | undefined;
  workingDir: string;
  onWorkingDirChange?: (newDir: string) => Promise<void> | void;
  onRestartStart?: () => void;
  onRestartEnd?: () => void;
}

export const DirSwitcher: React.FC<DirSwitcherProps> = ({
  className,
  sessionId,
  workingDir,
  onWorkingDirChange,
  onRestartStart,
  onRestartEnd,
}) => {
  const intl = useIntl();
  const [isDirectoryChooserOpen, setIsDirectoryChooserOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [recentDirs, setRecentDirs] = useState<string[]>([]);
  const [worktreeDirs, setWorktreeDirs] = useState<string[]>([]);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const refreshVersionRef = useRef(0);

  const refreshMenuData = useCallback(async () => {
    const version = ++refreshVersionRef.current;
    setRecentDirs([]);
    setWorktreeDirs([]);

    const [recent, worktrees] = await Promise.all([
      window.electron.listRecentDirs().catch(() => []),
      workingDir ? window.electron.listGitWorktreeDirs(workingDir).catch(() => []) : [],
    ]);

    if (version !== refreshVersionRef.current) return;

    setRecentDirs(recent);
    setWorktreeDirs(worktrees);
  }, [workingDir]);

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

  const filteredWorktreeDirs = useMemo(
    () => worktreeDirs.filter((dir) => dir && dir !== workingDir),
    [worktreeDirs, workingDir]
  );

  const filteredRecentDirs = useMemo(
    () => recentDirs.filter((dir) => dir && dir !== workingDir),
    [recentDirs, workingDir]
  );

  return (
    <DropdownMenu open={isMenuOpen} onOpenChange={setIsMenuOpen} modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          ref={triggerRef}
          className={`z-[100] ${isDirectoryChooserOpen ? 'opacity-50' : 'hover:cursor-pointer hover:text-text-primary'} min-w-0 text-text-primary/70 text-xs flex items-center gap-1 transition-colors px-1 min-h-7 ${className}`}
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
          <FolderDot className="size-4 shrink-0" aria-hidden="true" />
          <div className="max-w-[200px] truncate group-data-[compact=true]/composer-toolbar:hidden">
            {workingDir
              ? workingDir
                  .replace(/[\\/]+$/, '')
                  .split(/[\\/]/)
                  .pop() || workingDir
              : intl.formatMessage(i18n.chooseFolder)}
          </div>
          <DropdownChevron
            open={isMenuOpen}
            className="size-3 group-data-[compact=true]/composer-toolbar:hidden"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="w-[28rem]"
        side="top"
        align="start"
        onInteractOutside={(event) => {
          // The trigger handles its own toggle after click; do not dismiss it on pointer-down.
          if (event.target instanceof Node && triggerRef.current?.contains(event.target)) {
            event.preventDefault();
          }
        }}
      >
        {workingDir && (
          <>
            <DropdownMenuLabel>{intl.formatMessage(i18n.currentDirectory)}</DropdownMenuLabel>
            <DropdownMenuItem
              onSelect={() => void window.electron.openDirectoryInExplorer(workingDir)}
            >
              <FolderOpen className="mr-2 h-4 w-4 flex-shrink-0" />
              <DirNameLabel dir={workingDir} />
              <Check className="ml-auto h-4 w-4 flex-shrink-0" />
            </DropdownMenuItem>

            <DropdownMenuSeparator />
            <DropdownMenuLabel>{intl.formatMessage(i18n.gitWorktrees)}</DropdownMenuLabel>
            {filteredWorktreeDirs.length > 0 ? (
              filteredWorktreeDirs.map((dir) => (
                <DropdownMenuItem
                  key={`worktree-${dir}`}
                  onSelect={() => void handleSelectDirectory(dir)}
                >
                  <GitBranch className="mr-2 h-4 w-4 flex-shrink-0" />
                  <DirNameLabel dir={dir} />
                </DropdownMenuItem>
              ))
            ) : (
              <DropdownMenuItem disabled>
                <GitBranch className="mr-2 h-4 w-4" />
                <span>{intl.formatMessage(i18n.noWorktreesFound)}</span>
              </DropdownMenuItem>
            )}
          </>
        )}

        {filteredRecentDirs.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{intl.formatMessage(i18n.recentDirectories)}</DropdownMenuLabel>
            {filteredRecentDirs.map((dir) => (
              <DropdownMenuItem
                key={`recent-${dir}`}
                onSelect={() => void handleSelectDirectory(dir)}
              >
                <FolderDot className="mr-2 h-4 w-4 flex-shrink-0" />
                <DirNameLabel dir={dir} />
              </DropdownMenuItem>
            ))}
          </>
        )}

        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void handleDirectoryChange()}>
          <Plus className="mr-2 h-4 w-4" />
          <span>{intl.formatMessage(i18n.chooseDirectory)}</span>
        </DropdownMenuItem>
        {workingDir && (
          <DropdownMenuItem
            onSelect={() => void window.electron.openDirectoryInExplorer(workingDir)}
          >
            <FolderOpen className="mr-2 h-4 w-4" />
            <span>{intl.formatMessage(i18n.openInFinder)}</span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
