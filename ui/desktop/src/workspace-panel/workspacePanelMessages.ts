import { defineMessages } from '../i18n';
export const panelMessages = defineMessages({
  previewMedia: { id: 'workspacePanel.previewMedia', defaultMessage: 'View in right panel' },
  mediaFailed: {
    id: 'workspacePanel.mediaFailed',
    defaultMessage:
      'Media could not be loaded. Reload the preview or check the local file and format.',
  },
  relatedFiles: { id: 'workspacePanel.relatedFiles', defaultMessage: 'Referenced workspace files' },
  openDocument: {
    id: 'workspacePanel.openDocument',
    defaultMessage: 'Open in default application',
  },
  documentInfo: {
    id: 'workspacePanel.documentInfo',
    defaultMessage: 'This document opens in its associated application.',
  },
  restartDesktop: {
    id: 'workspacePanel.restartDesktop',
    defaultMessage: 'Restart CodeBuddy to load this file-opening feature.',
  },
  binaryFile: {
    id: 'workspacePanel.binaryFile',
    defaultMessage:
      '{name} is a binary file or uses an unsupported text encoding. Text preview and editing are unavailable; the file is unchanged.',
  },
  wrap: { id: 'workspacePanel.wrap', defaultMessage: 'Wrap lines' },
  unsaved: { id: 'workspacePanel.unsaved', defaultMessage: 'Unsaved changes' },
  clearTerminal: { id: 'workspacePanel.clearTerminal', defaultMessage: 'Clear terminal display' },
  running: { id: 'workspacePanel.running', defaultMessage: 'Running' },
  exited: { id: 'workspacePanel.exited', defaultMessage: 'Exited' },
  terminalKeys: { id: 'workspacePanel.terminalKeys', defaultMessage: 'Ctrl+C interrupt' },
  loading: { id: 'workspacePanel.loading', defaultMessage: 'Loading' },
  panel: { id: 'workspacePanel.panel', defaultMessage: 'Workspace' },
  start: { id: 'workspacePanel.start', defaultMessage: 'Start' },
  files: { id: 'workspacePanel.files', defaultMessage: 'Workspace files' },
  git: { id: 'workspacePanel.git', defaultMessage: 'Git and review' },
  gitHint: {
    id: 'workspacePanel.gitHint',
    defaultMessage: 'Inspect changes and review this workspace',
  },
  filesHint: {
    id: 'workspacePanel.filesHint',
    defaultMessage: 'Browse files in this session workspace',
  },
  terminal: { id: 'workspacePanel.terminal', defaultMessage: 'New terminal' },
  terminalHint: {
    id: 'workspacePanel.terminalHint',
    defaultMessage: 'Run commands in this session workspace',
  },
  browser: { id: 'workspacePanel.browser', defaultMessage: 'Browser' },
  browserHint: { id: 'workspacePanel.browserHint', defaultMessage: 'Browse web pages' },
  open: { id: 'workspacePanel.open', defaultMessage: 'Open workspace panel' },
  closePanel: { id: 'workspacePanel.closePanel', defaultMessage: 'Collapse panel' },
  close: { id: 'workspacePanel.close', defaultMessage: 'Close' },
  maximize: { id: 'workspacePanel.maximize', defaultMessage: 'Expand or restore panel' },
  resize: { id: 'workspacePanel.resize', defaultMessage: 'Resize workspace panel' },
  noWorkspace: {
    id: 'workspacePanel.noWorkspace',
    defaultMessage: 'Select a workspace and open a conversation to use files and terminals.',
  },
  search: { id: 'workspacePanel.search', defaultMessage: 'Search filenames' },
  fileTree: { id: 'workspacePanel.fileTree', defaultMessage: 'Workspace file tree' },
  searchLimit: {
    id: 'workspacePanel.searchLimit',
    defaultMessage:
      'Results limited. Refine the filename; dependency/build folders are not searched.',
  },
  selectFile: { id: 'workspacePanel.selectFile', defaultMessage: 'Select a file to preview' },
  edit: { id: 'workspacePanel.edit', defaultMessage: 'Edit' },
  preview: { id: 'workspacePanel.preview', defaultMessage: 'Preview' },
  save: { id: 'workspacePanel.save', defaultMessage: 'Save file ({shortcut})' },
  editor: { id: 'workspacePanel.editor', defaultMessage: 'File editor' },
  refresh: { id: 'workspacePanel.refresh', defaultMessage: 'Refresh' },
  reload: { id: 'workspacePanel.reload', defaultMessage: 'Reload file from disk' },
  discard: { id: 'workspacePanel.discard', defaultMessage: 'Discard unsaved edits to this file?' },
  closeTerminal: {
    id: 'workspacePanel.closeTerminal',
    defaultMessage: 'Close this terminal and stop its running commands?',
  },
  back: { id: 'workspacePanel.back', defaultMessage: 'Back' },
  forward: { id: 'workspacePanel.forward', defaultMessage: 'Forward' },
  stop: { id: 'workspacePanel.stop', defaultMessage: 'Stop loading' },
  address: { id: 'workspacePanel.address', defaultMessage: 'Web address' },
  go: { id: 'workspacePanel.go', defaultMessage: 'Open address' },
  enterAddress: {
    id: 'workspacePanel.enterAddress',
    defaultMessage: 'Enter an address above to browse a web page.',
  },
});
