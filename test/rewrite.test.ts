/**
 * Tests for the RTK rewrite logic.
 *
 * Run: npx tsx test/rewrite.test.ts
 * (No test framework needed — just assertions)
 */

// ── Inline the core functions for testing ────────────────────────────────────
// (We can't import the extension directly because it expects pi's API)

function splitEnvPrefix(cmd: string): [string, string] {
  const m = cmd.match(/^((?:[A-Za-z_][A-Za-z0-9_]*=[^ ]* +)+)/);
  if (m) return [m[1], cmd.slice(m[1].length)];
  return ["", cmd];
}

// ── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${message}`);
  }
}

function assertEqual(actual: any, expected: any, message: string) {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

// ── Inline rule matching for testing ─────────────────────────────────────────

function re(pattern: RegExp): (cmd: string) => boolean {
  return (cmd) => pattern.test(cmd);
}

const GIT_SUBCMDS = new Set([
  "status", "diff", "log", "add", "commit", "push",
  "pull", "branch", "fetch", "stash", "show",
]);

function gitSubcmd(cmd: string): string {
  return cmd
    .replace(/^git\s+/, "")
    .replace(/(-C|-c)\s+\S+\s*/g, "")
    .replace(/--\S+=\S+\s*/g, "")
    .replace(/--(no-pager|no-optional-locks|bare|literal-pathspecs)\s*/g, "")
    .trimStart()
    .split(/\s+/)[0] ?? "";
}

interface RewriteRule {
  label: string;
  match: (cmd: string) => boolean;
  rewrite: (cmdBody: string) => string;
}

const CARGO_SUBCMDS = new Set(["test", "build", "clippy", "check", "install", "fmt"]);

function dockerSubcmd(cmd: string): string {
  return cmd
    .replace(/^docker\s+/, "")
    .replace(/(-H|--context|--config)\s+\S+\s*/g, "")
    .replace(/--\S+=\S+\s*/g, "")
    .trimStart()
    .split(/\s+/)[0] ?? "";
}

const DOCKER_SIMPLE_SUBCMDS = new Set(["ps", "images", "logs", "run", "build", "exec"]);
const KUBECTL_SUBCMDS = new Set(["get", "logs", "describe", "apply"]);

function kubectlSubcmd(cmd: string): string {
  return cmd
    .replace(/^kubectl\s+/, "")
    .replace(/(--context|--kubeconfig|--namespace|-n)\s+\S+\s*/g, "")
    .replace(/--\S+=\S+\s*/g, "")
    .trimStart()
    .split(/\s+/)[0] ?? "";
}

const rules: RewriteRule[] = [
  { label: "git", match: (cmd) => re(/^git\s/)(cmd) && GIT_SUBCMDS.has(gitSubcmd(cmd)), rewrite: (body) => `rtk ${body}` },
  { label: "gh", match: re(/^gh\s+(pr|issue|run|api|release)(\s|$)/), rewrite: (body) => body.replace(/^gh /, "rtk gh ") },
  { label: "cargo", match: (cmd) => { if (!re(/^cargo\s/)(cmd)) return false; const sub = cmd.replace(/^cargo\s+(\+\S+\s+)?/, "").split(/\s+/)[0] ?? ""; return CARGO_SUBCMDS.has(sub); }, rewrite: (body) => `rtk ${body}` },
  { label: "cat → rtk read", match: re(/^cat\s+/), rewrite: (body) => body.replace(/^cat /, "rtk read ") },
  { label: "grep/rg", match: re(/^(rg|grep)\s+/), rewrite: (body) => body.replace(/^(rg|grep) /, "rtk grep ") },
  { label: "ls", match: re(/^ls(\s|$)/), rewrite: (body) => body.replace(/^ls/, "rtk ls") },
  { label: "tree", match: re(/^tree(\s|$)/), rewrite: (body) => body.replace(/^tree/, "rtk tree") },
  { label: "find", match: re(/^find\s+/), rewrite: (body) => body.replace(/^find /, "rtk find ") },
  { label: "diff", match: re(/^diff\s+/), rewrite: (body) => body.replace(/^diff /, "rtk diff ") },
  { label: "head → rtk read", match: re(/^head\s+(-\d+|--lines=\d+)\s+/), rewrite: (body) => {
    let m = body.match(/^head\s+-(\d+)\s+(.+)$/);
    if (m) return `rtk read ${m[2]} --max-lines ${m[1]}`;
    m = body.match(/^head\s+--lines=(\d+)\s+(.+)$/);
    if (m) return `rtk read ${m[2]} --max-lines ${m[1]}`;
    return body;
  }},
  { label: "vitest", match: re(/^(pnpm\s+)?(npx\s+)?vitest(\s|$)/), rewrite: (body) => body.replace(/^(pnpm\s+)?(npx\s+)?vitest(\s+run)?/, "rtk vitest run") },
  { label: "pnpm test", match: re(/^pnpm\s+test(\s|$)/), rewrite: (body) => body.replace(/^pnpm test/, "rtk vitest run") },
  { label: "npm test", match: re(/^npm\s+test(\s|$)/), rewrite: (body) => body.replace(/^npm test/, "rtk npm test") },
  { label: "npm run", match: re(/^npm\s+run\s+/), rewrite: (body) => body.replace(/^npm run /, "rtk npm ") },
  { label: "vue-tsc / tsc", match: re(/^(npx\s+)?vue-tsc(\s|$)/), rewrite: (body) => body.replace(/^(npx\s+)?vue-tsc/, "rtk tsc") },
  { label: "pnpm tsc", match: re(/^pnpm\s+tsc(\s|$)/), rewrite: (body) => body.replace(/^pnpm tsc/, "rtk tsc") },
  { label: "tsc", match: re(/^(npx\s+)?tsc(\s|$)/), rewrite: (body) => body.replace(/^(npx\s+)?tsc/, "rtk tsc") },
  { label: "pnpm lint", match: re(/^pnpm\s+lint(\s|$)/), rewrite: (body) => body.replace(/^pnpm lint/, "rtk lint") },
  { label: "eslint", match: re(/^(npx\s+)?eslint(\s|$)/), rewrite: (body) => body.replace(/^(npx\s+)?eslint/, "rtk lint") },
  { label: "prettier", match: re(/^(npx\s+)?prettier(\s|$)/), rewrite: (body) => body.replace(/^(npx\s+)?prettier/, "rtk prettier") },
  { label: "playwright", match: re(/^(npx\s+|pnpm\s+)?playwright(\s|$)/), rewrite: (body) => body.replace(/^(npx\s+|pnpm\s+)?playwright/, "rtk playwright") },
  { label: "prisma", match: re(/^(npx\s+)?prisma(\s|$)/), rewrite: (body) => body.replace(/^(npx\s+)?prisma/, "rtk prisma") },
  { label: "docker compose", match: re(/^docker\s+compose(\s|$)/), rewrite: (body) => body.replace(/^docker /, "rtk docker ") },
  { label: "docker", match: (cmd) => re(/^docker\s/)(cmd) && !re(/^docker\s+compose/)(cmd) && DOCKER_SIMPLE_SUBCMDS.has(dockerSubcmd(cmd)), rewrite: (body) => body.replace(/^docker /, "rtk docker ") },
  { label: "kubectl", match: (cmd) => re(/^kubectl\s/)(cmd) && KUBECTL_SUBCMDS.has(kubectlSubcmd(cmd)), rewrite: (body) => body.replace(/^kubectl /, "rtk kubectl ") },
  { label: "curl", match: re(/^curl\s+/), rewrite: (body) => body.replace(/^curl /, "rtk curl ") },
  { label: "wget", match: re(/^wget\s+/), rewrite: (body) => body.replace(/^wget /, "rtk wget ") },
  { label: "pnpm list/outdated", match: re(/^pnpm\s+(list|ls|outdated)(\s|$)/), rewrite: (body) => body.replace(/^pnpm /, "rtk pnpm ") },
  { label: "pytest", match: re(/^pytest(\s|$)/), rewrite: (body) => body.replace(/^pytest/, "rtk pytest") },
  { label: "python -m pytest", match: re(/^python\s+-m\s+pytest(\s|$)/), rewrite: (body) => body.replace(/^python -m pytest/, "rtk pytest") },
  { label: "ruff", match: re(/^ruff\s+(check|format)(\s|$)/), rewrite: (body) => body.replace(/^ruff /, "rtk ruff ") },
  { label: "pip", match: re(/^pip\s+(list|outdated|install|show)(\s|$)/), rewrite: (body) => body.replace(/^pip /, "rtk pip ") },
  { label: "uv pip", match: re(/^uv\s+pip\s+(list|outdated|install|show)(\s|$)/), rewrite: (body) => body.replace(/^uv pip /, "rtk pip ") },
  { label: "go test", match: re(/^go\s+test(\s|$)/), rewrite: (body) => body.replace(/^go test/, "rtk go test") },
  { label: "go build", match: re(/^go\s+build(\s|$)/), rewrite: (body) => body.replace(/^go build/, "rtk go build") },
  { label: "go vet", match: re(/^go\s+vet(\s|$)/), rewrite: (body) => body.replace(/^go vet/, "rtk go vet") },
  { label: "golangci-lint", match: re(/^golangci-lint(\s|$)/), rewrite: (body) => body.replace(/^golangci-lint/, "rtk golangci-lint") },
];

function tryRewriteSingle(command: string): { rewritten: string; rule: string } | null {
  if (/^rtk\s/.test(command) || /\/rtk\s/.test(command)) return null;
  if (command.includes("<<")) return null;

  const [envPrefix, body] = splitEnvPrefix(command);

  for (const rule of rules) {
    if (rule.match(body)) {
      const rewrittenBody = rule.rewrite(body);
      if (rewrittenBody === body) continue;
      return { rewritten: envPrefix + rewrittenBody, rule: rule.label };
    }
  }
  return null;
}

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
  if (buf) out.push(buf);
  return out;
}

