import { describe, expect, it } from 'vitest';
import { applyTheme, menuFocusIndex, parseTheme, type ThemeTarget } from './theme';

describe('theme parsing', () => {
  it('parses valid themes', () => {
    expect(parseTheme('light')).toBe('light');
    expect(parseTheme('dark')).toBe('dark');
  });

  it('defaults invalid or null values to system', () => {
    expect(parseTheme('system')).toBe('system');
    expect(parseTheme(null)).toBe('system');
    expect(parseTheme(undefined)).toBe('system');
    expect(parseTheme('unknown')).toBe('system');
    expect(parseTheme(123)).toBe('system');
  });
});

describe('theme application', () => {
  const createMockTarget = (): ThemeTarget & { attrs: Record<string, string> } => {
    const attrs: Record<string, string> = {};
    return {
      attrs,
      setAttribute(name: string, value: string) {
        attrs[name] = value;
      },
      removeAttribute(name: string) {
        delete attrs[name];
      },
    };
  };

  it('sets data-theme attribute for light and dark', () => {
    const el = createMockTarget();
    applyTheme('light', el);
    expect(el.attrs['data-theme']).toBe('light');

    applyTheme('dark', el);
    expect(el.attrs['data-theme']).toBe('dark');
  });

  it('removes data-theme attribute for system', () => {
    const el = createMockTarget();
    el.attrs['data-theme'] = 'dark';

    applyTheme('system', el);
    expect('data-theme' in el.attrs).toBe(false);
  });
});

describe('menu focus', () => {
  it('moves down with wraparound', () => {
    expect(menuFocusIndex(0, 'ArrowDown', 3)).toBe(1);
    expect(menuFocusIndex(1, 'ArrowDown', 3)).toBe(2);
    expect(menuFocusIndex(2, 'ArrowDown', 3)).toBe(0);
  });

  it('moves up with wraparound', () => {
    expect(menuFocusIndex(2, 'ArrowUp', 3)).toBe(1);
    expect(menuFocusIndex(0, 'ArrowUp', 3)).toBe(2);
  });

  it('jumps to the ends on Home and End', () => {
    expect(menuFocusIndex(1, 'Home', 3)).toBe(0);
    expect(menuFocusIndex(1, 'End', 3)).toBe(2);
  });

  it('lands on a real item when focus has not entered yet', () => {
    expect(menuFocusIndex(-1, 'ArrowDown', 3)).toBe(0);
    expect(menuFocusIndex(-1, 'ArrowUp', 3)).toBe(2);
    expect(menuFocusIndex(-1, 'Home', 3)).toBe(0);
    expect(menuFocusIndex(-1, 'End', 3)).toBe(2);
  });

  it('ignores keys it does not handle and empty menus', () => {
    expect(menuFocusIndex(1, 'ArrowLeft', 3)).toBe(-1);
    expect(menuFocusIndex(1, 'a', 3)).toBe(-1);
    expect(menuFocusIndex(0, 'ArrowDown', 0)).toBe(-1);
  });
});
