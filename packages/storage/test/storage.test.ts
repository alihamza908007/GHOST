import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EvidenceRepository } from '../src/index.js';
import fs from 'fs';
import path from 'path';

describe('@ghost/storage EvidenceRepository', () => {
  const testDir = path.resolve(process.cwd(), 'scratch_test_evidence');

  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('creates directory and verifies evidence paths', () => {
    const repo = new EvidenceRepository(testDir);
    expect(fs.existsSync(testDir)).toBe(true);

    const filename = 'test-file.png';
    const filePath = repo.getFilePath(filename);
    expect(filePath).toBe(path.resolve(testDir, filename));
    expect(repo.exists(filename)).toBe(false);

    fs.writeFileSync(filePath, 'dummy-content');
    expect(repo.exists(filename)).toBe(true);
  });
});
