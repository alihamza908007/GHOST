import { describe, expect, it } from 'vitest';
import { isAllowedUrl, normalizeOrigin, normalizeOrigins } from '../src/policy.js';

describe('@ghost/core origin normalization', () => {
  it('normalizes exact origin', () => {
    expect(normalizeOrigin('http://example.com:3000/path')).toBe('http://example.com:3000');
  });

  it('distinguishes ports', () => {
    expect(normalizeOrigin('http://example.com:3000')).not.toBe(normalizeOrigin('http://example.com:3001'));
    expect(isAllowedUrl('http://example.com:3001/', 'http://example.com:3000')).toBe(false);
  });

  it('distinguishes schemes', () => {
    expect(isAllowedUrl('https://example.com/', 'http://example.com')).toBe(false);
  });

  it('rejects credentials in URL', () => {
    expect(normalizeOrigin('http://user:pass@example.com')).toBeNull();
    expect(isAllowedUrl('http://user:pass@example.com/', 'http://example.com')).toBe(false);
  });

  it('rejects unsupported schemes', () => {
    expect(normalizeOrigin('file:///etc/passwd')).toBeNull();
    expect(normalizeOrigin('javascript:alert(1)')).toBeNull();
    expect(normalizeOrigin('data:text/html,x')).toBeNull();
  });

  it('rejects malformed URLs', () => {
    expect(normalizeOrigin('not a url')).toBeNull();
    expect(normalizeOrigin('')).toBeNull();
  });

  it('no hostname substring matching', () => {
    expect(isAllowedUrl('http://example.com.attacker.invalid/', 'http://example.com')).toBe(false);
    expect(isAllowedUrl('http://attackerexample.com/', 'http://example.com')).toBe(false);
  });

  it('no subdomain auto-authorization', () => {
    expect(isAllowedUrl('http://sub.example.com/', 'http://example.com')).toBe(false);
  });

  it('default port handling', () => {
    expect(normalizeOrigin('http://example.com')).toBe('http://example.com');
    expect(normalizeOrigin('http://example.com:80')).toBe('http://example.com');
    expect(isAllowedUrl('http://example.com/', 'http://example.com:80')).toBe(true);
  });

  it('normalizes arrays and dedupes', () => {
    const out = normalizeOrigins(['http://a.com', 'http://a.com/', 'http://b.com', 'garbage', null, undefined]);
    expect(out).toEqual(['http://a.com', 'http://b.com']);
  });

  it('empty array yields empty', () => {
    expect(normalizeOrigins([])).toEqual([]);
    expect(normalizeOrigins(['garbage'])).toEqual([]);
  });

  it('isAllowedUrl with array', () => {
    expect(isAllowedUrl('http://b.com/x', ['http://a.com', 'http://b.com'])).toBe(true);
    expect(isAllowedUrl('http://c.com/x', ['http://a.com', 'http://b.com'])).toBe(false);
  });

  it('rejects embedded credentials in isAllowedUrl', () => {
    expect(isAllowedUrl('http://user:pass@example.com/', 'http://example.com')).toBe(false);
  });
});
