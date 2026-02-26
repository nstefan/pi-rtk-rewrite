# pi-rtk-rewrite

A [pi coding agent](https://github.com/badlogic/pi-mono) extension that transparently rewrites bash commands to their [RTK](https://github.com/rtk-ai/rtk) equivalents for token-optimized LLM output.

RTK filters and summarises CLI output before it reaches the context window — fewer tokens, same semantics. This extension makes it automatic: the agent writes normal commands, the extension silently rewrites them to use `rtk`.

> Port of the [Claude Code hook](https://github.com/rtk-ai/rtk?tab=readme-ov-file#claude-code-hook) (`rtk-rewrite.sh`) for pi's extension system.

## Install

**Prerequisite:** [Install RTK](https://github.com/rtk-ai/rtk#install) first.

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
| | `grep`, `rg` | `rtk grep` |
| | `ls` | `rtk ls` |
| | `tree` | `rtk tree` |
| | `find` | `rtk find` |
| | `diff` | `rtk diff` |
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

### Skipped automatically

- Commands already using `rtk`
- Heredocs (`<<`)
- Commands with no matching rule (passed through unchanged)
- Leading env-var assignments are preserved (`KEY=val git status` → `KEY=val rtk git status`)

## Commands

| Command | Description |
|---------|-------------|
| `/rtk` | Show rewrite stats for the current session |
| `/rtk:toggle` | Enable/disable rewriting on the fly |

## How it works

Pi's `tool_call` event fires before each tool execution. The extension:

1. Checks if the tool is `bash` and the command matches a rewrite rule
2. Mutates `event.input.command` with the `rtk`-prefixed version
3. Pi executes the rewritten command — the agent sees compact output

No network calls, no dependencies, no external processes spawned.

## Development

```bash
git clone git@github.com:nstefan/pi-rtk-rewrite.git
cd pi-rtk-rewrite

# Test locally
pi -e ./extensions/rtk-rewrite.ts

# Install from local path
pi install ./
```

## License

[MIT](LICENSE)
