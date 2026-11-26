/**
 * Shared constants and utilities for extension error handling
 */


/**
 * Creates recovery hints for the "Ask goose" feature when extension loading fails
 */
export function createExtensionRecoverHints(errorMsg: string): string {
  return (
    `Explain the following error: ${errorMsg}. ` +
    'This happened while loading an MCP extension. Diagnose the supplied error and distinguish local dependencies, configuration, connection and tool discovery failures. Do not assume a model or network fault.'
  );
}

/**
 * Preserve bounded, sanitized runtime diagnostics; scrolling belongs to the UI.
 * @param errorMsg - The full error message
 * @param fallback - The fallback message to show if the error is empty
 * @returns The formatted error message
 */
export function formatExtensionErrorMessage(
  errorMsg: string,
  fallback: string = 'Failed to add extension'
): string {
  return errorMsg.trim() || fallback;
}
