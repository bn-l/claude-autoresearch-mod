// The world beneath the plugin for `claude plugin test`: a session in `cwd`, files in
// memory, the store, env and clock mocked, and every call the plugin makes on the UI,
// the prompt and processes recorded. Only what the wiring tests need; the behaviour
// itself is tested end to end on Node (e2e/) and in real Claude Code.

import { mock, type MockClock } from 'claude-code/testing'
import type { On, RenderSurface, SessionMessage } from 'claude-code'

export const PLUGIN = 'autoresearch'
export const tool = (name: 'init_experiment' | 'run_experiment' | 'log_experiment') => `mcp__autoresearch__${name}` as const

export interface WorldInit {
  cwd?: string
  sessionId?: string
  files?: Record<string, string>
  surfaces?: RenderSurface[]
  contextPercent?: number
}

export interface World {
  cwd: string
  files: Map<string, string>
  clock: MockClock
  registered: string[]
  submitted: string[]
  /** For each submitted prompt: whether the model reads it as the person's own words. */
  submittedAsUser: boolean[]
  toasts: string[]
  /** The status lines set, undefined for a removal. */
  statuses: (string | undefined)[]
  logs: string[]
  invalidated: string[]
  opened: string[]
  closed: string[]
  aborted: string[]
  runs: string[][]
  /** What the engine's own compaction was asked to do (the bottom of session.compact). */
  engineCompactions: string[]
  contextPercent: number
}

export function world(on: On, init: WorldInit = {}): World {
  const w: World = {
    cwd: init.cwd ?? '/work',
    files: new Map(Object.entries(init.files ?? {})),
    clock: mock.clock(on, { now: 1_000_000 }),
    registered: [],
    submitted: [],
    submittedAsUser: [],
    toasts: [],
    statuses: [],
    logs: [],
    invalidated: [],
    opened: [],
    closed: [],
    aborted: [],
    runs: [],
    engineCompactions: [],
    contextPercent: init.contextPercent ?? 10,
  }
  mock.store(on)
  mock.env(on, { TMPDIR: '/tmp/' })

  // A key starting with `*` stands for every path ending in the rest (plugin files,
  // whose root the test does not know).
  const fileAt = (path: string): string | undefined => {
    const exact = w.files.get(path)
    if (exact !== undefined) return exact
    for (const [key, text] of w.files) if (key.startsWith('*') && path.endsWith(key.slice(1))) return text
    return undefined
  }

  const isDir = (path: string) => {
    const prefix = path.endsWith('/') ? path : `${path}/`
    if (path === w.cwd) return true
    for (const file of w.files.keys()) if (file.startsWith(prefix)) return true
    return false
  }

  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: init.sessionId ?? 'session-1' }))
  on('session.cwd', () => ({ value: w.cwd }))
  on('session.surfaces', () => ({ value: init.surfaces ?? ['terminal'] }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000, percent: w.contextPercent }, rateLimits: [] },
  }))
  on('session.compact', (_$, e) => {
    w.engineCompactions.push(e.trigger)
    return { messages: [{ role: 'user', text: 'engine summary', toolUses: [] }] as SessionMessage[] }
  })

  on('fs.read', (_$, e) => {
    const text = fileAt(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.write', (_$, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', (_$, e) => ({ value: fileAt(e.path) !== undefined || isDir(e.path) }))
  on('fs.stat', (_$, e) => {
    const text = fileAt(e.path)
    if (text === undefined && !isDir(e.path)) return { deny: `ENOENT: ${e.path}` }
    return {
      value: {
        kind: text === undefined ? ('dir' as const) : ('file' as const),
        size: text?.length ?? 0,
        mtimeMs: 0,
        isLink: false,
        ...(e.resolve ? { realPath: e.path } : {}),
      },
    }
  })

  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    w.runs.push(argv)
    const ok = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    if (argv[0] === 'test' && argv[1] === '-x') return { value: { ...ok, exitCode: 1 } }
    if (argv[0] === 'rm') {
      w.files.delete(argv[argv.length - 1]!)
      return { value: ok }
    }
    if (argv[0] === 'bash' && argv[3] === 'autoresearch-append') {
      const path = argv[4]!
      w.files.set(path, (w.files.get(path) ?? '') + (e.init?.stdin ?? ''))
      return { value: ok }
    }
    return { value: ok }
  })

  on('tool.register', (_$, e) => {
    w.registered.push(e.name)
    return { value: { tool: tool(e.name as 'run_experiment') } }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('prompt.submit', (_$, e) => {
    w.submitted.push(e.text)
    w.submittedAsUser.push(e.origin.kind === 'plugin' && e.origin.asUser === true)
    return { text: e.text }
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'Claude Code', scope: 'shared' as const }] }))
  on('turn.abort', (_$, e) => {
    w.aborted.push(String((e as { turnId?: string }).turnId))
    return { value: undefined }
  })

  on('ui.toast', (_$, e) => {
    w.toasts.push(typeof e === 'string' ? e : String((e as { text?: string }).text))
    return { value: undefined }
  })
  on('ui.log', (_$, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.invalidate', (_$, e) => {
    w.invalidated.push(String((e as { event?: string }).event ?? e))
    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', (_$, e) => {
    w.closed.push(e.id)
    return { value: undefined }
  })

  return w
}

/** A log with a config line and one kept baseline run, as upstream writes them. */
export function logWithBaseline(): string {
  return [
    JSON.stringify({ type: 'config', name: 'sort speed', metricName: 'total_ms', metricUnit: 'ms', bestDirection: 'lower' }),
    JSON.stringify({
      run: 1,
      commit: 'abc1234',
      metric: 42,
      metrics: {},
      status: 'keep',
      description: 'baseline',
      timestamp: 1,
      segment: 0,
      confidence: null,
    }),
    '',
  ].join('\n')
}

/** A log with `runs` runs: a baseline, then keeps and discards taking turns. */
export function logWithRuns(runs: number): string {
  const lines = [JSON.stringify({ type: 'config', name: 'sort speed', metricName: 'total_ms', metricUnit: 'ms', bestDirection: 'lower' })]
  for (let run = 1; run <= runs; run++) {
    lines.push(
      JSON.stringify({
        run,
        commit: `c${String(run).padStart(6, '0')}`,
        metric: 100 - run,
        metrics: {},
        status: run === 1 || run % 2 === 0 ? 'keep' : 'discard',
        description: run === 1 ? 'baseline' : `idea ${run}`,
        timestamp: run,
        segment: 0,
        confidence: null,
      }),
    )
  }
  return lines.join('\n') + '\n'
}
