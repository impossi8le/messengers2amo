import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compileString } from 'sass';
import { describe, expect, it } from 'vitest';

// jsdom has no layout/paint engine. Check the actual compiled theme tokens,
// not computed colors from jsdom (which cannot prove visual WCAG compliance).
const source = readFileSync(resolve(process.cwd(), 'src/styles/global.scss'), 'utf8');
const css = compileString(source, { loadPaths: [resolve(process.cwd(), 'src/styles')] }).css;
const roots = [...css.matchAll(/:root\s*\{([^}]+)\}/g)];
const light = Object.fromEntries([...((roots[0]?.[1] ?? '').matchAll(/--([\w-]+):\s*(#[\da-f]{6});/gi))]
  .map((match) => [match[1]!, match[2]!]));
const dark = { ...light, ...Object.fromEntries([...((roots[1]?.[1] ?? '').matchAll(/--([\w-]+):\s*(#[\da-f]{6});/gi))]
  .map((match) => [match[1]!, match[2]!])) };

function luminance(hex: string): number {
  const rgb = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
}

const pairs = [
  ['text', 'bg'], ['text', 'surface'], ['text', 'surface-muted'],
  ['text-muted', 'bg'], ['text-muted', 'surface'], ['text-muted', 'surface-muted'],
  ['accent', 'surface'], ['accent-contrast', 'accent'],
  ['danger', 'danger-bg'], ['warning', 'warning-bg'], ['success', 'success-bg'],
  ['danger', 'surface'],
] as const;

describe.each([['light', light], ['dark', dark]] as const)('%s: контраст токенов темы', (_name, tokens) => {
  it.each(pairs)('%s на %s >= 4.5:1', (foreground, background) => {
    expect(tokens[foreground]).toMatch(/^#[\da-f]{6}$/i);
    expect(tokens[background]).toMatch(/^#[\da-f]{6}$/i);
    const a = luminance(tokens[foreground]!);
    const b = luminance(tokens[background]!);
    expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toBeGreaterThanOrEqual(4.5);
  });
});
