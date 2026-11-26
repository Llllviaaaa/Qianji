/**
 * Conservative static allowlist classifier for read-only `bash` invocations.
 * Rejects redirects (`>`, `>>`, `<`, `|<`), command substitution (`$(...)`, `` `...` ``),
 * subshells, backgrounding (`&`), environment overrides, `tee`, mutating `git` / `find`
 * flags, and any `;` / `&&` / `||` / `|` chain containing a non-allowlisted command.
 */

const SIMPLE_READONLY_COMMANDS = new Set(["ls", "pwd", "cat", "head", "wc", "which"]);

const DANGEROUS_FIND_ARGS = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);

const SAFE_GIT_GLOBAL_VALUE_FLAGS = new Set(["-C"]);
const SAFE_GIT_GLOBAL_BOOL_FLAGS = new Set(["--no-pager", "--no-optional-locks", "-P", "--bare"]);
const SAFE_GIT_BRANCH_FLAGS = new Set([
  "--show-current",
  "-a",
  "--all",
  "-r",
  "--remotes",
  "-v",
  "-vv",
  "--verbose",
  "--list",
  "--no-color",
  "--color",
  "--abbrev",
  "--no-abbrev",
]);

function tokenizeReadOnlyChain(command: string): string[][] | null {
  const trimmed = command.trim();
  if (trimmed === "" || /[\r\n\0]/.test(trimmed)) return null;

  const segments: string[][] = [];
  let currentWords: string[] = [];
  let token = "";
  let tokenStarted = false;
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  const flushWord = (): void => {
    if (tokenStarted) {
      currentWords.push(token);
      token = "";
      tokenStarted = false;
    }
  };

  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i] ?? "";
    const next = trimmed[i + 1] ?? "";

    if (escaped) {
      token += ch;
      tokenStarted = true;
      escaped = false;
      continue;
    }

    if (inSingle) {
      if (ch === "'") inSingle = false;
      else token += ch;
      continue;
    }

    // Backticks and $(...) execute commands both unquoted and inside double quotes.
    if (ch === "`" || (ch === "$" && next === "(")) return null;

    if (ch === "\\") {
      escaped = true;
      tokenStarted = true;
      continue;
    }

    if (inDouble) {
      if (ch === '"') inDouble = false;
      else token += ch;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      tokenStarted = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      tokenStarted = true;
      continue;
    }

    // Reject redirects, subshells, brace groups, and process substitution.
    if (ch === ">" || ch === "<" || ch === "(" || ch === ")" || ch === "{" || ch === "}") {
      return null;
    }

    if (ch === " " || ch === "\t") {
      flushWord();
      continue;
    }

    if (ch === ";" || ch === "|" || ch === "&") {
      flushWord();
      if (ch === "&" && next !== "&") return null; // Background `&` or `&>` is not read-only safe.
      const isDoubleOp = (ch === "&" && next === "&") || (ch === "|" && next === "|");
      if (isDoubleOp) i += 1;

      if (currentWords.length === 0) return null;
      segments.push(currentWords);
      currentWords = [];

      // Trailing `;` is allowed only at the very end; pipes/&&/|| require a right-hand command.
      if (ch === ";" && i === trimmed.length - 1) return segments;
      if (i === trimmed.length - 1) return null;
      continue;
    }

    token += ch;
    tokenStarted = true;
  }

  if (inSingle || inDouble || escaped) return null;
  flushWord();
  if (currentWords.length === 0) return null;
  segments.push(currentWords);
  return segments;
}

function isSafeGitSegment(args: readonly string[]): boolean {
  let idx = 0;
  while (idx < args.length) {
    const token = args[idx] ?? "";
    if (!token.startsWith("-")) break;
    if (SAFE_GIT_GLOBAL_BOOL_FLAGS.has(token)) {
      idx += 1;
      continue;
    }
    if (SAFE_GIT_GLOBAL_VALUE_FLAGS.has(token)) {
      if (idx + 1 >= args.length) return false;
      idx += 2;
      continue;
    }
    // Reject `-c key=val`, `--config-env`, `--git-dir`, `--work-tree`, `-p`, etc.
    return false;
  }

  const sub = args[idx];
  if (sub === undefined) return false;
  const rest = args.slice(idx + 1);

  if (sub === "status" || sub === "rev-parse") return true;

  if (sub === "diff" || sub === "log" || sub === "show") {
    return !rest.some((arg) => arg === "--output" || arg.startsWith("--output=") || arg === "--ext-diff");
  }

  if (sub === "branch") {
    let listMode = false;
    for (const arg of rest) {
      if (arg === "--list" || arg === "-l") {
        listMode = true;
        continue;
      }
      if (SAFE_GIT_BRANCH_FLAGS.has(arg) || arg.startsWith("--color=") || arg.startsWith("--sort=") || arg.startsWith("--format=")) {
        continue;
      }
      // In `--list` mode, non-flag pattern arguments only filter displayed branch names.
      if (listMode && !arg.startsWith("-")) continue;
      return false;
    }
    return true;
  }

  return false;
}

function isSafeSegment(words: readonly string[]): boolean {
  const cmd = words[0];
  if (cmd === undefined || !/^[a-z0-9_-]+$/.test(cmd)) return false;
  const args = words.slice(1);

  if (SIMPLE_READONLY_COMMANDS.has(cmd)) return true;

  if (cmd === "tail") {
    return !args.some((arg) => arg === "-f" || arg === "-F" || arg === "--follow" || arg.startsWith("--follow="));
  }

  if (cmd === "rg" || cmd === "grep") {
    return !args.some((arg) => arg === "--pre" || arg.startsWith("--pre=") || arg === "--pre-glob" || arg.startsWith("--pre-glob="));
  }

  if (cmd === "find") {
    return !args.some((arg) => DANGEROUS_FIND_ARGS.has(arg));
  }

  if (cmd === "git") {
    return isSafeGitSegment(args);
  }

  return false;
}

/** True only when `command` is a conservative read-only shell command or pipeline/chain. */
export function isReadOnlyShellCommand(command: string): boolean {
  if (typeof command !== "string") return false;
  const segments = tokenizeReadOnlyChain(command);
  if (segments === null || segments.length === 0) return false;
  return segments.every(isSafeSegment);
}
