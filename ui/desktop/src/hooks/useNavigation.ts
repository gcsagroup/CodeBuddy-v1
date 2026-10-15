import { useLocation, useNavigate } from 'react-router-dom';
import { createNavigationHandler } from '../utils/navigationUtils';

/**
 * Custom hook that provides a navigation handler function.
 * Eliminates the repetitive pattern of creating navigation handlers in components.
 *
 * @returns A navigation handler function
 */
export const useNavigation = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const workspaceMode = location.pathname.startsWith('/codepro') ? 'codepro' : 'code';
  return createNavigationHandler(navigate, workspaceMode, location);
};

export type setViewType = ReturnType<typeof useNavigation>;
