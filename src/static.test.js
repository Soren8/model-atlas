import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Guards the /favicon.ico 404: the single-page site must declare an inline
// icon so browsers never request a separate file from nginx.
describe('site chrome', () => {
  it('declares an inline favicon so no separate file is requested', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf-8');

    expect(html).toMatch(/<link[^>]+rel=["']icon["'][^>]*href=["']data:/);
  });

  it('exposes the off-by-default subscription toggle with use control and methodology', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf-8');

    expect(html).toMatch(/id=["']deals-toggle["']/);
    expect(html).toMatch(/id=["']deals-util["']/);
    expect(html).not.toMatch(/id=["']deals-toggle["'][^>]*checked/);
    expect(html).toMatch(/Subscription estimates/);
    expect(html).not.toMatch(/Go only/);
    expect(html).not.toMatch(/Deals \(estimates\)/);
    expect(html).toMatch(/Contributor \(always on\)/);
    expect(html).toMatch(/quota-equiv/);
    expect(html).toMatch(/Claude Max \$200 ~40x est\./);
    expect(html).toMatch(/ChatGPT Pro\/Codex \$200 ~70x est\./);
    expect(html).toMatch(/Cursor Ultra \$200 ~2x est\./);
    expect(html).toMatch(/lab-wide workload proxy/);
    expect(html).toMatch(/2026-09-24/);
  });

  it('exposes the default-checked $200+ exclusion next to the off-by-default subscription toggle', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf-8');

    expect(html).toMatch(/Exclude \$200\+ tiers/);
    expect(html).toMatch(/id=["']deals-exclude-high["'][^>]*checked|checked[^>]*id=["']deals-exclude-high["']/);
    // Adjacent to the subscription toggle in the same control group.
    expect(html.indexOf('id="deals-toggle"')).toBeLessThan(html.indexOf('id="deals-exclude-high"'));
    expect(html.indexOf('id="deals-exclude-high"')).toBeLessThan(html.indexOf('id="deals-util"'));
    // Tooltip clarifies the monthly plan fee is filtered, not the Go quota amount.
    expect(html).toMatch(/monthly plan fee/i);
    expect(html).toMatch(/quota amounts/i);
    expect(html).toMatch(/Go \$30\/\$60/);
  });

  it('exposes the default-off Log scale toggle with accurate axis copy', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf-8');

    const toggle = html.match(/<input\b[^>]*id=["']log-scale["'][^>]*>/)?.[0];
    expect(toggle).toBeDefined();
    expect(toggle).not.toMatch(/\bchecked\b/);
    expect(html).toMatch(/Log scale/);
    // Hint and methodology name the toggle and keep intelligence linear.
    expect(html).toMatch(/Log scale\s*toggle/);
    expect(html).toMatch(/intelligence is always linear/);
    expect(html).toMatch(/arithmetic on linear/);
    // Archive-era speed provenance is documented, not a generic gap note.
    expect(html).toMatch(/observation date/);
    expect(html).toMatch(/not synchronized to the snapshot date/);
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
