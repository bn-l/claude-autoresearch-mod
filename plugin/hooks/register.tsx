// autoresearch: pi-autoresearch as a Claude Code mod. This module is the wiring: it
// builds the one Host the app runs on out of `$` (the only place `$` is spelled; the
// scanner follows `$` into no other file), and answers each engine event with the app
// handler that stands for the pi event or registration upstream used.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, SessionCompactResult } from 'claude-code'

import type {
  AutoresearchExperiment,
  AutoresearchLoop,
  AutoresearchPane,
  AutoresearchRunTail,
  AutoresearchRunning,
  AutoresearchToolDetails,
} from '../types/index.d.ts'
import { createApp, toolNameOf, type App, type CompactMessage, type ToolName } from './app/index.ts'
import type { Host, NoticeLevel, Spawned, SpawnEnd, ToolDetails, View } from './app/host.ts'
import type { Options } from './app/context.ts'
import { createExperimentState, dashboardHintVariants, clamp, type ExperimentState } from './upstream/experiment-core.ts'
import { widgetLines, widgetRunningLine } from './upstream/dashboard-lines.ts'
import {
  renderInitCall,
  renderInitResult,
  renderLogCall,
  renderLogResult,
  renderRunCall,
  renderRunPartial,
  renderRunResult,
} from './upstream/tool-render.ts'
import { markerTheme } from './ui/styled.ts'
import { truncateToWidth } from './upstream/vendor/tui-width.ts'
import { linesTree, outputText, textTree } from './ui/draw.tsx'
import { PANE_ID, paneLayout, paneTree, scrolledOffset, type PaneActions } from './ui/pane.tsx'

// ---------------------------------------------------------------------------
// $.state (types/index.d.ts)
// ---------------------------------------------------------------------------

const MODE = { plugin: 'autoresearch', key: 'mode' } as const
const EXPERIMENT = { plugin: 'autoresearch', key: 'experiment' } as const
const RUNNING = { plugin: 'autoresearch', key: 'running' } as const
const RUN_TAIL = { plugin: 'autoresearch', key: 'runTail' } as const
const LOOP = { plugin: 'autoresearch', key: 'loop' } as const
const PANE = { plugin: 'autoresearch', key: 'pane' } as const
const TOOL_DETAILS = { plugin: 'autoresearch', key: 'toolDetails' } as const

const modeAtom = atom(MODE, false)
const experimentAtom = atom(EXPERIMENT, createExperimentState() as AutoresearchExperiment)
const runningAtom = atom(RUNNING, null as AutoresearchRunning | null)
const runTailAtom = atom(RUN_TAIL, null as AutoresearchRunTail | null)
const paneAtom = atom(PANE, { offset: 0 } as AutoresearchPane)

/** Our three tools, under whichever name they are served (`mcp__autoresearch__…` from a
 * plugin folder, `mcp__plugin_autoresearch_…__…` once installed): F1. */
const OUR_TOOLS = /^mcp__[\w-]*autoresearch[\w-]*__(?:init|run|log)_experiment$/

const COMMAND_DESCRIPTION = 'Start, stop, clear, export, or open dashboards for autoresearch mode'

/** How many rows keep their drawing details, per tool (run rows carry output tails). */
const DETAIL_ROWS_KEPT: Record<ToolName, number> = { init_experiment: 50, run_experiment: 60, log_experiment: 500 }

/** $.fs reads and writes stop at 4 MiB; a longer file is read through `cat`. */
const FS_LIMIT_BYTES = 4 * 1024 * 1024

/** A toast within this long of the plugin's last one is dropped by the host (F7). */
const TOAST_GAP_MS = 2000

function optionsOf(options: PluginOptions): Options {
  const percent = Number(options.compactAtPercent ?? 70)
  const wait = Number(options.questionWaitMinutes ?? 5)
  return {
    autoApproveTools: options.autoApproveTools !== false,
    compactAtPercent: Number.isFinite(percent) ? percent : 70,
    questionWaitMinutes: Number.isFinite(wait) && wait >= 0 ? wait : 5,
  }
}

