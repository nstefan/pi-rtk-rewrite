# pi-rtk-rewrite

A [pi](https://github.com/badlogic/pi-mono) extension that intercepts `bash` tool calls and rewrites them to [RTK](https://github.com/rtk-ai/rtk) equivalents — the agent writes normal commands, the extension silently prefixes them with `rtk` before execution.

> Port of the [Claude Code hook](https://github.com/rtk-ai/rtk?tab=readme-ov-file#claude-code-hook) (`rtk-rewrite.sh`) for pi's extension system.

## Install

Requires [RTK](https://github.com/rtk-ai/rtk#install) on PATH. Disables itself with a warning if not found.

```bash
pi install git:github.com/nstfn/pi-rtk-rewrite

# Or try without installing
pi -e git:github.com/nstfn/pi-rtk-rewrite
```

## How it works

Pi fires a `tool_call` event before each tool execution. The extension:

1. Checks if the tool is `bash` and the command matches a rewrite rule
2. Mutates `event.input.command` in-place with the `rtk`-prefixed version
3. Pi executes the rewritten command — the agent sees compact output

No network calls, no dependencies, no spawned processes.

### What gets rewritten

| Category | Commands | Rewrite |
|----------|----------|---------|
| **Git** | `git status/diff/log/add/commit/push/pull/branch/fetch/stash/show` | `rtk git …` |
| **GitHub CLI** | `gh pr/issue/run/api/release` | `rtk gh …` |
| **File ops** | `cat` | `rtk read` |
| | `grep`, `rg` (all flags) | `rtk grep` |
| | `ls` | `rtk ls` |
| | `tree` | `rtk tree` |
| | `find` | `rtk find` |
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

### Skip rules

- Commands starting with `rtk` — never double-rewritten
- Heredocs (`<<`) — skipped entirely
- Leading env vars — preserved: `KEY=val git status` → `KEY=val rtk git status`
- Pipes, redirects, `&&`/`||` — rewritten through (aggressive, matches Claude hook)

### Multi-line commands

Unlike the Claude hook which treats the entire command as a single string, this extension rewrites each line independently:

```
# Comment preserved
git status          → rtk git status
echo separator      → echo separator (no rule)
ls -la              → rtk ls -la
```

## Real-world results

Tested live inside a pi session (Godot 4.6 project, ~1,400 bash tool calls tracked):

| Metric | Value |
|--------|-------|
| Total commands tracked | 1,418 |
| Input tokens | 5.5M |
| Output tokens | 1.9M |
| **Tokens saved** | **3.6M (65.7%)** |
| Avg exec overhead | 308ms |

Top savers: `cargo test` (1.1M saved, 99.8%), `cargo clippy` (948K, 99.1%), `ls` (571K across 655 calls), `git commit` (156K, 97.3%).

### Verified rewrites

Each row tested live — the extension intercepted the bash tool call and rtk produced compact output:

| Pi bash tool call | Rewritten to | Result |
|-------------------|-------------|--------|
| `ls -la` | `rtk ls -la` | ✅ Compact output with file sizes + summary |
| `cat project.godot` | `rtk read project.godot` | ✅ |
| `tree scenes/ -L 1` | `rtk tree scenes/ -L 1` | ✅ |
| `head -5 DESIGN.md` | `rtk read DESIGN.md --max-lines 5` | ✅ |
| `git status` | `rtk git status` | ✅ One-line compact output |
| `git log --oneline -5` | `rtk git log --oneline -5` | ✅ |
| `git diff --stat HEAD~1` | `rtk git diff --stat HEAD~1` | ✅ |
| `grep "extends" file.gd` | `rtk grep "extends" file.gd` | ✅ Formatted with file grouping |
| `curl -s <url>` | `rtk curl -s <url>` | ✅ Compact JSON |
| `FOO=bar git status` | `FOO=bar rtk git status` | ✅ Env prefix preserved |
| `rtk gain` | `rtk gain` (unchanged) | ✅ No double-rewrite |
| `echo`, `pwd`, `wc` | unchanged | ✅ Correctly passed through |
| Multi-line block | Each line rewritten independently | ✅ Comments preserved |

## Known limitations

The extension rewrites correctly in all cases below — the errors come from flag-syntax mismatches between native CLI tools and their `rtk` equivalents:

| Pi bash tool call | Issue | Workaround |
|-------------------|-------|------------|
| `grep -rn "pattern" dir/` | `rtk grep` doesn't accept `-r`, `-n`, or combined flags like `-rn` | Use positional syntax: `grep "pattern" dir/` (rtk searches recursively by default) |
| `find . -name "*.ts" -maxdepth 2` | `rtk find` uses `<PATTERN> [PATH]` positional syntax, not `-name`/`-type` flags | Use `find "*.ts" .` or prefix with `command find` to bypass |
| `grep -oP`, `-B`, `--include` | Flags passed through but `rtk grep` may not support all of them | Use `command grep` to bypass, or check `rtk grep --help` |

To bypass rewriting for a specific command:
- Prefix with `command`: `command grep -rn "pattern" dir/`
- Use `/rtk:toggle` to temporarily disable all rewriting

## Commands

| Command | Description |
|---------|-------------|
| `/rtk` | Show rewrite stats for the current session |
| `/rtk:toggle` | Enable/disable rewriting on the fly |

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
