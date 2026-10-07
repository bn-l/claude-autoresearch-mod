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
claude plugin install autoresearch --marketplace bn-l/claude-autoresearch-mod
```

To update: `claude plugin update autoresearch@bn-l`, or turn on auto-update for bn-l in `/plugin` → Marketplaces.

To try it on a toy project first, copy [`examples/sort-bench`](examples/sort-bench) somewhere,
make it a git repository, and run `/autoresearch make sort.js faster` in it.

## Requirements

Claude Code **2.1.292** or newer.

The browser dashboard (very optional) requires `node` (18 or newer) or `bun`.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `compactAtPercent` | 70 | Compacts between iterations once the context is this full (0 turns it off) |
| `questionWaitMinutes` | 5 | When a turn ends by asking you something, waits this long for your reply before carrying on (0 doesn't wait) |

`claude plugin configure autoresearch` shows them. To set one when installing, add `--config questionWaitMinutes=0` to the install command; to change one later:

```text
echo '{"questionWaitMinutes": "0"}' | claude plugin configure autoresearch --values-stdin
```