function baseToolName(tool: string): ToolName | null {
  const match = /__(init|run|log)_experiment$/.exec(tool)
  return match && OUR_TOOLS.test(tool) ? (`${match[1]}_experiment` as ToolName) : null
}

// Module state: one app per load of this module (a reload loads it afresh).
let pluginOptions: Options = optionsOf({})
let app: App | null = null
let started: Promise<void> | null = null

// Toast coalescing (F7): notices within the host's 2 s window become one toast.
let lastToastAt = 0
let queuedNotices: string[] = []
let noticeTimer: { cancel: () => void } | null = null

// Drawing details kept per tool, oldest first, so old rows are let go.
const detailRows: Record<ToolName, string[]> = { init_experiment: [], run_experiment: [], log_experiment: [] }

// The pane's geometry as last drawn, for the key handlers' clamping.
let paneGeometry: { maxScroll: number; viewportRows: number } = { maxScroll: 0, viewportRows: 1 }

// Multi-line notices raised while one of our commands runs: its output row (F7).
let commandOutput: string[] | null = null

/** Runs a command's handler and answers with the multi-line notices it raised, if any. */
async function commandAnswer(run: () => Promise<void>): Promise<{ text?: string }> {
  commandOutput = []
  try {
    await run()
    return commandOutput.length > 0 ? { text: commandOutput.join('\n\n') } : {}
  } finally {
    commandOutput = null
  }
}

// What was last written to each value, so unchanged ones are not written again.
const published = new Map<string, string>()
// Values whose last write was refused, reported once until a write succeeds again.
const refused = new Set<string>()
let writes: Promise<unknown> = Promise.resolve()

