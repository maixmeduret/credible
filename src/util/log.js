/**
 * Minimal levelled logger. Writes to stderr so stdout stays clean for CLI
 * output that other tools may pipe.
 */
import { config } from '../config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const threshold = () => LEVELS[config.logLevel] ?? LEVELS.info;

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

function write(level, args) {
  if (LEVELS[level] < threshold()) return;
  process.stderr.write(`${stamp()} ${level.padEnd(5)} ${format(args)}\n`);
}

function format(args) {
  return args
    .map((arg) => {
      if (arg instanceof Error) return arg.stack || arg.message;
      if (typeof arg === 'object') {
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      }
      return String(arg);
    })
    .join(' ');
}

export const log = {
  debug: (...args) => write('debug', args),
  info: (...args) => write('info', args),
  warn: (...args) => write('warn', args),
  error: (...args) => write('error', args),
  /** Always printed, for CLI output. */
  print: (...args) => process.stdout.write(`${format(args)}\n`),
};
