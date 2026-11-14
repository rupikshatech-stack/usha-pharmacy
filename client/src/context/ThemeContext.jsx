import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const KEY = 'usha:theme';
const ThemeCtx = createContext({ theme: 'light', toggle: () => {} });
export const useTheme = () => useContext(ThemeCtx);

const initial = () => document.documentElement.classList.contains('dark') ? 'dark' : 'light';

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(initial);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  const toggle = useCallback(() => {
    const root = document.documentElement;
    root.classList.add('theme-anim');
    setTimeout(() => root.classList.remove('theme-anim'), 300);
    setTheme((t) => {
      const next = t === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(KEY, next);
      } catch {
        /* storage unavailable — theme still applies for this session */
      }
      return next;
    });
  }, []);

  const value = useMemo(() => ({ theme, toggle }), [theme, toggle]);
  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}
