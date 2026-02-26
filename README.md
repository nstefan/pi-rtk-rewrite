# pi-rtk-rewrite

A [pi coding agent](https://github.com/badlogic/pi-mono) extension that transparently rewrites bash commands to their [RTK](https://github.com/rtk-ai/rtk) equivalents for token-optimized LLM output.

RTK filters and summarises CLI output before it reaches the context window — fewer tokens, same semantics. This extension makes it automatic: the agent writes normal commands, the extension silently rewrites them to use `rtk`.

> Port of the [Claude Code hook](https://github.com/rtk-ai/rtk?tab=readme-ov-file#claude-code-hook) (`rtk-rewrite.sh`) for pi's extension system.

## Prerequisites

This extension requires **RTK** to be installed and available on your PATH.

RTK is a high-performance CLI proxy that filters and summarises system outputs before they reach your LLM context. Without it, the rewritten commands will fail.

👉 **[Install RTK](https://github.com/rtk-ai/rtk#install)** — see the [RTK repo](https://github.com/rtk-ai/rtk) for installation instructions, configuration, and the full list of supported commands.

```bash
# Verify rtk is installed
rtk --version
```

If `rtk` is not found on PATH at startup, the extension disables itself with a warning.

## Install

```bash
# From git
pi install git:github.com/nstefan/pi-rtk-rewrite

# Or try without installing
pi -e git:github.com/nstefan/pi-rtk-rewrite
```

## What gets rewritten

The extension intercepts `bash` tool calls and rewrites the command before execution. If `rtk` is not on PATH, the extension disables itself with a warning.

| Category | Commands | Rewrite |
|----------|----------|---------|
| **Git** | `git status/diff/log/add/commit/push/pull/branch/fetch/stash/show` | `rtk git …` |
| **GitHub CLI** | `gh pr/issue/run/api/release` | `rtk gh …` |
| **File ops** | `cat` | `rtk read` |
| | `grep "pattern" file` | `rtk grep "pattern" file` |
| | `ls` | `rtk ls` |
| | `tree` | `rtk tree` |
| | `diff file1 file2` | `rtk diff file1 file2` |
| | `head -N file` | `rtk read file --max-lines N` |
| **JS/TS** | `vitest`, `pnpm test` | `rtk vitest run` |
| | `npm test`, `npm run` | `rtk npm …` |
| | `tsc`, `vue-tsc`, `pnpm tsc` | `rtk tsc` |
| | `eslint`, `pnpm lint` | `rtk lint` |
| | `prettier` | `rtk prettier` |
| | `playwright` | `rtk playwright` |
| | `prisma` | `rtk prisma` |
| **Cargo** | `cargo test/build/clippy/check/install/fmt` | `rtk cargo …` |
| **Containers** | `docker ps/images/logs/run/build/exec/compose` | `rtk docker …` |
| | `kubectl get/logs/describe/apply` | `rtk kubectl …` |
| **Network** | `curl` | `rtk curl` |
| | `wget` | `rtk wget` |
| **Python** | `pytest`, `python -m pytest` | `rtk pytest` |
| | `ruff check/format` | `rtk ruff …` |
| | `pip list/install/show/outdated` | `rtk pip …` |
| | `uv pip …` | `rtk pip …` |
| **Go** | `go test/build/vet` | `rtk go …` |
| | `golangci-lint` | `rtk golangci-lint` |
| **pnpm** | `pnpm list/ls/outdated` | `rtk pnpm …` |

### Safety rules — skipped automatically

The extension is conservative about when to rewrite. Commands are **passed through unchanged** when:

- **Pipes or redirects** — `grep pattern file | wc -l`, `ls > out.txt`, `diff <(a) <(b)`. RTK adds summary lines (📊, 🔍) that break downstream consumers like `wc -l`, `sort`, `head`, etc. The detector respects quotes (pipes inside `"..."` or `'...'` are argument content, not shell operators).

- **Shell chaining** — `cmd1 && cmd2`, `cmd1 || cmd2`, subshells via `$()` or backticks.

- **GNU find** — `rtk find` uses glob-based `<PATTERN> [PATH]` syntax which is fundamentally incompatible with GNU find's `<PATH> [EXPRESSION]` syntax. Options like `-name`, `-type`, `-exec`, `-path` have no rtk equivalents.

- **Complex grep/rg** — Only simple `grep "pattern" file` or `grep -n "pattern" file` are rewritten. Any unsupported flags (`-r`, `-o`, `-P`, `-B`, `-A`, `-i`, `-c`, `-w`, `-v`, `--include`, `--exclude`, etc.) cause the rewrite to be skipped. This prevents errors from rtk grep's different argument parsing.

- **Already using rtk** — commands starting with `rtk` are never double-rewritten.

- **Heredocs** — commands containing `<<` are skipped.

- **Leading env vars** — preserved: `KEY=val git status` → `KEY=val rtk git status`.

## Commands

| Command | Description |
|---------|-------------|
| `/rtk` | Show rewrite stats for the current session |
| `/rtk:toggle` | Enable/disable rewriting on the fly |

## How it works

Pi's `tool_call` event fires before each tool execution. The extension:

1. Checks if the tool is `bash` and the command matches a rewrite rule
2. Verifies no pipes, redirects, or incompatible flags are present
3. Mutates `event.input.command` with the `rtk`-prefixed version
4. Pi executes the rewritten command — the agent sees compact output

No network calls, no dependencies, no external processes spawned.

## Development

```bash
git clone git@github.com:nstefan/pi-rtk-rewrite.git
cd pi-rtk-rewrite

# Test locally
pi -e ./extensions/rtk-rewrite.ts

# Run tests
npx tsx test/rewrite.test.ts

# Install from local path
pi install ./
```

## License

[MIT](LICENSE)
