import type { Location, NavigateFunction } from 'react-router-dom';
import type { Recipe } from '../recipe';
import { UserInput } from '../types/message';

export type View =
  | 'chat'
  | 'pair'
  | 'settings'
  | 'extensions'
  | 'moreModels'
  | 'configureProviders'
  | 'configPage'
  | 'ConfigureProviders'
  | 'settingsV2'
  | 'sessions'
  | 'schedules'
  | 'loading'
  | 'recipes'
  | 'skills'
  | 'toolbox'
  | 'permission';

export type ViewOptions = {
  showEnvVars?: boolean;
  deepLinkConfig?: unknown;
  error?: string;
  recipe?: Recipe;
  parentView?: View;
  parentViewOptions?: ViewOptions;
  disableAnimation?: boolean;
  initialMessage?: UserInput;
  noAutoSubmit?: boolean;
  recipeDeeplink?: string;
  recipeId?: string;
  resumeSessionId?: string;
  pendingScheduleDeepLink?: string;
  section?: string;
  toolboxItemId?: string;
  toolboxProjectDir?: string;
  backgroundLocation?: Location;
};

export type WorkspaceMode = 'code' | 'codepro';

export function getWorkspaceModeFromPath(pathname: string): WorkspaceMode {
  return pathname === '/codepro' || pathname.startsWith('/codepro/') ? 'codepro' : 'code';
}

export function withWorkspaceMode(path: string, workspaceMode: WorkspaceMode): string {
  if (workspaceMode === 'code' || path === '/launcher') {
    return path;
  }
  if (path === '/codepro' || path.startsWith('/codepro/')) {
    return path;
  }
  if (path === '/') {
    return '/codepro';
  }
  return `/codepro${path.startsWith('/') ? path : `/${path}`}`;
}

export const createNavigationHandler = (
  navigate: NavigateFunction,
  workspaceMode: WorkspaceMode = 'code',
  currentLocation?: Location
) => {
  const navigateWithinWorkspace = (path: string, options?: ViewOptions) =>
    navigate(withWorkspaceMode(path, workspaceMode), { state: options });

  return (view: View, options?: ViewOptions) => {
    switch (view) {
      case 'chat':
        navigateWithinWorkspace('/', options);
        break;
      case 'pair': {
        // Put resumeSessionId in URL search params (not just state) so that:
        // 1. The sidebar can read it to highlight the active session
        // 2. Page refresh preserves which session is active
        // 3. Browser back/forward navigation works correctly
        const searchParams = new URLSearchParams();
        if (options?.resumeSessionId) {
          searchParams.set('resumeSessionId', options.resumeSessionId);
        }
        const url = searchParams.toString() ? `/pair?${searchParams.toString()}` : '/pair';
        navigateWithinWorkspace(url, options);
        break;
      }
      case 'settings':
        navigateWithinWorkspace(
          '/settings',
          currentLocation ? { ...options, backgroundLocation: currentLocation } : options
        );
        break;
      case 'sessions':
        navigateWithinWorkspace('/sessions', options);
        break;
      case 'schedules':
        navigateWithinWorkspace('/schedules', options);
        break;
      case 'recipes':
        navigateWithinWorkspace('/recipes', options);
        break;
      case 'skills':
        navigateWithinWorkspace('/skills', options);
        break;
      case 'toolbox':
        navigateWithinWorkspace(
          `/toolbox${options?.toolboxItemId ? `?item=${encodeURIComponent(options.toolboxItemId)}` : ''}`,
          options
        );
        break;
      case 'permission':
        navigateWithinWorkspace('/permission', options);
        break;
      case 'ConfigureProviders':
        navigateWithinWorkspace('/configure-providers', options);
        break;
      case 'extensions':
        navigateWithinWorkspace('/extensions', options);
        break;
      default:
        navigateWithinWorkspace('/', options);
    }
  };
};
