/**
 * RTK Rewrite Extension for Pi
 *
 * Transparently rewrites bash commands to their `rtk` equivalents for
 * token-optimized output. RTK (https://github.com/rtk-ai/rtk) filters and
 * summarises CLI output before it reaches the LLM context window, saving
 * tokens without changing semantics.
 *
 * Port of ~/.claude/hooks/rtk-rewrite.sh for pi's extension system.
 * Matches Claude hook behavior: aggressive rewriting, no pipe/redirect guards.
 *
 * Install:
 *   pi install git:github.com/nstfn/pi-rtk-rewrite
 *
 * Usage:
 *   Automatic after install — loads on every pi session.
 *   Manual — pi -e ./extensions/rtk-rewrite.ts
 *
 * Commands:
 *   /rtk          — Show rewrite stats for this session
 *   /rtk:toggle   — Enable/disable rewriting
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { execSync } from "node:child_process";

// ── Types ────────────────────────────────────────────────────────────────────

interface RewriteRule {
  /** Human-readable label for stats */
  label: string;
  /** Test whether the command matches */
  match: (cmd: string) => boolean;
  /** Produce the rewritten command body (without env prefix) */
  rewrite: (cmdBody: string) => string;
}

interface RewriteStats {
  total: number;
  skipped: number;
  byRule: Record<string, number>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** True when `rtk` is installed and on PATH. Cached after first check. */
let rtkAvailable: boolean | null = null;

function checkRtk(): boolean {
  if (rtkAvailable !== null) return rtkAvailable;
  try {
    execSync("command -v rtk", { stdio: "ignore" });
    rtkAvailable = true;
  } catch {
    rtkAvailable = false;
  }
  return rtkAvailable;
}

/** Match the first word (the binary name) of a command string. */
function firstWord(cmd: string): string {
  return cmd.trimStart().split(/\s+/)[0] ?? "";
}

/** Extract the git sub-command, stripping flags like -C, -c, --no-pager … */
function gitSubcmd(cmd: string): string {
  return cmd
    .replace(/^git\s+/, "")
    .replace(/(-C|-c)\s+\S+\s*/g, "")
    .replace(/--\S+=\S+\s*/g, "")
    .replace(/--(no-pager|no-optional-locks|bare|literal-pathspecs)\s*/g, "")
    .trimStart()
    .split(/\s+/)[0] ?? "";
}

/** Extract the docker sub-command, stripping connection flags. */
function dockerSubcmd(cmd: string): string {
  return cmd
    .replace(/^docker\s+/, "")
    .replace(/(-H|--context|--config)\s+\S+\s*/g, "")
    .replace(/--\S+=\S+\s*/g, "")
    .trimStart()
    .split(/\s+/)[0] ?? "";
}

/** Extract the kubectl sub-command, stripping namespace/context flags. */
function kubectlSubcmd(cmd: string): string {
  return cmd
    .replace(/^kubectl\s+/, "")
    .replace(/(--context|--kubeconfig|--namespace|-n)\s+\S+\s*/g, "")
    .replace(/--\S+=\S+\s*/g, "")
    .trimStart()
    .split(/\s+/)[0] ?? "";
}

function startsWith(cmd: string, prefix: string): boolean {
  return cmd === prefix || cmd.startsWith(prefix + " ");
}

function re(pattern: RegExp): (cmd: string) => boolean {
  return (cmd) => pattern.test(cmd);
}

/**
 * Split a command string at the first unquoted shell operator (|, &&, ||, ;, >, >>, <, 2>).
 * Returns [commandPart, shellTail] where shellTail includes the operator.
 */
function splitAtShellOp(cmd: string): [string, string] {
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "|" || ch === ";" || ch === ">" || ch === "<") {
      return [cmd.slice(0, i).trimEnd(), " " + cmd.slice(i)];
    }
    if (ch === "&" && cmd[i + 1] === "&") {
      return [cmd.slice(0, i).trimEnd(), " " + cmd.slice(i)];
    }
  }
  return [cmd, ""];
}

