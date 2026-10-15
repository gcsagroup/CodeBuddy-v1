import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { resolveCodeProEntryPath } from './unifiedMode';

interface CodeProRouteGuardProps {
  children: ReactNode;
  unifiedMode: boolean;
}

export function CodeProRouteGuard({ children, unifiedMode }: CodeProRouteGuardProps) {
  const location = useLocation();
  const pathname = resolveCodeProEntryPath(location.pathname, unifiedMode);

  if (pathname !== location.pathname) {
    return (
      <Navigate
        replace
        state={location.state}
        to={{ pathname, search: location.search, hash: location.hash }}
      />
    );
  }

  return children;
}
