/**
 * Match-pattern handling.
 *
 * We implement the web-extension match pattern semantics ourselves instead of
 * relying on `chrome.*` so the exact same matching runs in Node (runtime,
 * tests, simulator) and inside the extension.
 */

const SCHEME_RE = /^(\*|http|https):\/\/([^/]*)(\/.*)$/;

export interface ParsedPattern {
  scheme: '*' | 'http' | 'https';
  host: string;
  path: string;
  raw: string;
}

export function parsePattern(pattern: string): ParsedPattern {
  const match = SCHEME_RE.exec(pattern.trim());
  if (!match) {
    throw new Error(`Invalid match pattern: ${pattern}`);
  }
  return {
    scheme: match[1] as ParsedPattern['scheme'],
    host: match[2] ?? '',
    path: match[3] || '/*',
    raw: pattern,
  };
}

export function isValidPattern(pattern: string): boolean {
  try {
    parsePattern(pattern);
    return true;
  } catch {
    return false;
  }
}

function hostMatches(patternHost: string, hostname: string): boolean {
  if (patternHost === '*') return true;
  if (patternHost.startsWith('*.')) {
    const base = patternHost.slice(2).toLowerCase();
    return hostname === base || hostname.endsWith(`.${base}`);
  }
  return patternHost.toLowerCase() === hostname;
}

function pathMatches(patternPath: string, pathname: string): boolean {
  if (patternPath === '/*' || patternPath === '*') return true;
  if (!patternPath.includes('*')) return pathname === patternPath;
  const escaped = patternPath
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`).test(pathname);
}

/** Does `url` match a single match pattern? */
export function matchUrlPattern(pattern: string, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  let patternParts: ParsedPattern;
  try {
    patternParts = parsePattern(pattern);
  } catch {
    return false;
  }
  if (patternParts.scheme !== '*') {
    const scheme = parsed.protocol.replace(':', '');
    if (scheme !== patternParts.scheme) return false;
  } else if (!['http:', 'https:'].includes(parsed.protocol)) {
    return false;
  }
  if (!hostMatches(patternParts.host, parsed.hostname)) return false;
  return pathMatches(patternParts.path, parsed.pathname + parsed.search);
}

export function matchAnyPattern(patterns: readonly string[], url: string): boolean {
  return patterns.some((pattern) => matchUrlPattern(pattern, url));
}

/** Sort used when several plugins match the same URL: literal hosts win over wildcards. */
export function patternSpecificity(pattern: string): number {
  try {
    const parsed = parsePattern(pattern);
    let score = 0;
    if (parsed.host !== '*') score += 100;
    if (!parsed.host.includes('*')) score += 50;
    score += parsed.host.split('.').length * 5;
    if (parsed.path !== '/*') score += 30;
    if (parsed.scheme !== '*') score += 5;
    return score;
  } catch {
    return -1;
  }
}
