/* global Element */
import { createContext } from 'react';

// Only an auto-following ScrollArea owns this choice. Standalone disclosures
// and ordinary scroll areas keep their existing expansion behavior.
export const ScrollFollowingContext = createContext(true);

// Temporary layout anchoring, owned by the existing chat viewport. It does not
// change the user's follow/read choice or any execution state.
export const ScrollLayoutAnchorContext = createContext<((element: Element) => () => void) | null>(
  null
);
