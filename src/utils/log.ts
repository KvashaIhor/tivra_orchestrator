/**
 * Minimal coloured logger — writes timestamped lines to stdout/stderr.
 * No external deps required.
 */

const RESET  = '\x1b[0m';
const GREY   = '\x1b[90m';
const CYAN   = '\x1b[36m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const MAGENTA = '\x1b[35m';

function ts(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

function line(colour: string, tag: string, msg: string, data?: unknown): void {
  const prefix = `${GREY}${ts()}${RESET} ${colour}[${tag}]${RESET}`;
  process.stdout.write(`${prefix} ${msg}\n`);
  if (data !== undefined) {
    const json = JSON.stringify(data, null, 2);
    process.stdout.write(`${GREY}${json}${RESET}\n`);
  }
}

export const log = {
  info:    (msg: string, data?: unknown) => line(CYAN,    'INFO ',  msg, data),
  ok:      (msg: string, data?: unknown) => line(GREEN,   'OK   ',  msg, data),
  warn:    (msg: string, data?: unknown) => line(YELLOW,  'WARN ',  msg, data),
  error:   (msg: string, data?: unknown) => {
    const prefix = `${GREY}${ts()}${RESET} ${RED}[ERROR]${RESET}`;
    process.stderr.write(`${prefix} ${msg}\n`);
    if (data !== undefined) {
      process.stderr.write(`${RED}${JSON.stringify(data, null, 2)}${RESET}\n`);
    }
  },
  step:    (msg: string, data?: unknown) => line(MAGENTA, 'STEP ',  msg, data),
  cli:     (msg: string, data?: unknown) => line(GREY,    'CLI  ',  msg, data),
};
