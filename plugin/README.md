# autoresearch

Autonomous experiment loops for Claude Code: try an idea, measure it, keep what works,
discard what doesn't, repeat. A port of
[pi-autoresearch](https://github.com/davebcn87/pi-autoresearch) v1.8.1.

Requires Claude Code 2.1.285+ with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. Start with
`/autoresearch <goal>`; `/autoresearch` alone prints the help. The repository's README
covers setup, unattended runs and configuration, and DEVIATIONS.md every difference from
upstream.
