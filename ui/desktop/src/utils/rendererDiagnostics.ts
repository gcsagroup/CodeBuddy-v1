const components = new Set([
  'App',
  'AppLayout',
  'ErrorBoundary',
  'BaseChat',
  'ChatInput',
  'ChatSessionsContainer',
  'ProgressiveMessageList',
  'OrderedMessageList',
  'MessageListContent',
  'GooseMessage',
  'ToolCallWithResponse',
  'ToolCallExpandable',
  'NavigationPanel',
  'ModelsBottomBar',
  'ScrollArea',
  'BottomMenuAlertPopover',
  'RecipeParamsModalContainer',
]);

// Error strings and stacks can contain request bodies, URLs or local paths.
// Construct a shareable observation from fixed categories and numeric positions.
export function rendererDiagnostic(
  error: unknown,
  source: 'react_boundary' | 'window_error' | 'unhandled_rejection',
  componentStack?: string | null
) {
  let message = '',
    stack = '';
  try {
    const rawMessage: unknown =
      typeof error === 'string' ? error : error instanceof Error ? error.message : '';
    const rawStack: unknown = error instanceof Error ? error.stack : '';
    message = typeof rawMessage === 'string' ? rawMessage.slice(0, 4096) : '';
    stack = typeof rawStack === 'string' ? rawStack.slice(0, 32000) : '';
  } catch {
    /* Even a broken diagnostic object must leave recovery available. */
  }
  const depth = /Minified React error #185\b|^Maximum update depth exceeded\b/.test(message);
  const frames = stack
    .split('\n')
    .slice(0, 60)
    .flatMap((line) => {
      if (!/^\s*at\s/.test(line)) return [];
      const position = line.match(/:(\d{1,7}):(\d{1,7})\)?\s*$/);
      return position ? [{ line: Number(position[1]), column: Number(position[2]) }] : [];
    })
    .slice(0, 12);
  const knownComponents = [
    ...new Set(
      (typeof componentStack === 'string' ? componentStack.slice(0, 32000) : '')
        .split('\n')
        .slice(0, 60)
        .flatMap((line) => {
          const name = line.match(/^\s*(?:at\s+)?([A-Za-z_$][\w$]*)/m)?.[1];
          return name && components.has(name) ? [name] : [];
        })
    ),
  ].slice(0, 12);
  return {
    diagnostic_revision: 'renderer-safe-v1',
    source,
    code: depth ? 'REACT_UPDATE_DEPTH' : 'RENDERER_ERROR',
    ...(depth ? { react_error_code: 185 } : {}),
    ...(knownComponents.length ? { components: knownComponents } : {}),
    ...(frames.length ? { stack_positions: frames } : {}),
  };
}
