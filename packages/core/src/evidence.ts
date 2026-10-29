import fs from 'fs';
import path from 'path';

/**
 * Safe evidence filename pattern. Evidence files live directly in the evidence
 * root; no subdirectories, traversal, or absolute paths are permitted.
 */
export const SAFE_EVIDENCE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

export class EvidencePathError extends Error {
  readonly code = 'EVIDENCE_PATH_UNSAFE';
  constructor(message = 'Evidence path is not contained in the evidence root') {
    super(message);
    this.name = 'EvidencePathError';
  }
}

export function isSafeEvidenceFilename(filename: string): boolean {
  if (typeof filename !== 'string' || filename.length === 0) return false;
  if (filename.includes('/') || filename.includes('\\') || filename.includes('\0')) return false;
  if (path.isAbsolute(filename)) return false;
  if (filename === '.' || filename === '..') return false;
  return SAFE_EVIDENCE_FILENAME.test(filename);
}

/**
 * Resolve a candidate filename against the evidence root and verify that the
 * resolved (realpath) location is contained in the root. Returns the resolved
 * absolute path, or throws EvidencePathError on any containment failure.
 */
export function resolveContainedEvidencePath(root: string, filename: string): string {
  if (!isSafeEvidenceFilename(filename)) {
    throw new EvidencePathError('Unsafe evidence filename');
  }
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, filename);
  // Prefix check on the lexical path.
  if (candidate !== resolvedRoot && !candidate.startsWith(resolvedRoot + path.sep)) {
    throw new EvidencePathError('Evidence path escapes the evidence root');
  }
  // If the file exists, resolve symlinks and re-check containment.
  let realRoot = resolvedRoot;
  try {
    realRoot = fs.realpathSync(resolvedRoot);
  } catch {
    realRoot = resolvedRoot;
  }
  if (fs.existsSync(candidate)) {
    let realCandidate: string;
    try {
      realCandidate = fs.realpathSync(candidate);
    } catch {
      throw new EvidencePathError('Evidence path could not be resolved');
    }
    if (realCandidate !== realRoot && !realCandidate.startsWith(realRoot + path.sep)) {
      throw new EvidencePathError('Evidence path escapes the evidence root via symlink');
    }
    return realCandidate;
  }
  // For not-yet-existing files, ensure the parent directory itself is not a
  // symlink escaping the root.
  const parent = path.dirname(candidate);
  if (fs.existsSync(parent)) {
    try {
      const realParent = fs.realpathSync(parent);
      if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) {
        throw new EvidencePathError('Evidence parent directory escapes the evidence root');
      }
    } catch {
      throw new EvidencePathError('Evidence parent directory could not be resolved');
    }
  }
  return candidate;
}
