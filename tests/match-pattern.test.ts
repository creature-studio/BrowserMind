import { describe, expect, it } from 'vitest';
import {
  matchAnyPattern,
  matchUrlPattern,
  patternSpecificity,
  parsePattern,
  isValidPattern,
} from '../packages/core/src/match-pattern.js';

describe('match patterns', () => {
  it('accepts the documented provider patterns', () => {
    expect(matchUrlPattern('https://chat.deepseek.com/*', 'https://chat.deepseek.com/a/chat/s/1')).toBe(true);
    expect(matchUrlPattern('https://chatgpt.com/*', 'https://chatgpt.com/c/abc')).toBe(true);
    expect(matchUrlPattern('https://chat.openai.com/*', 'https://chat.openai.com/')).toBe(true);
    expect(matchUrlPattern('https://claude.ai/*', 'https://claude.ai/chat/xyz')).toBe(true);
    expect(matchUrlPattern('https://gemini.google.com/*', 'https://gemini.google.com/app')).toBe(true);
    expect(matchUrlPattern('https://grok.com/*', 'https://grok.com/chat/1')).toBe(true);
    expect(matchUrlPattern('https://x.com/i/grok*', 'https://x.com/i/grok?foo=1')).toBe(true);
  });

  it('rejects other hosts, schemes and paths', () => {
    expect(matchUrlPattern('https://chat.deepseek.com/*', 'https://chat.deepseek.com.evil.com/')).toBe(false);
    expect(matchUrlPattern('https://chat.deepseek.com/*', 'http://chat.deepseek.com/')).toBe(false);
    expect(matchUrlPattern('https://claude.ai/chat/*', 'https://claude.ai/settings')).toBe(false);
    expect(matchUrlPattern('https://x.com/i/grok*', 'https://x.com/home')).toBe(false);
  });

  it('supports wildcard hosts', () => {
    expect(matchUrlPattern('https://*.example.com/*', 'https://app.example.com/x')).toBe(true);
    expect(matchUrlPattern('https://*.example.com/*', 'https://example.com/x')).toBe(true);
    expect(matchUrlPattern('https://*.example.com/*', 'https://notexample.com/x')).toBe(false);
  });

  it('scores literal hosts above wildcards', () => {
    expect(patternSpecificity('https://chat.deepseek.com/*')).toBeGreaterThan(
      patternSpecificity('https://*.deepseek.com/*'),
    );
    expect(patternSpecificity('https://*.deepseek.com/*')).toBeGreaterThan(patternSpecificity('https://*/*'));
  });

  it('validates patterns', () => {
    expect(isValidPattern('https://a.com/*')).toBe(true);
    expect(isValidPattern('not-a-pattern')).toBe(false);
    expect(() => parsePattern('nonsense')).toThrow();
    expect(matchAnyPattern(['https://a.com/*', 'https://b.com/*'], 'https://b.com/x')).toBe(true);
  });
});
