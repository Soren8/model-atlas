import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Guards the /favicon.ico 404: the single-page site must declare an inline
// icon so browsers never request a separate file from nginx.
describe('site chrome', () => {
  it('declares an inline favicon so no separate file is requested', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf-8');

    expect(html).toMatch(/<link[^>]+rel=["']icon["'][^>]*href=["']data:/);
  });

  it('exposes the off-by-default subscription toggle with quota-use control and methodology', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf-8');

    expect(html).toMatch(/id=["']deals-toggle["']/);
    expect(html).toMatch(/id=["']deals-util["']/);
    expect(html).not.toMatch(/id=["']deals-toggle["'][^>]*checked/);
    expect(html).toMatch(/Subscription estimates \(Go only\)/);
    expect(html).not.toMatch(/Deals \(estimates\)/);
    expect(html).toMatch(/Contributor \(always on\)/);
    expect(html).toMatch(/quota-equiv/);
    expect(html).toMatch(/2026-09-24/);
  });

  it('keeps the hover card inside the chart with a corner pointer', () => {
    const css = readFileSync(new URL('./style.css', import.meta.url), 'utf-8');

    // Long deal text scrolls inside the card so clamping keeps it off the dot.
    expect(css).toMatch(/\.chart-hover-tooltip\s*\{[^}]*max-height/);
    expect(css).toMatch(/\.chart-hover-tooltip\s*\{[^}]*overflow-y:\s*auto/);
    // Pointer sits at the corner nearest the dot, not inset toward empty space.
    expect(css).toMatch(/bottom-right"[^}]*left:\s*-6px/);
    expect(css).toMatch(/bottom-left"[^}]*right:\s*-6px/);
    expect(css).toMatch(/top-right"[^}]*left:\s*-6px/);
    expect(css).toMatch(/top-left"[^}]*right:\s*-6px/);
  });
});