function hostOf($: EngineInterface): Host {
  const queue = (key: string, value: unknown, write: () => Promise<unknown>) => {
    const json = JSON.stringify(value)
    if (published.get(key) === json) return
    published.set(key, json)
    writes = writes
      .then(write)
      .then(() => refused.delete(key))
      .catch(error => {
        published.delete(key)
        const message = `autoresearch: could not update the display (${key}): ${error instanceof Error ? error.message : String(error)}`
        if (refused.has(key)) $.ui.log(message, { to: 'debug' })
        else $.ui.log(message)
        refused.add(key)
      })
  }

  const showToast = (text: string) => {
    lastToastAt = Date.now()
    $.ui.toast(text)
  }

  const flushNotices = () => {
    noticeTimer = null
    if (queuedNotices.length === 0) return
    const text = queuedNotices.join(' · ')
    queuedNotices = []
    showToast(text)
  }

  return {
    pluginRoot: $.plugin.root,

    sessionCwd: () => $.session.cwd(),
    sessionId: () => $.session.id(),
    hasTerminal: async () => (await $.session.surfaces()).includes('terminal'),
    tmpDir: async () => ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/+$/, '') || '/tmp',
    parentPid: () => $.env.get('CLAUDE_PID'),
    contextPercent: async () => (await $.session.usage()).context.percent ?? null,
    // `/compact`, as the person runs it: the engine raises session.compact itself, so our
    // hook answers it (a plugin's own `$.session.compact()` skips that plugin's hook).
    compact: async () => {
      await $.command.run({ command: 'compact', args: '' })
    },

    readText: async path => {
      let size: number
      try {
        size = (await $.fs.stat(path)).size
      } catch {
        return null
      }
      if (size < FS_LIMIT_BYTES) return $.fs.read(path)
      let text = ''
      for await (const chunk of $.process.spawn({ argv: ['cat', '--', path] })) {
        if (chunk.stream === 'stdout') text += chunk.text
      }
      return text
    },
    writeText: (path, text) => $.fs.write(path, text),
    appendText: async (path, text) => {
      const result = await $.process.run(
        ['bash', '-c', 'mkdir -p -- "$(dirname -- "$1")" && cat >> "$1"', 'autoresearch-append', path],
        { stdin: text },
      )
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `append to ${path} failed`)
    },
    exists: path => $.fs.exists(path),
    kind: async path => {
      try {
        const { kind } = await $.fs.stat(path)
        return kind === 'dir' ? 'directory' : kind === 'file' ? 'file' : 'other'
      } catch {
        return null
      }
    },
    realPath: async path => {
      try {
        return (await $.fs.stat(path, { resolve: true })).realPath ?? null
      } catch {
        return null
      }
    },
    isExecutable: async path => (await $.process.run(['test', '-x', path])).exitCode === 0,
    remove: async path => {
      const result = await $.process.run(['rm', '-f', '--', path])
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `rm ${path} failed`)
    },

    run: (argv, init) => $.process.run(argv, init),
    spawn: (argv, init): Spawned => {
      const stream = $.process.spawn({ argv, cwd: init.cwd, env: init.env })
      const result: Promise<SpawnEnd> = stream.result
      result.catch(() => undefined)
      const stop = () => {
        void stream.return({ code: null, signal: 'SIGTERM' }).catch(() => undefined)
      }
      if (init.signal?.aborted) stop()
      else init.signal?.addEventListener('abort', stop, { once: true })
      return { result, [Symbol.asyncIterator]: () => stream }
    },

    after: (ms, fn) => $.clock.after(ms, fn),
    every: (ms, fn) => $.clock.every(ms, fn),

    notify: (text: string, level: NoticeLevel) => {
      const line = level === 'error' ? `Error: ${text}` : text
      if (line.includes('\n')) {
        // A transcript line is one line: a command shows it as its own output, anything
        // else logs it line by line.
        if (commandOutput) commandOutput.push(line)
        else for (const part of line.split('\n')) $.ui.log(part || ' ')
        return
      }
      const since = Date.now() - lastToastAt
      if (since >= TOAST_GAP_MS && queuedNotices.length === 0) {
        showToast(line)
        return
      }
      queuedNotices.push(line)
      noticeTimer ??= $.clock.after(Math.max(0, TOAST_GAP_MS - since) + 50, flushNotices)
    },
    closeDashboard: () => {
      void $.ui.close({ id: PANE_ID }).catch(() => undefined)
    },

    submit: text => {
      void $.prompt.submit({ text }).catch(error => {
        $.ui.log(`autoresearch: could not send the prompt: ${error instanceof Error ? error.message : String(error)}`)
      })
    },
    abortTurn: turnId => $.turn.abort({ turnId }),
    registerTool: async spec => (await $.tool.register(spec)).tool,
    invalidate: event => $.ui.invalidate(event),

    publish: (view: Partial<View>) => {
      if (view.mode !== undefined) {
        const value = view.mode
        queue('mode', value, () => $.state.set(MODE, value))
      }
      if (view.experiment !== undefined) {
        const value = view.experiment as AutoresearchExperiment
        queue('experiment', value, () => $.state.set(EXPERIMENT, value))
      }
      if (view.running !== undefined) {
        const value = view.running
        queue('running', value, () => $.state.set(RUNNING, value))
      }
      if (view.runTail !== undefined) {
        const value = view.runTail
        queue('runTail', value, () => $.state.set(RUN_TAIL, value))
      }
      if (view.loop !== undefined) {
        const value = view.loop as AutoresearchLoop
        queue('loop', value, () => $.state.set(LOOP, value))
      }
    },
    setToolDetails: (toolUseId: string, details: ToolDetails) => {
      const rows = detailRows[details.tool]
      rows.push(toolUseId)
      const value = details as AutoresearchToolDetails
      writes = writes.then(() => $.state.set({ ...TOOL_DETAILS, id: toolUseId }, value)).catch(() => undefined)
      while (rows.length > DETAIL_ROWS_KEPT[details.tool]) {
        const old = rows.shift()!
        writes = writes.then(() => $.state.set({ ...TOOL_DETAILS, id: old }, null)).catch(() => undefined)
      }
    },
    loadLoop: async () => (await $.state.get(LOOP)).value,
    storeGet: key => $.store.get(key),
    storeSet: (key, value) => $.store.set(key, value),
    storeKeys: () => $.store.keys(),
    storeDelete: key => $.store.delete(key),

    post: async (url, body) => ({ status: (await $.http.fetch(url, { method: 'POST', body })).status }),
    openUrl: async url => {
      const opened = await $.process.run(['open', url]).catch(() => null)
      if (opened?.exitCode === 0) return
      await $.process.run(['xdg-open', url])
    },
  }
}

