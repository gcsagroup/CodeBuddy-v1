import type { MessageDescriptor } from 'react-intl';
import type { CodeProWorkspaceState } from '../../codepro/projectWorkspace';
import { defineMessages } from '../../i18n';

export const workspaceConfirmationMessages = defineMessages({
  title: {
    id: 'workspaceConfirmation.title',
    defaultMessage: 'Confirm project workspace',
  },
  existingProjectTitle: {
    id: 'workspaceConfirmation.existingProjectTitle',
    defaultMessage: 'Choose this conversation’s project',
  },
  description: {
    id: 'workspaceConfirmation.description',
    defaultMessage: 'CodePro will edit and test files directly in the confirmed directory.',
  },
  existingProjectDescription: {
    id: 'workspaceConfirmation.existingProjectDescription',
    defaultMessage:
      'This folder already contains files. Use this folder to work on those files, or create a separate project to start independently.',
  },
  sharedProjectEffects: {
    id: 'workspaceConfirmation.sharedProjectEffects',
    defaultMessage:
      'File changes and Git operations will take place in this folder. Project memory is grouped by this folder.',
  },
  rootDescription: {
    id: 'workspaceConfirmation.rootDescription',
    defaultMessage: 'Confirming this root does not grant permission to write anywhere on it.',
  },
  candidateGroup: {
    id: 'workspaceConfirmation.candidateGroup',
    defaultMessage: 'Workspace candidates',
  },
  executionBoundary: {
    id: 'workspaceConfirmation.executionBoundary',
    defaultMessage: 'Execution boundaries',
  },
  localDirectory: {
    id: 'workspaceConfirmation.localDirectory',
    defaultMessage: 'Local project directory',
  },
  writableRootLabel: {
    id: 'workspaceConfirmation.writableRootLabel',
    defaultMessage: 'Writable root',
  },
  noWritableRoot: {
    id: 'workspaceConfirmation.noWritableRoot',
    defaultMessage: 'None',
  },
  resolvedPathLabel: {
    id: 'workspaceConfirmation.resolvedPathLabel',
    defaultMessage: 'Resolved location',
  },
  worktreeOff: {
    id: 'workspaceConfirmation.worktreeOff',
    defaultMessage: 'Worktree isolation: Off',
  },
  gitRepository: {
    id: 'workspaceConfirmation.gitRepository',
    defaultMessage: 'Git repository detected',
  },
  cancel: { id: 'workspaceConfirmation.cancel', defaultMessage: 'Cancel' },
  confirm: {
    id: 'workspaceConfirmation.confirm',
    defaultMessage: 'Confirm and start',
  },
  continueExistingProject: {
    id: 'workspaceConfirmation.continueExistingProject',
    defaultMessage: 'Use this folder',
  },
  createSeparateProject: {
    id: 'workspaceConfirmation.createSeparateProject',
    defaultMessage: 'Create a separate project',
  },
  confirmContainer: {
    id: 'workspaceConfirmation.confirmContainer',
    defaultMessage: 'Confirm container',
  },
  starting: { id: 'workspaceConfirmation.starting', defaultMessage: 'Starting…' },
  checkingPersistedWorkspace: {
    id: 'workspaceConfirmation.checkingPersistedWorkspace',
    defaultMessage: 'Checking the persisted workspace…',
  },
  persistedWorkspaceMismatch: {
    id: 'workspaceConfirmation.persistedWorkspaceMismatch',
    defaultMessage: 'The persisted workspace no longer matches the inspected directory.',
  },
  persistedWorkspaceUnavailable: {
    id: 'workspaceConfirmation.persistedWorkspaceUnavailable',
    defaultMessage: 'The persisted workspace is unavailable.',
  },
  stateMissing: {
    id: 'workspaceConfirmation.state.missing',
    defaultMessage: 'This directory does not exist. It will be created only after confirmation.',
  },
  stateEmptyDirectory: {
    id: 'workspaceConfirmation.state.emptyDirectory',
    defaultMessage: 'Existing empty directory',
  },
  stateNonEmptyDirectory: {
    id: 'workspaceConfirmation.state.nonEmptyDirectory',
    defaultMessage: 'Existing directory with files',
  },
  stateFilesystemRoot: {
    id: 'workspaceConfirmation.state.filesystemRoot',
    defaultMessage: 'Drive root selected as a container only',
  },
  stateFile: {
    id: 'workspaceConfirmation.state.file',
    defaultMessage: 'The selected path is a file, not a directory',
  },
  stateUnavailable: {
    id: 'workspaceConfirmation.state.unavailable',
    defaultMessage: 'The directory cannot be inspected',
  },
});

export const workspaceStateMessages: Record<CodeProWorkspaceState, MessageDescriptor> = {
  missing: workspaceConfirmationMessages.stateMissing,
  'empty-directory': workspaceConfirmationMessages.stateEmptyDirectory,
  'non-empty-directory': workspaceConfirmationMessages.stateNonEmptyDirectory,
  'filesystem-root': workspaceConfirmationMessages.stateFilesystemRoot,
  file: workspaceConfirmationMessages.stateFile,
  unavailable: workspaceConfirmationMessages.stateUnavailable,
};
