export type Theme = 'system' | 'light' | 'dark';

export const THEME_STORAGE_KEY = 'podium-theme';

export function parseTheme(value: unknown): Theme {
  if (value === 'light' || value === 'dark') {
    return value;
  }
  return 'system';
}

/**
 * Next focused index for a vertical menu: ArrowDown/ArrowUp cycle with
 * wraparound, Home/End jump to the ends. `current` may be -1 when focus has
 * not entered the items yet. Returns -1 for keys it does not handle.
 */
export function menuFocusIndex(current: number, key: string, count: number): number {
  if (count === 0) return -1;
  if (current < 0) {
    if (key === 'ArrowDown' || key === 'Home') return 0;
    if (key === 'ArrowUp' || key === 'End') return count - 1;
    return -1;
  }
  switch (key) {
    case 'ArrowDown':
      return (current + 1) % count;
    case 'ArrowUp':
      return (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return -1;
  }
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