function tryRewrite(command: string): { rewritten: string; rule: string } | null {
  if (!command.includes("\n")) return tryRewriteSingle(command);
  if (command.includes("<<")) return null;

  const rawLines = command.split("\n");
  const logical = mergeContLines(rawLines);

  const rewrittenLines: string[] = [];
  let anyRewritten = false;
  const hitRules: string[] = [];

  for (const ln of logical) {
    const trimmed = ln.trimStart();
    if (trimmed === "" || trimmed.startsWith("#")) {
      rewrittenLines.push(ln);
      continue;
    }
    const result = tryRewriteSingle(trimmed);
    if (result) {
      const indent = ln.slice(0, ln.length - ln.trimStart().length);
      rewrittenLines.push(indent + result.rewritten);
      anyRewritten = true;
      if (!hitRules.includes(result.rule)) hitRules.push(result.rule);
    } else {
      rewrittenLines.push(ln);
    }
  }
  if (!anyRewritten) return null;
  return { rewritten: rewrittenLines.join("\n"), rule: hitRules.join(", ") };
}

// ── Tests: splitEnvPrefix ────────────────────────────────────────────────────

console.log("=== splitEnvPrefix ===");

assertEqual(splitEnvPrefix("ls -la")[0], "", "no env prefix");
assertEqual(splitEnvPrefix("FOO=bar ls -la")[0], "FOO=bar ", "single env var");
assertEqual(splitEnvPrefix("FOO=bar BAZ=qux ls")[0], "FOO=bar BAZ=qux ", "multiple env vars");
assertEqual(splitEnvPrefix("FOO=bar ls -la")[1], "ls -la", "body after env");

