import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { defaultTypography, readTypography, type Typography } from '../utils/typography';

const TypographyContext = createContext<Typography>(defaultTypography);
export const useTypography = () => useContext(TypographyContext);

export function TypographyProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState(defaultTypography);
  useEffect(() => {
    let acceptInitial = true;
    const unsubscribe = window.electron.on('typography-changed', (_event, value) => {
      if (!value || typeof value !== 'object') return;
      acceptInitial = false;
      setPreferences(readTypography(value));
    });
    Promise.all([
      window.electron.getSetting('windowZoom'),
      window.electron.getSetting('textSize'),
      window.electron.getSetting('codeFontSize'),
      window.electron.getSetting('uiFont'),
    ]).then(([windowZoom, textSize, codeFontSize, uiFont]) => {
      if (acceptInitial) setPreferences(readTypography({ windowZoom, textSize, codeFontSize, uiFont }));
    });
    return () => {
      acceptInitial = false;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    // The desktop uses 0.875rem for its standard body copy.
    document.documentElement.style.fontSize = (preferences.textSize / 0.875) + 'px';
    document.body.dataset.uiFont = preferences.uiFont;
    document.body.style.setProperty('--code-font-size', preferences.codeFontSize + 'px');
  }, [preferences]);

  return <TypographyContext.Provider value={preferences}>{children}</TypographyContext.Provider>;
}
