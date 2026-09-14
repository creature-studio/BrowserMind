import type { Logger } from './types.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export interface LogRecord {
  level: Exclude<LogLevel, 'silent'>;
  scope: string;
  message: string;
  meta?: Record<string, unknown>;
  at: number;
}

export type LogSink = (record: LogRecord) => void;

export interface CreateLoggerOptions {
  level?: LogLevel;
  scope?: string;
  sink?: LogSink;
}

/** Tiny structured logger. No dependency, works in extension + node. */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const scope = options.scope ?? 'browsermind';

  const emit = (recordLevel: Exclude<LogLevel, 'silent'>, message: string, meta?: Record<string, unknown>) => {
    if (LEVELS[recordLevel] < LEVELS[level]) return;
    const record: LogRecord = { level: recordLevel, scope, message, meta, at: Date.now() };
    if (options.sink) options.sink(record);
    else {
      const line = `[${recordLevel}] ${scope}: ${message}`;
      const fn = recordLevel === 'error' ? console.error : recordLevel === 'warn' ? console.warn : console.log;
      if (meta) fn(line, meta);
      else fn(line);
    }
  };

  return {
    debug: (message, meta) => emit('debug', message, meta),
    info: (message, meta) => emit('info', message, meta),
    warn: (message, meta) => emit('warn', message, meta),
    error: (message, meta) => emit('error', message, meta),
    child: (childScope) => createLogger({ level, scope: `${scope}:${childScope}`, sink: options.sink }),
  };
}

export const silentLogger = createLogger({ level: 'silent' });