// ── Tests: Core rewrites (matching Claude hook behavior) ─────────────────────

console.log("=== Core rewrites ===");

// Git
assertEqual(tryRewriteSingle("git status")?.rewritten, "rtk git status", "git status");
assertEqual(tryRewriteSingle("git diff --stat")?.rewritten, "rtk git diff --stat", "git diff --stat");
assertEqual(tryRewriteSingle("git log --oneline -5")?.rewritten, "rtk git log --oneline -5", "git log");
assertEqual(tryRewriteSingle("git -C /tmp/repo status")?.rewritten, "rtk git -C /tmp/repo status", "git -C status");
assertEqual(tryRewriteSingle("git --no-pager log")?.rewritten, "rtk git --no-pager log", "git --no-pager log");
assert(tryRewriteSingle("git clone url") === null, "git clone not rewritten");
assert(tryRewriteSingle("git checkout branch") === null, "git checkout not rewritten");

// GitHub CLI
assertEqual(tryRewriteSingle("gh pr list")?.rewritten, "rtk gh pr list", "gh pr list");
assertEqual(tryRewriteSingle("gh issue create")?.rewritten, "rtk gh issue create", "gh issue create");

// File operations
assertEqual(tryRewriteSingle("cat README.md")?.rewritten, "rtk read README.md", "cat → rtk read");
assertEqual(tryRewriteSingle("ls -la")?.rewritten, "rtk ls -la", "ls -la");
assertEqual(tryRewriteSingle("ls")?.rewritten, "rtk ls", "bare ls");
assertEqual(tryRewriteSingle("tree src/")?.rewritten, "rtk tree src/", "tree");
assertEqual(tryRewriteSingle("diff a.txt b.txt")?.rewritten, "rtk diff a.txt b.txt", "diff");
assertEqual(tryRewriteSingle("head -20 file.txt")?.rewritten, "rtk read file.txt --max-lines 20", "head -N");
assertEqual(tryRewriteSingle("head --lines=50 file.txt")?.rewritten, "rtk read file.txt --max-lines 50", "head --lines=N");

