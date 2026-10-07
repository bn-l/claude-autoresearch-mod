# pi-autoresearch for Claude Code

Uses the new mods api to change claude code's UI for the same autoresearch experience as in pi.

A Claude Code mod that runs autonomous optimization loops. It will try an idea, benchmark it, keep improvements, revert regressions and repeat this process in a structured way.

<p align="center">
  <img src="assets/tsp-dark.svg" alt="autoresearch shortening travelling salesman tours in Claude Code" width="100%">
</p>

For more information see, [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch), this is an almost 1:1 port of that (removing some small bugs).

Inspired by [karpathy/autoresearch](https://github.com/karpathy/autoresearch).

The session format is the same as pi-autoresearch (`.auto/log.jsonl`) and can be used interchangedly.

## Quick start

```text
claude plugin marketplace add bn-l/claude-autoresearch-mod
claude plugin install autoresearch@bn-l
```

To try it on a toy project first, copy [`examples/sort-bench`](examples/sort-bench) somewhere,
make it a git repository, and run `/autoresearch make sort.js faster` in it.

## Requirements

Claude Code **2.1.285** or newer.

If using a version below **2.1.287** then set `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` set in `~/.claude/settings.json` (see [the docs](https://code.claude.com/docs/en/env-vars#in-settings-files) for more info).

The browser dashboard (very optional) requires `node` (18 or newer) or `bun`.