/**
 * Translate a grep/rg invocation to rtk grep positional syntax.
 *
 * rtk grep expects: <PATTERN> [PATH] [EXTRA_ARGS]...
 * - Recursive by default (strip -r/-R/--recursive)
 * - Accepts -n for compat (always on)
 * - Passes remaining flags as EXTRA_ARGS to ripgrep
 * - Translates --include="*.ext" to --glob "*.ext"
 *
 * Returns the full `rtk grep ...` command, or null if untranslatable.
 */
function translateGrep(body: string): string | null {
  // Split at shell operators so we only translate the grep part
  const [cmdPart, shellTail] = splitAtShellOp(body);
  // Strip the leading grep/rg command
  const rest = cmdPart.replace(/^(rg|grep)\s+/, "");
  if (!rest) return null;

  const tokens = shellTokenise(rest);

  let pattern: string | null = null;
  let path: string | null = null;
  const extraArgs: string[] = [];

  // Flags to strip (redundant in rtk grep)
  const stripShort = new Set(["r", "R"]);
  // Flags that consume a following argument
  const argFlags = new Set(["-A", "-B", "-C", "-m", "-e", "-f", "--glob"]);

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    // Combined short flags like -rn, -rin, -rni
    if (/^-[a-zA-Z]{2,}$/.test(tok) && !tok.startsWith("--")) {
      const kept = tok.slice(1).split("").filter((ch) => !stripShort.has(ch));
      if (kept.length > 0) extraArgs.push("-" + kept.join(""));
      continue;
    }

    // Single short flags to strip
    if (tok === "-r" || tok === "-R" || tok === "--recursive") continue;

    // --include="*.ext" → --glob "*.ext"
    const includeMatch = tok.match(/^--include=(.+)$/);
    if (includeMatch) {
      extraArgs.push("--glob", includeMatch[1]);
      continue;
    }
    if (tok === "--include" && i + 1 < tokens.length) {
      extraArgs.push("--glob", tokens[++i]);
      continue;
    }

    // Flags with a following argument
    if (argFlags.has(tok) && i + 1 < tokens.length) {
      extraArgs.push(tok, tokens[++i]);
      continue;
    }

    // Other flags (pass through)
    if (tok.startsWith("-")) {
      extraArgs.push(tok);
      continue;
    }

    // Positional: first is pattern, second is path
    if (pattern === null) {
      pattern = tok;
    } else if (path === null) {
      path = tok;
    } else {
      // Unexpected extra positional — bail out
      return null;
    }
  }

  if (!pattern) return null;

  const parts = ["rtk grep", pattern];
  if (path) parts.push(path);
  if (extraArgs.length > 0) parts.push(extraArgs.join(" "));
  return parts.join(" ") + shellTail;
}

/**
 * Translate a find invocation to rtk find positional syntax.
 *
 * rtk find expects: <PATTERN> [PATH] [-t f|d] [-m N]
 *
 * Extracts -name value as PATTERN, path as PATH, -type as -t.
 * Skips commands with side-effect flags (-exec, -delete, -print0, etc.)
 *
 * Returns the full `rtk find ...` command, or null if untranslatable.
 */
