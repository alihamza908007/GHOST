import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveContainedEvidencePath, isSafeEvidenceFilename, EvidencePathError } from '../src/evidence.js';

describe('@ghost/core evidence containment', () => {
  it('accepts a safe filename', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-'));
    const p = resolveContainedEvidencePath(dir, 'shot.png');
    expect(p.startsWith(dir)).toBe(true);
  });

  it('rejects traversal', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-'));
    expect(() => resolveContainedEvidencePath(dir, '../secret.txt')).toThrow(EvidencePathError);
    expect(() => resolveContainedEvidencePath(dir, '..')).toThrow();
    expect(isSafeEvidenceFilename('../secret.txt')).toBe(false);
  });

  it('rejects absolute paths', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-'));
    expect(() => resolveContainedEvidencePath(dir, '/etc/passwd')).toThrow();
    expect(isSafeEvidenceFilename('/etc/passwd')).toBe(false);
  });

  it('rejects unsafe filenames', () => {
    expect(isSafeEvidenceFilename('')).toBe(false);
    expect(isSafeEvidenceFilename('a/b.png')).toBe(false);
    expect(isSafeEvidenceFilename('a\\b.png')).toBe(false);
    expect(isSafeEvidenceFilename('a\0b.png')).toBe(false);
  });

  it('rejects symlink escape (if supported)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    const link = path.join(dir, 'escape');
    try {
      fs.symlinkSync(outside, link);
    } catch {
      return; // symlink not supported
    }
    // A file accessed through the symlinked dir should be rejected
    expect(() => resolveContainedEvidencePath(dir, 'escape/secret.txt')).toThrow(EvidencePathError);
  });
});
