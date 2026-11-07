'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  applyTheme,
  getStoredTheme,
  parseTheme,
  setStoredTheme,
  THEME_STORAGE_KEY,
  type Theme,
} from './theme';

const OPTIONS: Array<{ id: Theme; label: string; icon: typeof Sun }> = [
  { id: 'system', label: 'System', icon: Monitor },
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
];

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTheme(getStoredTheme());

    const onStorage = (e: StorageEvent) => {
      if (e.key === THEME_STORAGE_KEY) {
        const next = parseTheme(e.newValue);
        setTheme(next);
        applyTheme(next);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const selectTheme = (next: Theme) => {
    setTheme(next);
    setStoredTheme(next);
    applyTheme(next);
    setOpen(false);
  };

  const CurrentIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;
  const currentLabel = theme === 'dark' ? 'Dark' : theme === 'light' ? 'Light' : 'System';

  return (
    <div ref={containerRef} className="relative flex-none">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] text-[var(--color-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-ink)] transition-colors"
        title={`Theme: ${currentLabel}`}
        aria-label={`Theme: ${currentLabel}. Click to change theme.`}
        aria-expanded={open}
        aria-haspopup="true"
      >
        <CurrentIcon className="h-4 w-4" aria-hidden="true" />
      </button>

      {open && (
        <div
          role="menu"
          aria-orientation="vertical"
          className="absolute right-0 mt-1.5 w-32 overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] py-1 shadow-lg z-30"
        >
          {OPTIONS.map(({ id, label, icon: Icon }) => {
            const active = theme === id;
            return (
              <button
                key={id}
                type="button"
                role="menuitem"
                onClick={() => selectTheme(id)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors ${
                  active
                    ? 'bg-[var(--color-accent-soft)] font-semibold text-[var(--color-accent)]'
                    : 'text-[var(--color-ink)] hover:bg-[var(--color-canvas)]'
                }`}
              >
                <Icon className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
                <span className="flex-1">{label}</span>
                {active && (
                  <span className="flex-none text-xs" aria-hidden="true">
                    ✓
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
