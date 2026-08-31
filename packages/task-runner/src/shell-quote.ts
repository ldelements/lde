/**
 * Quotes a value for safe interpolation into a command string.
 *
 * Task runners execute their command through a shell – `NativeTaskRunner`
 * spawns with `shell: true`, `DockerTaskRunner` runs `sh -c` – so every
 * interpolated path must be quoted. Wrap the value in single quotes and escape
 * any embedded single quote as `'\''`.
 *
 * Without this, a filename containing an apostrophe – e.g. a dataset titled
 * `'s-Hertogenbosch`, whose distribution URL maps to a local file like
 * `…Erfgoed+'s-Hertogenbosch.nt` – terminates the surrounding quotes, so the
 * command reads a non-existent path. A filename containing a space splits into
 * several arguments, and one containing `;` or a backtick executes whatever
 * follows.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
