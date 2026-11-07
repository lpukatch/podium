export type Theme = 'system' | 'light' | 'dark';

export const THEME_STORAGE_KEY = 'podium-theme';

export function parseTheme(value: unknown): Theme {
  if (value === 'light' || value === 'dark') {
    return value;
  }
  return 'system';
}

export interface ThemeTarget {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

export function applyTheme(theme: Theme, target?: ThemeTarget): void {
  const el = target ?? (typeof document !== 'undefined' ? document.documentElement : undefined);
  if (!el) return;
  if (theme === 'system') {
    el.removeAttribute('data-theme');
  } else {
    el.setAttribute('data-theme', theme);
  }
}

export function getStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'system';
  try {
    return parseTheme(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

export function setStoredTheme(theme: Theme): void {
  if (typeof window === 'undefined') return;
  try {
    if (theme === 'system') {
      localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    }
  } catch {
    // LocalStorage might be restricted/unavailable in private browsing
  }
}
