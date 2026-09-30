# autoresearch for Claude Code

*Try an idea, measure it, keep what works, discard what doesn't, repeat forever.*

A Claude Code mod that runs autonomous optimization loops: try an idea, benchmark it, keep
improvements, revert regressions, repeat. It is a port of
[pi-autoresearch](https://github.com/davebcn87/pi-autoresearch) v1.8.1 (by Tobi Lutke and
David Cortés) from the [pi](https://pi.dev/) agent to Claude Code, keeping its prompts,
tools, session files, log format, widget, dashboards, command, hooks and skills. Works for
any optimization target: test speed, bundle size, model training, build times, Lighthouse
scores.

Inspired by [karpathy/autoresearch](https://github.com/karpathy/autoresearch).

A session is portable: `.auto/log.jsonl` written by pi-autoresearch resumes here, and one
written here resumes in pi. Everything that behaves differently from upstream is listed
in [DEVIATIONS.md](DEVIATIONS.md).

## Quick start

```bash
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1        # mods are early access
claude --plugin-dir /path/to/this/repo/plugin --permission-mode auto
```

Then, inside Claude Code:

```text
/autoresearch optimize unit test runtime, monitor correctness
```

To try it on a toy project first, copy [`examples/sort-bench`](examples/sort-bench) somewhere,
make it a git repository, and run `/autoresearch make sort.js faster` in it.

## Install

Requires Claude Code **2.1.285** or newer with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` set.
The browser dashboard also needs `node` (18 or newer) or `bun` on `PATH`.

- **For one session:** `claude --plugin-dir /path/to/this/repo/plugin`
- **Installed:** this repository is a plugin marketplace.

  ```bash
  claude plugin marketplace add /path/to/this/repo      # or its GitHub owner/repo
  claude plugin install autoresearch@bn-l
  ```

## What's included

| | |
| --- | --- |
| **Tools** | `init_experiment`, `run_experiment`, `log_experiment` |
| **Command** | `/autoresearch` and three argument-less shortcuts |
| **UI** | A live results band above the prompt, rich tool rows, a fullscreen dashboard pane, a browser dashboard |
| **Skills** | `autoresearch-create`, `autoresearch-finalize`, `autoresearch-hooks` |

### Tools

| Tool | Description |
| --- | --- |
| `init_experiment` | One-time session config: name, metric, unit, direction |
| `run_experiment` | Runs a command, times it, captures output, runs the checks |
| `log_experiment` | Records the result, commits a keep, reverts anything else, updates the band and dashboards |

Claude Code serves them as `mcp__autoresearch__init_experiment` and so on; the system
prompt tells the model which name is which. While autoresearch mode is off the tools stay
out of the way and refuse to run.

### `/autoresearch`

| Subcommand | Description |
| --- | --- |
| `/autoresearch` | Show help without activating autoresearch mode. |
| `/autoresearch <text>` | Enter autoresearch mode. If `.auto/prompt.md` exists, resumes the loop with `<text>` as context. Otherwise the `autoresearch-create` skill sets up a new session. |
| `/autoresearch off` | Leave autoresearch mode. Aborts a running turn, stops auto-resume, keeps `.auto/log.jsonl`. |
| `/autoresearch clear` | Delete `.auto/log.jsonl`, reset all state, and turn autoresearch mode off. |
| `/autoresearch web` | Open a live dashboard in your browser. It updates as experiments are logged. `/autoresearch export`, pi's name for it, does the same. |
| `/autoresearch dashboard` | Open the fullscreen dashboard in the terminal. |

`/autoresearch-dashboard`, `/autoresearch-export` and `/autoresearch-off` do the same with
no arguments, so they can be bound to keys. Nothing is bound by default; to bind one, add
it to `~/.claude/keybindings.json`, for example:

```json
{ "bindings": [{ "context": "Chat", "bindings": { "ctrl+shift+y": "command:autoresearch-dashboard" } }] }
```

### UI

- **Band**: above the prompt while autoresearch mode is on. Run count, kept and
  discarded, confidence, baseline and best, and the latest runs with commit, metric,
  status and description. It shows a running line while the first run is in progress.
- **Tool rows**: each tool call draws as upstream's rows do: the command and a live
  `⏳ Running 12s…` with the output tail while a benchmark runs, then the outcome, metric
  and checks.
- **Fullscreen dashboard**: `/autoresearch dashboard` opens every run in a pane, with a
  live spinner for a running experiment. Keys: `↓`/`j`, `↑`/`k`, PageDown/`d`, PageUp/`u`,
  Home/`g`, End (bottom), `q` or Esc to close.
- **Confidence score**: after 3+ runs, how the best improvement compares to the session's
  noise floor (median absolute deviation). ≥ 2.0× is likely real, 1.0–2.0× marginal,
  < 1.0× within noise. Advisory only.
- **Browser dashboard**: `/autoresearch web` serves upstream's page (chart, table,
  share card) from a small local helper that exits with Claude Code.

### Skills

- **`autoresearch-create`** asks (or infers) the goal, command, metric and files in
  scope, writes `.auto/prompt.md` and `.auto/measure.sh`, and starts the loop.
  `/autoresearch <goal>` loads it when there is no `.auto/prompt.md`.
- **`autoresearch-finalize`** turns a noisy autoresearch branch into clean, independent
  branches, one per logical change. Run it as `/autoresearch:autoresearch-finalize`.
- **`autoresearch-hooks`** helps write `.auto/hooks/before.sh` and `after.sh`, with ten
  example scripts.

## Session files

All session files live in `.auto/` at the working directory root, which reverts never
touch. Legacy flat `autoresearch.*` files are still read for in-flight sessions.

| File | Purpose |
| --- | --- |
| `.auto/prompt.md` | Objective, metrics, files in scope, what's been tried. A fresh agent can resume from this alone. |
| `.auto/measure.sh` | The benchmark: pre-checks, runs the workload, prints `METRIC name=number` lines. |
| `.auto/log.jsonl` | Append-only log of every run, written by the tools. |
| `.auto/ideas.md` | *(optional)* Ideas backlog. |
| `.auto/checks.sh` | *(optional)* Correctness checks run after each passing benchmark; a failure blocks `keep`. |
| `.auto/config.json` | *(optional)* `workingDir` and `maxIterations`. |
| `.auto/hooks/` | *(optional)* `before.sh` and `after.sh`, run around iterations. |

## Running unattended

Autoresearch is meant to run for hours without you. Three things decide whether it can.

**Permissions.** The three tools run without prompting while the mode is on (turn that
off with the `autoApproveTools` option). Everything else the model does (editing files,
running git or node, improvising a shell command) follows your permission mode, and one
unanswered prompt stalls the loop. Use `--permission-mode auto` (or `/permissions`),
preferably in a dedicated branch, worktree or sandbox. `acceptEdits` with an allow-list
such as `Bash(git:*) Bash(node:*)` works until the model reaches for a command outside it.

**Auto-resume.** When a turn ends after logging an experiment, the mod sends "Run the next
iteration now" 800 ms later. It stops after 200 resumes, after more than 20 discards and
crashes in a row, at `maxIterations`, or on `/autoresearch off`. **Esc pauses the loop**:
nothing is resumed until you send a message that leads to a logged experiment ("continue").

**Questions.** When a turn ends by asking you something, the loop waits
`questionWaitMinutes` (5 by default) for your reply, and the band says until when. Reply and
the model gets your answer first; stay away and the loop carries on, telling the model that
nobody replied so it makes the call itself. Telling a question apart is a guess from the
turn's last lines (a question mark, or words like "your call" or "should I"), so now and
then it waits when it needn't, or not at all. `0` carries on at once, as upstream does.

**Context.** Between iterations, once the context window is `compactAtPercent` full (70 by
default), the mod compacts the conversation before the next iteration. The summary is
built from the session files (upstream's compaction summary: prompt, ideas, the last 50
runs), so it takes milliseconds and no model call, and the current iteration is kept
whole. A manual `/compact` gets the same treatment, and the model is told to finish an
in-flight iteration first. `compactAtPercent` is a plugin option (see [Configuration](#configuration)).

## Configuration

`.auto/config.json` under the session's working directory:

```json
{ "workingDir": "/path/to/project", "maxIterations": 50 }
```

| Field | Description |
| --- | --- |
| `workingDir` | Directory for all autoresearch operations: files, commands and git. Absolute, or relative to the session's working directory. Must exist. Sessions in a redirected directory only turn on by themselves if this Claude Code session turned them on. |
| `maxIterations` | Experiments before stopping. The mode turns off and the turn ends. |

Plugin options. For an installed copy, set them with `claude plugin configure autoresearch@bn-l`
(or `/plugin configure autoresearch@bn-l` inside Claude Code), or in settings under the
plugin's full ID:

```json
{ "pluginConfigs": { "autoresearch@bn-l": { "options": { "compactAtPercent": 60 } } } }
```

For a `--plugin-dir` session the key is `autoresearch`, for example
`--settings '{"pluginConfigs":{"autoresearch":{"options":{"questionWaitMinutes":1}}}}'`.

| Option | Default | Description |
| --- | --- | --- |
| `autoApproveTools` | `true` | Run the three tools without a permission prompt while the mode is on. |
| `compactAtPercent` | `70` | Compact between iterations at this context fill; `0` turns it off. |
| `questionWaitMinutes` | `5` | When a turn asks you something, wait this long for your reply before the loop carries on; `0` doesn't wait. |

## Backpressure checks

Create `.auto/checks.sh` to run tests, types or lint after every benchmark that exits 0.
Its time does not count toward the metric. If it fails or times out (default 300 s,
`checks_timeout_seconds`), `log_experiment` refuses `keep` and the run is logged as
`checks_failed` and reverted.

## Hooks

Executable `.auto/hooks/before.sh` and `.auto/hooks/after.sh` run at iteration boundaries:
`after.sh` at the end of every `log_experiment`, `before.sh` after it and at activation.
Each gets a one-line JSON payload on stdin (see upstream's README for the shapes); its
stdout (up to 8 KB) is shown to the model after the tool result. A non-zero exit or a run
past 30 s is reported to the model. Each run is recorded in `.auto/log.jsonl`. Examples:
`plugin/skills/autoresearch-hooks/examples/`.

## Security and trust

Autoresearch edits files, commits and reverts, and runs `.auto/measure.sh`,
`.auto/checks.sh` and `.auto/hooks/` as you. Treat those files as code: review them, keep
credentials out of scope, work in a dedicated branch or worktree with a clean tree, and
use a sandbox for untrusted projects. Commits made by `log_experiment` skip the
repository's git hooks.

## Controlling costs

Loops run until stopped. Cap them with `maxIterations`, with your plan's or API key's
limits, and by picking the model and effort for the session (`--model`, `--effort`).

## Development

```bash
npm install
npm run typecheck
npm test                       # unit, engine-less end-to-end, and the mod's wiring tests
scripts/sync-upstream.sh       # regenerate plugin/skills and plugin/assets from upstream/
scripts/sync-upstream.sh --check <sha>   # ...and list what upstream changed in the ported code since 939ede8
```

- `upstream/`: pi-autoresearch as a git subtree at `939ede8`, read-only.
- `plugin/`: the mod. `hooks/upstream/` holds upstream's pure code, ported verbatim with
  provenance comments; `hooks/app/` the behaviour, written against a small host interface;
  `hooks/register.tsx` the Claude Code wiring.
- `unit/`, `e2e/`: upstream's unit tests, and end-to-end suites on Node with real git and
  bash; `e2e/claude/` drives a real Claude Code in tmux.
- `patches/`: every text edit to upstream's skills.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