// Find (restored — matches Claude hook)
assertEqual(tryRewriteSingle("find . -name '*.ts'")?.rewritten, "rtk find . -name '*.ts'", "find rewritten");
assertEqual(tryRewriteSingle("find /tmp -type f")?.rewritten, "rtk find /tmp -type f", "find with -type");

// Grep/rg — ALL patterns rewritten (matches Claude hook, no flag checking)
assertEqual(tryRewriteSingle('grep "pattern" file')?.rewritten, 'rtk grep "pattern" file', "simple grep");
assertEqual(tryRewriteSingle('grep -rn "pattern" dir/')?.rewritten, 'rtk grep -rn "pattern" dir/', "grep -rn rewritten");
assertEqual(tryRewriteSingle('grep -oP "\\d+" file')?.rewritten, 'rtk grep -oP "\\d+" file', "grep -oP rewritten");
assertEqual(tryRewriteSingle('grep -B 5 "pattern" file')?.rewritten, 'rtk grep -B 5 "pattern" file', "grep -B rewritten");
assertEqual(tryRewriteSingle('grep --include="*.gd" "x" dir/')?.rewritten, 'rtk grep --include="*.gd" "x" dir/', "grep --include rewritten");
assertEqual(tryRewriteSingle('rg "pattern" src/')?.rewritten, 'rtk grep "pattern" src/', "rg rewritten");
assertEqual(tryRewriteSingle('grep -i "test" file')?.rewritten, 'rtk grep -i "test" file', "grep -i rewritten");

// Pipes and redirects — rewritten aggressively (matches Claude hook)
assertEqual(tryRewriteSingle("ls -la | wc -l")?.rewritten, "rtk ls -la | wc -l", "ls with pipe rewritten");
assertEqual(tryRewriteSingle("git status | head -5")?.rewritten, "rtk git status | head -5", "git with pipe rewritten");
assertEqual(tryRewriteSingle("cat file > out.txt")?.rewritten, "rtk read file > out.txt", "cat with redirect rewritten");
assertEqual(tryRewriteSingle("grep pattern file | sort")?.rewritten, "rtk grep pattern file | sort", "grep with pipe rewritten");
assertEqual(tryRewriteSingle("ls dir && echo done")?.rewritten, "rtk ls dir && echo done", "ls with && rewritten");

// Env prefix preserved
assertEqual(tryRewriteSingle("FOO=bar git status")?.rewritten, "FOO=bar rtk git status", "env prefix + git");
assertEqual(tryRewriteSingle("FOO=bar cat file.txt")?.rewritten, "FOO=bar rtk read file.txt", "env prefix + cat");

// Skip: already rtk
assert(tryRewriteSingle("rtk ls") === null, "already rtk");
assert(tryRewriteSingle("/usr/bin/rtk git status") === null, "already rtk (path)");

// Skip: heredocs
assert(tryRewriteSingle("cat <<EOF") === null, "heredoc skipped");

// JS/TS tooling
assertEqual(tryRewriteSingle("vitest run")?.rewritten, "rtk vitest run", "vitest run");
assertEqual(tryRewriteSingle("npx vitest")?.rewritten, "rtk vitest run", "npx vitest");
assertEqual(tryRewriteSingle("pnpm test")?.rewritten, "rtk vitest run", "pnpm test");
assertEqual(tryRewriteSingle("npm test")?.rewritten, "rtk npm test", "npm test");
assertEqual(tryRewriteSingle("npm run build")?.rewritten, "rtk npm build", "npm run build");
assertEqual(tryRewriteSingle("vue-tsc")?.rewritten, "rtk tsc", "vue-tsc");
assertEqual(tryRewriteSingle("pnpm tsc")?.rewritten, "rtk tsc", "pnpm tsc");
assertEqual(tryRewriteSingle("npx tsc --noEmit")?.rewritten, "rtk tsc --noEmit", "npx tsc");
assertEqual(tryRewriteSingle("pnpm lint")?.rewritten, "rtk lint", "pnpm lint");
assertEqual(tryRewriteSingle("eslint src/")?.rewritten, "rtk lint src/", "eslint");
assertEqual(tryRewriteSingle("npx prettier --check .")?.rewritten, "rtk prettier --check .", "prettier");
assertEqual(tryRewriteSingle("npx playwright test")?.rewritten, "rtk playwright test", "npx playwright");
assertEqual(tryRewriteSingle("pnpm playwright test")?.rewritten, "rtk playwright test", "pnpm playwright");
assertEqual(tryRewriteSingle("npx prisma migrate")?.rewritten, "rtk prisma migrate", "prisma");