/** The band's line while a question waits for a reply (I9): when the loop carries on. */
function questionWaitLine(until: number, width: number): string {
  const at = new Date(until)
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  return truncateToWidth(
    markerTheme.fg('warning', `  💬 The model asked you something. The loop carries on at ${time} unless you reply.`),
    width,
  )
}

function appOf($: EngineInterface): App {
  app ??= createApp(hostOf($), pluginOptions)
  return app
}

/** The app, started: session.start starts it, and any hook reached first does too. */
async function ready($: EngineInterface): Promise<App> {
  const current = appOf($)
  started ??= current.sessionStart().catch(error => {
    $.ui.log(`autoresearch: could not start: ${error instanceof Error ? error.message : String(error)}`)
  })
  await started
  return current
}

async function openDashboard($: EngineInterface): Promise<void> {
  await $.state.set(PANE, { offset: 0 })
  const state = await read($, experimentAtom)
  const opened = await $.ui.open({
    id: PANE_ID,
    title: `🔬 autoresearch${state.name ? `: ${state.name}` : ''}`,
    focus: true,
    closeOnEscape: true,
    holdToasts: true,
  })
  if (!opened.isPlaced) $.ui.toast(`Dashboard waits: ${opened.reason}`)
}

export const register: Register = (on, options) => {
  pluginOptions = optionsOf(options)

  // -------------------------------------------------------------------------
  // Session
  // -------------------------------------------------------------------------

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'autoresearch', description: COMMAND_DESCRIPTION, argumentHint: '[off|clear|export|dashboard|<text>]', immediate: true })
    await $.command.register({ name: 'autoresearch-dashboard', description: 'Fullscreen autoresearch dashboard', immediate: true })
    await $.command.register({ name: 'autoresearch-export', description: 'Open the autoresearch browser dashboard', immediate: true })
    await $.command.register({ name: 'autoresearch-off', description: 'Turn autoresearch mode off', immediate: true })
    await ready($)
    return next(e)
  })

  on('command.run', { command: ['clear', 'resume'] }, async ($, e, next) => {
    const result = await next(e)
    const current = await ready($)
    await current.sessionSwitched()
    return result
  })

  on('session.end', async ($, e, next) => {
    if (app) {
      if (e.reason === 'clear' || e.reason === 'resume') $.ui.close({ id: PANE_ID }).catch(() => undefined)
      else app.sessionEnd()
    }
    return next(e)
  })

  // -------------------------------------------------------------------------
  // Turns and prompts (pi agent_start / agent_end / before_agent_start)
  // -------------------------------------------------------------------------

  on('turn.start', async ($, e, next) => {
    ;(await ready($)).turnStart(e.turnId)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) (await ready($)).turnComplete(e.isAborted, e.answer)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const current = await ready($)
    const kind = e.origin.kind
    if (kind === 'composer' || kind === 'bridge' || kind === 'sdk') current.foreignPrompt()
    await current.promptSubmitted()
    return next(e)
  })

  on('prompt.section', { name: 'env_info_simple' }, async ($, e, next) => {
    const base = await next(e)
    const current = await ready($)
    if (!current.isModeOn()) return base
    return { text: await current.sectionText(base.text) }
  })

  // -------------------------------------------------------------------------
  // The three tools (F1, F2, F10)
  // -------------------------------------------------------------------------

  on('tool.describe', { tool: OUR_TOOLS }, async ($, e, next) => {
    const described = await next(e)
    const current = await ready($)
    return { ...described, isDeferred: !current.isModeOn() }
  })

  on('tool.check', { tool: OUR_TOOLS }, async ($, e, next) => {
    const current = await ready($)
    if (current.isModeOn() && current.ctx.options.autoApproveTools) return { decision: 'allow' }
    return next(e)
  })

  on('tool.call', { tool: OUR_TOOLS }, async ($, e, next) => {
    const current = await ready($)
    const name = toolNameOf(current.ctx, e.tool)
    if (!name) return next(e)
    const { tool: _tool, tool_use_id: toolUseId, agentId: _agentId, ...input } = e as Record<string, unknown> & { tool: string; tool_use_id: string }
    let answer: Awaited<ReturnType<App['callTool']>>
    try {
      answer = await current.callTool(name, input, toolUseId, next.signal)
    } catch (error) {
      // Esc: the engine has gone on without this call (the row reads Interrupted); what
      // upstream threw ("aborted") would only show up as a hook failure.
      if (next.signal.aborted) return { result: 'Interrupted' }
      throw error
    }
    if ('deny' in answer) return { deny: answer.deny }
    return answer.context && answer.context.length > 0
      ? { result: answer.result, context: answer.context }
      : { result: answer.result }
  })

  // -------------------------------------------------------------------------
  // /autoresearch and its argument-less shortcuts (F6)
  // -------------------------------------------------------------------------

  on('command.run', { command: 'autoresearch' }, async ($, e) => {
    const current = await ready($)
    return commandAnswer(async () => {
      const outcome = await current.command(e.args)
      if (outcome.openDashboard) await openDashboard($)
    })
  })

  on('command.run', { command: 'autoresearch-dashboard' }, async $ => {
    const current = await ready($)
    return commandAnswer(async () => {
      const outcome = await current.dashboardCommand()
      if (outcome.openDashboard) await openDashboard($)
    })
  })

  on('command.run', { command: 'autoresearch-export' }, async $ => {
    const current = await ready($)
    return commandAnswer(() => current.exportCommand())
  })

  on('command.run', { command: 'autoresearch-off' }, async $ => {
    const current = await ready($)
    return commandAnswer(() => current.offCommand())
  })

  // -------------------------------------------------------------------------
  // Compaction (§4.10)
  // -------------------------------------------------------------------------

  on('session.compact', async ($, e, next) => {
    const current = await ready($)
    const answer = await current.compact({ trigger: e.trigger, agentId: e.agentId, messages: e.messages as readonly CompactMessage[] })
    if (answer === null) return next(e)
    // Our messages are SessionMessage rows: the kept ones with their handles, the summary built.
    return answer as SessionCompactResult
  })

  // -------------------------------------------------------------------------
  // The widget above the prompt (pi setWidget, F12)
  // -------------------------------------------------------------------------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, modeAtom))) return next(e)
    const state = (await read($, experimentAtom)) as ExperimentState
    const width = e.props.bodyColumns
    let lines: string[]
    if (state.results.length === 0) {
      const running = await read($, runningAtom)
      if (!running) return next(e)
      lines = [widgetRunningLine(state, running, width, markerTheme)]
    } else {
      lines = widgetLines(state, width, markerTheme, dashboardHintVariants())
    }
    // I9: under the title, while the loop waits for the person's reply.
    const wait = (await $.state.get(LOOP)).value?.questionWait
    if (wait) lines.splice(1, 0, questionWaitLine(wait.until, width))
    const { Box, Text } = $.ui.resolve(e)
    return linesTree({ Box, Text }, lines, width)
  })

  // -------------------------------------------------------------------------
  // Tool rows (pi renderCall / renderResult)
  // -------------------------------------------------------------------------

  on('ui.render', { component: 'ToolUse', props: { tool: OUR_TOOLS } }, async ($, e, next) => {
    const name = baseToolName(e.props.tool)
    if (!name) return next(e)
    const input = (e.props.input ?? {}) as Record<string, unknown>
    let text =
      name === 'init_experiment'
        ? renderInitCall(input, markerTheme)
        : name === 'run_experiment'
          ? renderRunCall(input, markerTheme)
          : renderLogCall(input, markerTheme)
    // 2.1.285 hands our rows `isRunning: false` throughout, so the run's own state says
    // which row is live: no output yet, not cut, and the call the running run belongs to.
    const isLive =
      name === 'run_experiment' &&
      !e.props.isInterrupted &&
      e.props.output === undefined &&
      (e.props.isRunning || (await read($, runningAtom))?.toolUseId === e.props.tool_use_id)
    if (isLive) {
      const tail = await read($, runTailAtom)
      const live = tail?.toolUseId === e.props.tool_use_id ? tail : null
      text += '\n' + renderRunPartial(live?.elapsed ?? '', live?.tail ?? '', false, markerTheme)
    }
    if (e.props.isInterrupted) text += '\n' + markerTheme.fg('error', 'Interrupted')
    const { Box, Text } = $.ui.resolve(e)
    return textTree({ Box, Text }, text)
  })

  on('ui.render', { component: 'ToolResult', props: { tool: OUR_TOOLS } }, async ($, e, next) => {
    const name = baseToolName(e.props.tool)
    if (!name || e.props.isErrored) return next(e)
    const stored = (await $.state.get({ ...TOOL_DETAILS, id: e.props.tool_use_id })).value as ToolDetails | null | undefined
    const output = outputText(e.props.output)
    let text: string
    if (name === 'init_experiment') text = renderInitResult(output)
    else if (name === 'run_experiment') text = renderRunResult(stored?.tool === 'run_experiment' ? stored.details : undefined, output, false, markerTheme)
    else text = renderLogResult(stored?.tool === 'log_experiment' ? stored.details : undefined, output, markerTheme)
    const { Box, Text } = $.ui.resolve(e)
    return textTree({ Box, Text }, text)
  })

  // -------------------------------------------------------------------------
  // The fullscreen dashboard (pi ctx.ui.custom overlay, F5)
  // -------------------------------------------------------------------------

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const state = (await read($, experimentAtom)) as ExperimentState
    const running = await read($, runningAtom)
    const { offset } = await read($, paneAtom)
    const layout = paneLayout({
      state,
      running,
      width: e.props.bodyColumns,
      bodyRows: e.props.scroll.bodyRows,
      offset,
      now: Date.now(),
    })
    paneGeometry = { maxScroll: layout.maxScroll, viewportRows: layout.viewportRows }

    const moveTo = (to: (held: number) => number) => {
      void update($, paneAtom, held => ({ offset: clamp(to(held.offset), 0, paneGeometry.maxScroll) }))
    }
    const actions: PaneActions = {
      scrollBy: rows => moveTo(held => held + rows),
      scrollPage: pages => moveTo(held => held + pages * paneGeometry.viewportRows),
      top: () => moveTo(() => 0),
      bottom: () => moveTo(() => paneGeometry.maxScroll),
      close: () => {
        void $.ui.close({ id: PANE_ID }).catch(() => undefined)
      },
    }

    if (e.surface === 'terminal' || e.surface === 'desktop') {
      const { Box, Text, Button, Client } = $.ui.resolve(e)
      return paneTree({ Box, Text, Button, Client }, layout, actions)
    }
    const { Box, Text, Button } = $.ui.resolve(e)
    return paneTree({ Box, Text, Button }, layout, actions)
  })

  on('ui.scroll', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { offset } = await read($, paneAtom)
    const to = scrolledOffset({ offset, ...paneGeometry }, e)
    if (to !== offset) await $.state.set(PANE, { offset: to })
    return {}
  })

  on('ui.message', { requestId: PANE_ID }, async ($, e, next) => {
    const data = (e.data ?? {}) as { scroll?: number; page?: number; top?: boolean; bottom?: boolean; close?: boolean }
    if (data.close) {
      await $.ui.close({ id: PANE_ID }).catch(() => undefined)
      return next(e)
    }
    await update($, paneAtom, held => {
      let offset = held.offset
      if (typeof data.scroll === 'number') offset += data.scroll
      if (typeof data.page === 'number') offset += data.page * paneGeometry.viewportRows
      if (data.top) offset = 0
      if (data.bottom) offset = paneGeometry.maxScroll
      return { offset: clamp(offset, 0, paneGeometry.maxScroll) }
    })
    return next(e)
  })
}