function translateFind(body: string): string | null {
  const [cmdPart, shellTail] = splitAtShellOp(body);

  const rest = cmdPart.replace(/^find\s+/, "");
  if (!rest) return null;

  const tokens = shellTokenise(rest);

  // Bail out on side-effect flags
  const dangerous = new Set(["-exec", "-execdir", "-delete", "-print0", "-ok", "-fls", "-fprint"]);
  if (tokens.some((t) => dangerous.has(t))) return null;

  let namePattern: string | null = null;
  let path: string | null = null;
  let fileType: string | null = null;

  // Flags we understand but skip (rtk doesn't support them)
  const skipWithArg = new Set(["-maxdepth", "-mindepth"]);

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    if (tok === "-name" || tok === "-iname") {
      if (i + 1 < tokens.length) namePattern = tokens[++i];
      continue;
    }

    if (tok === "-type" && i + 1 < tokens.length) {
      fileType = tokens[++i];
      continue;
    }

    if (skipWithArg.has(tok) && i + 1 < tokens.length) {
      i++; // skip the value
      continue;
    }

    // Other flags we don't understand — bail out
    if (tok.startsWith("-")) return null;

    // Positional: the search path (first non-flag, non-extracted arg)
    if (path === null) {
      path = tok;
    }
  }

  if (!namePattern) return null;

  const parts = ["rtk find", namePattern];
  if (path) parts.push(path);
  if (fileType === "f" || fileType === "d") parts.push("-t", fileType);
  return parts.join(" ") + shellTail;
}

/**
 * Simple shell tokeniser — splits on whitespace, respects single/double quotes.
 */
