import { describe, expect, it } from 'vitest';
import { applyTheme, parseTheme, type ThemeTarget } from './theme';

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
