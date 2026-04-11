/**
 * Shell quoting utilities for agent-browser CLI arguments.
 *
 * Handles safe escaping of URLs, selectors, text input,
 * and batch command wrapping.
 */

/**
 * Escape a single argument for safe shell execution.
 *
 * Wraps in single quotes and escapes any embedded single quotes.
 * This is the safest approach on POSIX shells — single-quoted strings
 * pass everything through literally except `'` itself.
 *
 * @example
 * shellQuote("hello world")       → "'hello world'"
 * shellQuote("it's here")         → "'it'\\''s here'"
 * shellQuote('a "quoted" thing')  → "'a \"quoted\" thing'"
 */
export function shellQuote(arg: string): string {
  // If arg contains no special chars, return as-is
  if (/^[a-zA-Z0-9_./:@=,-]+$/.test(arg)) {
    return arg
  }
  // Wrap in single quotes, escaping embedded single quotes:
  // each ' → '\'' (end quote, escaped quote, re-open quote)
  return `'${arg.replace(/'/g, "'\\''")}'`
}

/**
 * Build the argument list for an `agent-browser batch` invocation.
 *
 * Each command string becomes a double-quoted argument to `batch`.
 * Internal double-quotes and backslashes are escaped.
 *
 * @example
 * wrapBatchArgs(["open https://example.com", "snapshot -i"])
 * → ['"open https://example.com"', '"snapshot -i"']
 */
export function wrapBatchArgs(commands: string[]): string[] {
  return commands.map(
    (cmd) => `"${cmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
  )
}

/**
 * Build the full argv array for spawning agent-browser.
 *
 * - Single command: splits the command string into args
 * - Multiple commands: wraps in batch syntax
 */
export function buildArgv(commands: string[]): string[] {
  if (commands.length === 1) {
    return splitCommand(commands[0])
  }
  return ["batch", ...wrapBatchArgs(commands)]
}

/**
 * Split a command string into argv tokens.
 *
 * Respects double-quoted and single-quoted strings so that
 * `fill @e1 "hello world"` splits correctly.
 */
export function splitCommand(command: string): string[] {
  const tokens: string[] = []
  let current = ""
  let inDouble = false
  let inSingle = false
  let escaped = false

  for (const ch of command) {
    if (escaped) {
      current += ch
      escaped = false
      continue
    }

    if (ch === "\\" && !inSingle) {
      escaped = true
      continue
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      continue
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      continue
    }

    if (ch === " " && !inDouble && !inSingle) {
      if (current) {
        tokens.push(current)
        current = ""
      }
      continue
    }

    current += ch
  }

  if (current) {
    tokens.push(current)
  }

  return tokens
}