function shellTokenise(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === " " || ch === "\t") {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

// ── Rewrite Rules ────────────────────────────────────────────────────────────
// Each rule is tested in order; the first match wins.
// Matches Claude CLI hook behavior: aggressive rewriting for maximum token savings.

const GIT_SUBCMDS = new Set([
  "status", "diff", "log", "add", "commit", "push",
  "pull", "branch", "fetch", "stash", "show",
]);

const CARGO_SUBCMDS = new Set([
  "test", "build", "clippy", "check", "install", "fmt",
]);

const DOCKER_SIMPLE_SUBCMDS = new Set([
  "ps", "images", "logs", "run", "build", "exec",
]);

const KUBECTL_SUBCMDS = new Set([
  "get", "logs", "describe", "apply",
]);

const rules: RewriteRule[] = [
  // ── Git ──────────────────────────────────────────────────────────────────
  {
    label: "git",
    match: (cmd) => re(/^git\s/)(cmd) && GIT_SUBCMDS.has(gitSubcmd(cmd)),
    rewrite: (body) => `rtk ${body}`,
  },

  // ── GitHub CLI ───────────────────────────────────────────────────────────
  {
    label: "gh",
    match: re(/^gh\s+(pr|issue|run|api|release)(\s|$)/),
    rewrite: (body) => body.replace(/^gh /, "rtk gh "),
  },

  // ── Cargo ────────────────────────────────────────────────────────────────
  {
    label: "cargo",
    match: (cmd) => {
      if (!re(/^cargo\s/)(cmd)) return false;
      const sub = cmd.replace(/^cargo\s+(\+\S+\s+)?/, "").split(/\s+/)[0] ?? "";
      return CARGO_SUBCMDS.has(sub);
    },
    rewrite: (body) => `rtk ${body}`,
  },

  // ── File operations ──────────────────────────────────────────────────────
  {
    label: "cat → rtk read",
    match: re(/^cat\s+/),
    rewrite: (body) => body.replace(/^cat /, "rtk read "),
  },
  {
    label: "grep/rg",
    match: re(/^(rg|grep)\s+/),
    rewrite: (body) => translateGrep(body) ?? body,
  },
  {
    label: "ls",
    match: re(/^ls(\s|$)/),
    rewrite: (body) => body.replace(/^ls/, "rtk ls"),
  },
  {
    label: "tree",
    match: re(/^tree(\s|$)/),
    rewrite: (body) => body.replace(/^tree/, "rtk tree"),
  },
  {
    label: "find",
    match: re(/^find\s+/),
    rewrite: (body) => translateFind(body) ?? body,
  },
  {
    label: "diff",
    match: re(/^diff\s+/),
    rewrite: (body) => body.replace(/^diff /, "rtk diff "),
  },
  {
    label: "head → rtk read",
    match: re(/^head\s+(-\d+|--lines=\d+)\s+/),
    rewrite: (body) => {
      // head -N file → rtk read file --max-lines N
      let m = body.match(/^head\s+-(\d+)\s+(.+)$/);
      if (m) return `rtk read ${m[2]} --max-lines ${m[1]}`;
      m = body.match(/^head\s+--lines=(\d+)\s+(.+)$/);
      if (m) return `rtk read ${m[2]} --max-lines ${m[1]}`;
      return body; // no match — pass through unchanged
    },
  },

  // ── JS/TS tooling ───────────────────────────────────────────────────────
  {
    label: "vitest",
    match: re(/^(pnpm\s+)?(npx\s+)?vitest(\s|$)/),
    rewrite: (body) => body.replace(/^(pnpm\s+)?(npx\s+)?vitest(\s+run)?/, "rtk vitest run"),
  },
  {
    label: "pnpm test",
    match: re(/^pnpm\s+test(\s|$)/),
    rewrite: (body) => body.replace(/^pnpm test/, "rtk vitest run"),
  },
  {
    label: "npm test",
    match: re(/^npm\s+test(\s|$)/),
    rewrite: (body) => body.replace(/^npm test/, "rtk npm test"),
  },
  {
    label: "npm run",
    match: re(/^npm\s+run\s+/),
    rewrite: (body) => body.replace(/^npm run /, "rtk npm "),
  },
  {
    label: "vue-tsc / tsc",
    match: re(/^(npx\s+)?vue-tsc(\s|$)/),
    rewrite: (body) => body.replace(/^(npx\s+)?vue-tsc/, "rtk tsc"),
  },
  {
    label: "pnpm tsc",
    match: re(/^pnpm\s+tsc(\s|$)/),
    rewrite: (body) => body.replace(/^pnpm tsc/, "rtk tsc"),
  },
  {
    label: "tsc",
    match: re(/^(npx\s+)?tsc(\s|$)/),
    rewrite: (body) => body.replace(/^(npx\s+)?tsc/, "rtk tsc"),
  },
  {
    label: "pnpm lint",
    match: re(/^pnpm\s+lint(\s|$)/),
    rewrite: (body) => body.replace(/^pnpm lint/, "rtk lint"),
  },
  {
    label: "eslint",
    match: re(/^(npx\s+)?eslint(\s|$)/),
    rewrite: (body) => body.replace(/^(npx\s+)?eslint/, "rtk lint"),
  },
  {
    label: "prettier",
    match: re(/^(npx\s+)?prettier(\s|$)/),
    rewrite: (body) => body.replace(/^(npx\s+)?prettier/, "rtk prettier"),
  },
  {
    label: "playwright",
    match: re(/^(npx\s+|pnpm\s+)?playwright(\s|$)/),
    rewrite: (body) => body.replace(/^(npx\s+|pnpm\s+)?playwright/, "rtk playwright"),
  },
  {
    label: "prisma",
    match: re(/^(npx\s+)?prisma(\s|$)/),
    rewrite: (body) => body.replace(/^(npx\s+)?prisma/, "rtk prisma"),
  },

  // ── Containers ──────────────────────────────────────────────────────────
  {
    label: "docker compose",
    match: re(/^docker\s+compose(\s|$)/),
    rewrite: (body) => body.replace(/^docker /, "rtk docker "),
  },
  {
    label: "docker",
    match: (cmd) => re(/^docker\s/)(cmd) && !re(/^docker\s+compose/)(cmd) &&
      DOCKER_SIMPLE_SUBCMDS.has(dockerSubcmd(cmd)),
    rewrite: (body) => body.replace(/^docker /, "rtk docker "),
  },
  {
    label: "kubectl",
    match: (cmd) => re(/^kubectl\s/)(cmd) && KUBECTL_SUBCMDS.has(kubectlSubcmd(cmd)),
    rewrite: (body) => body.replace(/^kubectl /, "rtk kubectl "),
  },

  // ── Network ─────────────────────────────────────────────────────────────
  {
    label: "curl",
    match: re(/^curl\s+/),
    rewrite: (body) => body.replace(/^curl /, "rtk curl "),
  },
  {
    label: "wget",
    match: re(/^wget\s+/),
    rewrite: (body) => body.replace(/^wget /, "rtk wget "),
  },

  // ── pnpm package management ─────────────────────────────────────────────
  {
    label: "pnpm list/outdated",
    match: re(/^pnpm\s+(list|ls|outdated)(\s|$)/),
    rewrite: (body) => body.replace(/^pnpm /, "rtk pnpm "),
  },

  // ── Python ──────────────────────────────────────────────────────────────
  {
    label: "pytest",
    match: re(/^pytest(\s|$)/),
    rewrite: (body) => body.replace(/^pytest/, "rtk pytest"),
  },
  {
    label: "python -m pytest",
    match: re(/^python\s+-m\s+pytest(\s|$)/),
    rewrite: (body) => body.replace(/^python -m pytest/, "rtk pytest"),
  },
  {
    label: "ruff",
    match: re(/^ruff\s+(check|format)(\s|$)/),
    rewrite: (body) => body.replace(/^ruff /, "rtk ruff "),
  },
  {
    label: "pip",
    match: re(/^pip\s+(list|outdated|install|show)(\s|$)/),
    rewrite: (body) => body.replace(/^pip /, "rtk pip "),
  },
  {
    label: "uv pip",
    match: re(/^uv\s+pip\s+(list|outdated|install|show)(\s|$)/),
    rewrite: (body) => body.replace(/^uv pip /, "rtk pip "),
  },

  // ── Go ──────────────────────────────────────────────────────────────────
  {
    label: "go test",
    match: re(/^go\s+test(\s|$)/),
    rewrite: (body) => body.replace(/^go test/, "rtk go test"),
  },
  {
    label: "go build",
    match: re(/^go\s+build(\s|$)/),
    rewrite: (body) => body.replace(/^go build/, "rtk go build"),
  },
  {
    label: "go vet",
    match: re(/^go\s+vet(\s|$)/),
    rewrite: (body) => body.replace(/^go vet/, "rtk go vet"),
  },
  {
    label: "golangci-lint",
    match: re(/^golangci-lint(\s|$)/),
    rewrite: (body) => body.replace(/^golangci-lint/, "rtk golangci-lint"),
  },
];

// ── Core rewrite logic ───────────────────────────────────────────────────────

/** Separates leading `KEY=val ` env-var assignments from the command body. */
function splitEnvPrefix(cmd: string): [envPrefix: string, body: string] {
  const m = cmd.match(/^((?:[A-Za-z_][A-Za-z0-9_]*=[^ ]* +)+)/);
  if (m) return [m[1], cmd.slice(m[1].length)];
  return ["", cmd];
}

interface RewriteResult {
  rewritten: string;
  rule: string;
}

function tryRewriteSingle(command: string): RewriteResult | null {
  // Skip if already using rtk
  if (/^rtk\s/.test(command) || /\/rtk\s/.test(command)) return null;

  // Skip heredocs (Claude hook does this too)
  if (command.includes("<<")) return null;

  const [envPrefix, body] = splitEnvPrefix(command);

  for (const rule of rules) {
    if (rule.match(body)) {
      const rewrittenBody = rule.rewrite(body);
      // If the rewrite function didn't change anything, skip
      if (rewrittenBody === body) continue;
      return {
        rewritten: envPrefix + rewrittenBody,
        rule: rule.label,
      };
    }
  }

  return null;
}

/**
 * Merge physical lines that end with `\` (continuation) into logical lines.
 * Preserves original line breaks inside each logical unit so the final
 * reassembly produces an identical string when nothing is rewritten.
 */
function mergeContLines(lines: string[]): string[] {
  const out: string[] = [];
  let buf = "";
  for (const ln of lines) {
    if (ln.endsWith("\\")) {
      buf += ln + "\n";
    } else {
      out.push(buf + ln);
      buf = "";
    }
  }
  if (buf) out.push(buf); // trailing continuation without final line
  return out;
}

/**
 * Try to rewrite a (possibly multi-line) bash command.
 *
 * LLMs frequently emit bash commands like:
 *
 *   # Check the files
 *   git status
 *   ls -la
 *
 * The original tryRewriteSingle sees `#` as the first word and skips the
 * entire block. This wrapper splits by newlines, rewrites each independent
 * command line, and reassembles.
 */
function tryRewrite(command: string): RewriteResult | null {
  // Fast path: single-line commands (most common)
  if (!command.includes("\n")) {
    return tryRewriteSingle(command);
  }

  // Global heredoc check — if the whole command has `<<`, bail out.
  // (Lines inside the heredoc body could false-match rules.)
  if (command.includes("<<")) return null;

  const rawLines = command.split("\n");
  const logical = mergeContLines(rawLines);

  const rewrittenLines: string[] = [];
  let anyRewritten = false;
  const hitRules: string[] = [];

  for (const ln of logical) {
    const trimmed = ln.trimStart();

    // Preserve comments and blank lines as-is
    if (trimmed === "" || trimmed.startsWith("#")) {
      rewrittenLines.push(ln);
      continue;
    }

    const result = tryRewriteSingle(trimmed);
    if (result) {
      // Preserve leading whitespace (indentation)
      const indent = ln.slice(0, ln.length - ln.trimStart().length);
      rewrittenLines.push(indent + result.rewritten);
      anyRewritten = true;
      if (!hitRules.includes(result.rule)) hitRules.push(result.rule);
    } else {
      rewrittenLines.push(ln);
    }
  }

  if (!anyRewritten) return null;

  return {
    rewritten: rewrittenLines.join("\n"),
    rule: hitRules.join(", "),
  };
}

// ── Extension entry point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Guard: skip if rtk is not installed
  if (!checkRtk()) {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify(
        "rtk-rewrite: `rtk` not found on PATH. Install from https://github.com/rtk-ai/rtk — extension disabled.",
        "warning",
      );
    });
    return;
  }

  let enabled = true;
  const stats: RewriteStats = { total: 0, skipped: 0, byRule: {} };

  // Reset stats on session switch
  pi.on("session_start", async () => {
    stats.total = 0;
    stats.skipped = 0;
    stats.byRule = {};
  });

  // Intercept bash tool calls and rewrite commands
  pi.on("tool_call", async (event, _ctx) => {
    if (!enabled) return;
    if (!isToolCallEventType("bash", event)) return;

    const command = event.input.command;
    if (typeof command !== "string" || command.length === 0) return;

    stats.total++;

    const result = tryRewrite(command);
    if (!result) {
      stats.skipped++;
      return;
    }

    // Mutate the command in-place
    event.input.command = result.rewritten;
    stats.byRule[result.rule] = (stats.byRule[result.rule] ?? 0) + 1;
  });

  // /rtk — show rewrite stats
  pi.registerCommand("rtk", {
    description: "Show RTK rewrite stats for this session",
    handler: async (_args, ctx) => {
      const rewritten = stats.total - stats.skipped;
      const lines = [
        `RTK Rewrite — ${enabled ? "enabled" : "DISABLED"}`,
        `Commands seen: ${stats.total}`,
        `Rewritten:     ${rewritten}`,
        `Passed through: ${stats.skipped}`,
      ];
      if (Object.keys(stats.byRule).length > 0) {
        lines.push("", "By rule:");
        const sorted = Object.entries(stats.byRule).sort((a, b) => b[1] - a[1]);
        for (const [rule, count] of sorted) {
          lines.push(`  ${rule}: ${count}`);
        }
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // /rtk:toggle — enable/disable
  pi.registerCommand("rtk:toggle", {
    description: "Toggle RTK command rewriting on/off",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      ctx.ui.notify(`RTK rewrite ${enabled ? "enabled" : "disabled"}`, "info");
      ctx.ui.setStatus("rtk", enabled ? undefined : "RTK off");
    },
  });
}
