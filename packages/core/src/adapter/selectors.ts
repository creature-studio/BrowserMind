/**
 * Selector packs.
 *
 * A selector pack is the *entire* website-specific knowledge of a plugin.
 * Everything else (typing, submitting, streaming detection, status, snapshot)
 * is provider-agnostic and lives in `SelectorAdapter`.
 *
 * Every field is a list of candidate selectors: they are tried in order and the
 * first visible match wins, which lets one pack survive several UI variants of
 * the same site.
 */
import { ValidationError } from '../errors.js';

export interface SelectorAction {
  id: string;
  label: string;
  kind: 'click' | 'toggle';
  selector: string;
  /** For toggles: selector used to read the on/off state. Defaults to `selector`. */
  stateSelector?: string;
  description?: string;
}

export interface SelectorPack {
  /** The message composer. */
  input: string[];
  /** Send button, used when the submit key is not Enter. */
  sendButton?: string[];
  /** Keys that submit the composer. First entry is used for real submissions. */
  submitKeys?: Array<'Enter' | 'Ctrl+Enter' | 'Meta+Enter' | 'Shift+Enter'>;

  /** One element per AI answer — the *last* visible match is the current reply. */
  response?: string[];
  /** Shown while the model is generating (stop button, cursor, "thinking" chip…). */
  streaming?: string[];
  /** Extra busy indicators (e.g. a disabled composer). */
  busy?: string[];
  /** Visible when the composer is usable. */
  ready?: string[];
  /** Login wall / consent wall / captcha. */
  blocked?: string[];
  /** Error banners emitted by the site itself. */
  errorBanner?: string[];

  /** Upload plumbing. */
  fileInput?: string[];
  attachButton?: string[];

  /** Chat management. */
  newChat?: string[];
  stopButton?: string[];
  /** User message bubbles, used to rebuild the transcript. */
  userMessage?: string[];

  /** Provider specific actions exposed as `availableActions`. */
  actions?: SelectorAction[];

  /** Tunables for the streaming detector. */
  quietMs?: number;
  pollMs?: number;
  /** Snapshot transcript limit. */
  transcriptLimit?: number;
  /** How long a single step (input found, click sent…) may take. */
  stepTimeoutMs?: number;
}

export const DEFAULT_SUBMIT_KEYS: NonNullable<SelectorPack['submitKeys']> = ['Enter'];

/** Turn candidates into a single querySelectorAll-compatible selector. */
export function joinSelectors(selectors: readonly string[] | undefined): string {
  if (!selectors?.length) return '';
  return selectors
    .map((selector) => selector.trim())
    .filter(Boolean)
    .join(', ');
}

export function hasAnySelector(selectors: readonly string[] | undefined): boolean {
  return Boolean(selectors?.length);
}

/** Merge a base pack with overrides — handy for the `deepseek`/`deepseek-lite` split. */
export function extendPack(base: SelectorPack, overrides: Partial<SelectorPack>): SelectorPack {
  const merged: SelectorPack = { ...base, ...overrides };
  for (const key of Object.keys(overrides) as (keyof SelectorPack)[]) {
    const value = overrides[key];
    if (Array.isArray(value) && Array.isArray(base[key])) {
      // Arrays are concatenated so overrides *extend* the candidate list.
      (merged as unknown as Record<string, unknown>)[key] = [
        ...(base[key] as unknown[]),
        ...(value as unknown[]),
      ];
    }
  }
  return merged;
}

export function validatePack(pack: SelectorPack): void {
  if (!pack.input?.length) throw new ValidationError('Selector pack must declare at least one input selector');
  for (const selector of pack.input) assertSelector(selector, 'input');
  const lists: Array<[string, string[] | undefined]> = [
    ['response', pack.response],
    ['streaming', pack.streaming],
    ['sendButton', pack.sendButton],
    ['blocked', pack.blocked],
    ['fileInput', pack.fileInput],
  ];
  for (const [name, list] of lists) {
    for (const selector of list ?? []) assertSelector(selector, name);
  }
}

function assertSelector(selector: string, field: string): void {
  if (typeof selector !== 'string' || !selector.trim()) {
    throw new ValidationError(`Selector pack "${field}" contains an empty selector`);
  }
}

/** Build the Enter-variant used by `press()`. */
export function submitKeyToPress(key: string): { key: string; modifiers: string[] } {
  switch (key) {
    case 'Ctrl+Enter':
      return { key: 'Enter', modifiers: ['Control'] };
    case 'Meta+Enter':
      return { key: 'Enter', modifiers: ['Meta'] };
    case 'Shift+Enter':
      return { key: 'Enter', modifiers: ['Shift'] };
    default:
      return { key: 'Enter', modifiers: [] };
  }
}
