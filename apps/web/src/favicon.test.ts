import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * favicon раньше отсутствовал, и браузер на каждой странице запрашивал
 * `/favicon.ico`, получая 404. Файл лежит в `public/`, откуда Vite копирует его
 * в корень сборки как есть, — это и проверяем, вместе с объявлением в HTML.
 *
 * Путь считается от корня проекта: в jsdom `import.meta.url` — это адрес
 * dev-сервера, а не путь на диске.
 */
const root = process.cwd();
const indexHtml = readFileSync(resolve(root, 'index.html'), 'utf8');
const faviconSvg = readFileSync(resolve(root, 'public/favicon.svg'), 'utf8');

describe('favicon', () => {
  it('объявлен в index.html как SVG-иконка', () => {
    expect(indexHtml).toMatch(
      /<link[^>]+rel="icon"[^>]+type="image\/svg\+xml"[^>]+href="\/favicon\.svg"/,
    );
  });

  it('задаёт осмысленный заголовок и цвет темы', () => {
    const title = indexHtml.match(/<title>([^<]*)<\/title>/)?.[1]?.trim() ?? '';
    expect(title).not.toBe('');
    expect(title).not.toBe('Vite');
    // Осмысленный заголовок уже был — не переписываем его ради единообразия.
    expect(title.toLowerCase()).toContain('шлюз мессенджеров');
    expect(indexHtml).toMatch(/<meta name="theme-color" content="#2f5d8a"/);
  });

  it('содержит валидный SVG 32×32 без внешних зависимостей', () => {
    expect(faviconSvg).toMatch(/^<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(faviconSvg).toMatch(/width="32"/);
    expect(faviconSvg).toMatch(/height="32"/);
    expect(faviconSvg).toMatch(/viewBox="0 0 32 32"/);
    // Никаких внешних картинок, скриптов и ссылок.
    expect(faviconSvg).not.toMatch(/<script|<image|xlink:href|href="http/);
  });
});
