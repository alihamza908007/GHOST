import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { redactScreenshotBuffer, collectSensitiveRects } from '../src/redaction.js';

describe('@ghost/engine redaction', () => {
  it('leaves image unchanged when no rects', async () => {
    const buf = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'white' } }).png().toBuffer();
    const out = await redactScreenshotBuffer(buf, []);
    expect(out.equals(buf)).toBe(true);
  });

  it('masks the specified region', async () => {
    const buf = await sharp({ create: { width: 20, height: 20, channels: 3, background: 'white' } }).png().toBuffer();
    const out = await redactScreenshotBuffer(buf, [{ x: 5, y: 5, width: 5, height: 5 }]);
    expect(out.equals(buf)).toBe(false);
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    const idx = (5 * info.width + 5) * info.channels;
    expect(data[idx]).toBe(0);
    expect(data[idx + 1]).toBe(0);
    expect(data[idx + 2]).toBe(0);
  });

  it('throws on invalid image buffer (fail closed)', async () => {
    await expect(redactScreenshotBuffer(Buffer.from('not an image'), [{ x: 0, y: 0, width: 1, height: 1 }])).rejects.toThrow();
  });

  it('collectSensitiveRects returns rects for password inputs (real browser)', async () => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true, channel: 'chrome' });
    const page = await browser.newPage();
    await page.setContent('<input type="password" id="pw" style="position:absolute;left:10px;top:20px;width:100px;height:30px;"/>');
    const rects = await collectSensitiveRects(page);
    await browser.close();
    expect(rects.length).toBe(1);
    expect(rects[0].width).toBeGreaterThan(0);
  });
});
