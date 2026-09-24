import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Guards the /favicon.ico 404: the single-page site must declare an inline
// icon so browsers never request a separate file from nginx.
describe('site chrome', () => {
  it('declares an inline favicon so no separate file is requested', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf-8');

    expect(html).toMatch(/<link[^>]+rel=["']icon["'][^>]*href=["']data:/);
  });

  it('exposes the off-by-default Deals toggle with quota-use control and methodology', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf-8');

    expect(html).toMatch(/id=["']deals-toggle["']/);
    expect(html).toMatch(/id=["']deals-util["']/);
    expect(html).not.toMatch(/id=["']deals-toggle["'][^>]*checked/);
    expect(html).toMatch(/quota-equiv/);
    expect(html).toMatch(/2026-09-24/);
  });
});
