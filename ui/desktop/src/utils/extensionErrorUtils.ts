/**
 * Shared constants and utilities for extension error handling
 */

import type { ExtensionLoadResult } from '../types/extensions';
import { toastService, ExtensionLoadingStatus } from '../toasts';

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

/**
 * Shows toast notifications for extension load results.
 * Uses the same dismissible summary for single and grouped extension results.
 * @param results - Array of extension load results from the backend
 */
export function showExtensionLoadResults(results: ExtensionLoadResult[] | null | undefined): void {
  if (!results || results.length === 0) {
    return;
  }

  // Results are partial session views: an absent extension has not recovered.
  // Healthy peers changing or a different chat selection must not re-announce
  // an unchanged failure. A confirmed recovery re-arms that extension only.
  const failures = results.filter(result => {
    const signature = JSON.stringify([result.success, result.error ?? '']);
    const previous = lastResults.get(result.name);
    lastResults.delete(result.name);
    lastResults.set(result.name, signature);
    return !result.success && previous !== signature;
  });
  while (lastResults.size > 256) lastResults.delete(lastResults.keys().next().value!);
  if (!failures.length) return;
  const extensionStatuses: ExtensionLoadingStatus[] = results.map((r) => {
    const errorMsg = r.error || 'Unknown error';
    return {
      name: r.name,
      status: r.success ? 'success' : 'error',
      error: r.success ? undefined : errorMsg,
      recoverHints: r.success ? undefined : createExtensionRecoverHints(errorMsg),
    };
  });

  toastService.extensionLoading(extensionStatuses, results.length, true);
}

const lastResults = new Map<string, string>();