// Cargo
assertEqual(tryRewriteSingle("cargo test")?.rewritten, "rtk cargo test", "cargo test");
assertEqual(tryRewriteSingle("cargo build --release")?.rewritten, "rtk cargo build --release", "cargo build");
assertEqual(tryRewriteSingle("cargo +nightly clippy")?.rewritten, "rtk cargo +nightly clippy", "cargo +nightly clippy");

// Containers
assertEqual(tryRewriteSingle("docker compose up")?.rewritten, "rtk docker compose up", "docker compose");
assertEqual(tryRewriteSingle("docker ps -a")?.rewritten, "rtk docker ps -a", "docker ps");
assertEqual(tryRewriteSingle("docker -H host logs container")?.rewritten, "rtk docker -H host logs container", "docker -H logs");
assertEqual(tryRewriteSingle("kubectl get pods")?.rewritten, "rtk kubectl get pods", "kubectl get");
assertEqual(tryRewriteSingle("kubectl --namespace prod logs pod")?.rewritten, "rtk kubectl --namespace prod logs pod", "kubectl -n logs");

// Network
assertEqual(tryRewriteSingle("curl -s https://api.example.com")?.rewritten, "rtk curl -s https://api.example.com", "curl");
assertEqual(tryRewriteSingle("wget https://example.com/file")?.rewritten, "rtk wget https://example.com/file", "wget");

// Python
assertEqual(tryRewriteSingle("pytest -v")?.rewritten, "rtk pytest -v", "pytest");
assertEqual(tryRewriteSingle("python -m pytest tests/")?.rewritten, "rtk pytest tests/", "python -m pytest");
assertEqual(tryRewriteSingle("ruff check src/")?.rewritten, "rtk ruff check src/", "ruff check");
assertEqual(tryRewriteSingle("pip install requests")?.rewritten, "rtk pip install requests", "pip install");
assertEqual(tryRewriteSingle("uv pip list")?.rewritten, "rtk pip list", "uv pip list");

// Go
assertEqual(tryRewriteSingle("go test ./...")?.rewritten, "rtk go test ./...", "go test");
assertEqual(tryRewriteSingle("go build -o bin/app")?.rewritten, "rtk go build -o bin/app", "go build");
assertEqual(tryRewriteSingle("go vet ./...")?.rewritten, "rtk go vet ./...", "go vet");
assertEqual(tryRewriteSingle("golangci-lint run")?.rewritten, "rtk golangci-lint run", "golangci-lint");

// pnpm package management
assertEqual(tryRewriteSingle("pnpm list")?.rewritten, "rtk pnpm list", "pnpm list");
assertEqual(tryRewriteSingle("pnpm outdated")?.rewritten, "rtk pnpm outdated", "pnpm outdated");

// ── Tests: Multi-line commands ───────────────────────────────────────────────

console.log("=== Multi-line commands ===");

assertEqual(
  tryRewrite("# check\ngit status\nls -la")?.rewritten,
  "# check\nrtk git status\nrtk ls -la",
  "multi-line: comments + commands"
);

assertEqual(
  tryRewrite("git status\ncat README.md")?.rewritten,
  "rtk git status\nrtk read README.md",
  "multi-line: two rewrites"
);

assert(
  tryRewrite("echo hello\necho world") === null,
  "multi-line: no matching commands"
);

assertEqual(
  tryRewrite("git status\necho separator\nls")?.rewritten,
  "rtk git status\necho separator\nrtk ls",
  "multi-line: partial rewrite"
);

// Multi-line with heredoc — entire block skipped
assert(
  tryRewrite("cat <<EOF\nhello\nEOF") === null,
  "multi-line: heredoc skipped entirely"
);

// Control flow — now rewritten per-line (no bail-out)
const controlFlowResult = tryRewrite("for f in *.ts; do\n  cat $f\ndone");
assert(controlFlowResult !== null, "control flow: per-line rewrite attempted");

// Line continuation — merged into single logical line but subcmd extraction
// can't parse across continuations. This matches Claude hook behavior (no
// special continuation handling). The merge still prevents false rewrites on
// the indented continuation line.
assert(
  tryRewrite("git \\\n  status") === null,
  "line continuation: git across continuation not rewritten (subcmd unresolvable)"
);

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
