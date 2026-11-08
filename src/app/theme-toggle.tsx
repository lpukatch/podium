'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  applyTheme,
  getStoredTheme,
  menuFocusIndex,
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
  const triggerRef = useRef<HTMLButtonElement>(null);

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

  // Opening moves focus to the current theme's item, so the keyboard pattern
  // the menu roles promise works from the first keystroke.
  useEffect(() => {
    if (!open) return;
    const items = containerRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    const current = OPTIONS.findIndex((option) => option.id === theme);
    const target = items?.[Math.max(current, 0)];
    target?.focus();
  }, [open, theme]);

  // Close on pointer down outside. Focus stays where the click landed.
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: MouseEvent | TouchEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
    };
  }, [open]);

  // Menu keyboard pattern: ArrowUp/Down cycle, Home/End jump, Tab closes and
  // moves on naturally, Escape closes and returns focus to the toggle.
  const handleMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (e.key === 'Tab') {
      setOpen(false);
      return;
    }
    const items = containerRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    if (!items || items.length === 0) return;
    const current = Array.from(items).indexOf(document.activeElement as HTMLButtonElement);
    const next = menuFocusIndex(current, e.key, items.length);
    if (next >= 0) {
      e.preventDefault();
      items[next]?.focus();
    }
  };

  const selectTheme = (next: Theme) => {
    setTheme(next);
    setStoredTheme(next);
    applyTheme(next);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const CurrentIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;
  const currentLabel = theme === 'dark' ? 'Dark' : theme === 'light' ? 'Light' : 'System';

  return (
    <div ref={containerRef} className="relative flex-none" onKeyDown={handleMenuKeyDown}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] text-[var(--color-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-ink)] transition-colors"
        title={`Theme: ${currentLabel}`}
        aria-label={`Theme: ${currentLabel}. Click to change theme.`}
        aria-expanded={open}
        aria-haspopup="menu"
        ref={triggerRef}
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
