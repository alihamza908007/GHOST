import sharp from 'sharp';
import type { Page } from 'playwright';
import { PolicyViolationError } from './errors.js';

export interface SensitiveRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const SENSITIVE_NAME = /password|passwd|pwd|secret|token|apikey|api[_-]?key|otp|cvv|cvc|ssn|credit.?card|card.?number/i;

/**
 * Collect bounding rectangles (in document coordinates) of inputs that look
 * sensitive. Runs entirely inside the trusted browser context; no model or
 * page-supplied script is involved.
 */
export async function collectSensitiveRects(page: Page): Promise<SensitiveRect[]> {
  return (await page.evaluate((patternSource: string) => {
    const re = new RegExp(patternSource, 'i');
    const els = Array.from(document.querySelectorAll('input, textarea, select'));
    const out: SensitiveRect[] = [];
    const sx = window.scrollX || 0;
    const sy = window.scrollY || 0;
    for (const el of els) {
      const type = (el.getAttribute('type') || '').toLowerCase();
      const auto = (el.getAttribute('autocomplete') || '').toLowerCase();
      const name = (el.getAttribute('name') || el.getAttribute('id') || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').toLowerCase();
      const sensitive =
        type === 'password' ||
        auto.includes('password') ||
        auto.includes('current-password') ||
        auto.includes('new-password') ||
        auto.includes('one-time-code') ||
        auto.includes('cc-number') ||
        auto.includes('cc-csc') ||
        re.test(name) ||
        re.test(auto);
      if (!sensitive) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      out.push({
        x: Math.max(0, r.left + sx),
        y: Math.max(0, r.top + sy),
        width: r.width,
        height: r.height,
      });
    }
    return out;
  }, SENSITIVE_NAME.source)) as SensitiveRect[];
}

/**
 * Mask the given rectangles in a PNG/JPEG buffer. Returns the redacted buffer.
 * Throws on any processing failure (fail closed).
 */
export async function redactScreenshotBuffer(
  buffer: Buffer,
  rects: SensitiveRect[]
): Promise<Buffer> {
  if (rects.length === 0) return buffer;
  const img = sharp(buffer);
  const meta = await img.metadata();
  if (!meta.width || !meta.height) {
    throw new PolicyViolationError('INVALID_ACTION', 'Screenshot metadata is unavailable for redaction');
  }
  const scaleX = meta.width / Math.max(1, /* viewport width unknown; assume 1:1 */ 1);
  // Build an SVG overlay with black rectangles. Coordinates are in image pixels.
  const svgRects = rects
    .map((r) => {
      const x = Math.round(r.x);
      const y = Math.round(r.y);
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      // Add a small padding to cover anti-aliased edges.
      const pad = 2;
      return `<rect x="${Math.max(0, x - pad)}" y="${Math.max(0, y - pad)}" width="${w + pad * 2}" height="${h + pad * 2}" fill="black"/>`;
    })
    .join('');
  const svg = Buffer.from(
    `<svg width="${meta.width}" height="${meta.height}" xmlns="http://www.w3.org/2000/svg">${svgRects}</svg>`
  );
  const out = await img
    .composite([{ input: svg, top: 0, left: 0 }])
    .png()
    .toBuffer();
  return out;
}

/**
 * High-level helper: collect sensitive rects from the page and redact the
 * screenshot buffer. Throws on failure (fail closed).
 */
export async function redactScreenshot(page: Page, buffer: Buffer, enabled: boolean): Promise<Buffer> {
  if (!enabled) return buffer;
  let rects: SensitiveRect[] = [];
  try {
    rects = await collectSensitiveRects(page);
  } catch {
    // If we cannot determine sensitive regions, fail closed.
    throw new PolicyViolationError('INVALID_ACTION', 'Sensitive-region detection failed; screenshot not saved');
  }
  if (rects.length === 0) return buffer;
  try {
    return await redactScreenshotBuffer(buffer, rects);
  } catch {
    throw new PolicyViolationError('INVALID_ACTION', 'Screenshot redaction failed; screenshot not saved');
  }
}
