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

function hasPipeOrRedirect(cmd: string): boolean {
  if (!/[|><`$]/.test(cmd) && !cmd.includes("&&") && !cmd.includes("||")) {
    return false;
  }
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    const next = cmd[i + 1];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (inSingle || inDouble) continue;
    if (ch === "|" && next !== "|") return true;
    if (ch === ">" && next !== "&") return true;
    if (ch === "<" && next === "(") return true;
    if (ch === "`") return true;
    if (ch === "$" && next === "(") return true;
    if (ch === "&" && next === "&") return true;
    if (ch === "|" && next === "|") return true;
  }
  return false;
}

const GREP_UNSAFE_FLAGS = /(?:^|\s)(-[A-Za-z]*[^n\s]|--include|--exclude|--only-matching|--perl-regexp|--extended-regexp|--files-with|--files-without|--count|--word-regexp|--invert-match|--line-regexp|--null|--recursive|--binary|--text|--color|--max-count|--after-context|--before-context|--context)/;

function isSimpleGrep(cmd: string): boolean {
  const args = cmd.replace(/^(rg|grep)\s+/, "");
  if (GREP_UNSAFE_FLAGS.test(args)) return false;
  return true;
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

// ── Tests: hasPipeOrRedirect ─────────────────────────────────────────────────

console.log("=== hasPipeOrRedirect ===");

// Should detect pipes
assert(hasPipeOrRedirect("ls | wc -l"), "detect pipe");
assert(hasPipeOrRedirect("grep pattern file | head"), "detect grep pipe");
assert(hasPipeOrRedirect("ls -la | sort -k5"), "detect sort pipe");

// Should detect redirects
assert(hasPipeOrRedirect("echo hello > file"), "detect output redirect");
assert(hasPipeOrRedirect("cmd >> file"), "detect append redirect");

// Should detect process substitution
assert(hasPipeOrRedirect("diff <(cmd1) <(cmd2)"), "detect process sub");

// Should detect subshells
assert(hasPipeOrRedirect("echo $(pwd)"), "detect $() subshell");
assert(hasPipeOrRedirect("echo `pwd`"), "detect backtick subshell");

// Should detect chained commands
assert(hasPipeOrRedirect("cmd1 && cmd2"), "detect &&");
assert(hasPipeOrRedirect("cmd1 || cmd2"), "detect ||");

// Should NOT trigger on quoted pipes/redirects
assert(!hasPipeOrRedirect('grep "a|b" file'), "quoted pipe in double quotes");
assert(!hasPipeOrRedirect("grep 'a|b' file"), "quoted pipe in single quotes");
assert(!hasPipeOrRedirect('echo "hello > world"'), "quoted redirect");

// Should NOT trigger on simple commands
assert(!hasPipeOrRedirect("ls -la"), "no pipe in simple ls");
assert(!hasPipeOrRedirect("grep pattern file"), "no pipe in simple grep");
assert(!hasPipeOrRedirect('grep -n "test" src/'), "no pipe in grep -n");
assert(!hasPipeOrRedirect("find . -name '*.ts'"), "no pipe in find");
assert(!hasPipeOrRedirect("git status"), "no pipe in git status");

// Edge case: escaped pipe
assert(!hasPipeOrRedirect("grep 'a\\|b' file"), "escaped pipe in quotes");

// ── Tests: isSimpleGrep ──────────────────────────────────────────────────────

console.log("=== isSimpleGrep ===");

// Safe patterns
assert(isSimpleGrep('grep "pattern" file'), "simple grep");
assert(isSimpleGrep('grep pattern file'), "simple grep no quotes");
assert(isSimpleGrep('grep -n "pattern" file'), "grep -n is safe (rtk always shows line numbers)");
assert(isSimpleGrep('rg "pattern"'), "simple rg");
assert(isSimpleGrep('rg "pattern" src/'), "rg with path");

// Unsafe patterns
assert(!isSimpleGrep('grep -r "pattern" dir/'), "grep -r unsafe");
assert(!isSimpleGrep('grep -rn "pattern" dir/'), "grep -rn unsafe");
assert(!isSimpleGrep('grep -oP "\\d+" file'), "grep -oP unsafe");
assert(!isSimpleGrep('grep -o "pattern" file'), "grep -o unsafe");
assert(!isSimpleGrep('grep -B 5 "pattern" file'), "grep -B unsafe");
assert(!isSimpleGrep('grep -A 15 "pattern" file'), "grep -A unsafe");
assert(!isSimpleGrep('grep -C 3 "pattern" file'), "grep -C unsafe");
assert(!isSimpleGrep('grep --include="*.gd" "pattern" dir/'), "grep --include unsafe");
assert(!isSimpleGrep('grep --exclude="*.md" "pattern" dir/'), "grep --exclude unsafe");
assert(!isSimpleGrep('grep -c "pattern" file'), "grep -c unsafe");
assert(!isSimpleGrep('grep -l "pattern" dir/'), "grep -l unsafe");
assert(!isSimpleGrep('grep -L "pattern" dir/'), "grep -L unsafe");
assert(!isSimpleGrep('grep -w "pattern" file'), "grep -w unsafe");
assert(!isSimpleGrep('grep -v "pattern" file'), "grep -v (invert) unsafe");
assert(!isSimpleGrep('grep -P "\\d+" file'), "grep -P unsafe");
assert(!isSimpleGrep('grep -E "a|b" file'), "grep -E unsafe");
assert(!isSimpleGrep('grep --recursive "pattern" dir/'), "grep --recursive unsafe");
assert(!isSimpleGrep('grep --color "pattern" file'), "grep --color unsafe");
assert(!isSimpleGrep('grep -i "pattern" file'), "grep -i unsafe (no rtk equiv)");
assert(!isSimpleGrep('grep -m 5 "pattern" file'), "grep -m unsafe (conflicts with rtk -m)");
assert(!isSimpleGrep('grep --max-count=5 "pattern" file'), "grep --max-count unsafe");
assert(!isSimpleGrep('grep --after-context=3 "pattern"'), "grep --after-context unsafe");
assert(!isSimpleGrep('grep --before-context=3 "pattern"'), "grep --before-context unsafe");
assert(!isSimpleGrep('grep --context=3 "pattern"'), "grep --context unsafe");

// -n is the ONLY safe single-char flag
assert(isSimpleGrep('grep -n "pattern" file'), "grep -n still safe");
assert(!isSimpleGrep('grep -ni "pattern" file'), "grep -ni unsafe (i is unsafe)");

// ── Tests: splitEnvPrefix ────────────────────────────────────────────────────

console.log("=== splitEnvPrefix ===");

assertEqual(splitEnvPrefix("ls -la")[0], "", "no env prefix");
assertEqual(splitEnvPrefix("FOO=bar ls -la")[0], "FOO=bar ", "single env var");
assertEqual(splitEnvPrefix("FOO=bar BAZ=qux ls")[0], "FOO=bar BAZ=qux ", "multiple env vars");
assertEqual(splitEnvPrefix("FOO=bar ls -la")[1], "ls -la", "body after env");

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
