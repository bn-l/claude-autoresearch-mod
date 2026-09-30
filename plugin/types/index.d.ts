// The values this mod keeps in `$.state` for the session: what the band, the dashboard
// pane and the tool rows draw, and the loop's bookkeeping that must outlive a hot reload.
// The shapes mirror hooks/app/host.ts (View, LoopState, ToolDetails) and
// hooks/upstream/experiment-core.ts (ExperimentState).

export type AutoresearchStatus = 'keep' | 'discard' | 'crash' | 'checks_failed'

export type AutoresearchResult = {
  commit: string
  metric: number
  metrics: Record<string, number>
  status: AutoresearchStatus
  description: string
  timestamp: number
  segment: number
  confidence: number | null
  asi?: Record<string, unknown>
}

export type AutoresearchMetricDef = { name: string; unit: string }

export type AutoresearchExperiment = {
  results: AutoresearchResult[]
  bestMetric: number | null
  bestDirection: 'lower' | 'higher'
  metricName: string
  metricUnit: string
  secondaryMetrics: AutoresearchMetricDef[]
  name: string | null
  currentSegment: number
  maxExperiments: number | null
  confidence: number | null
}

export type AutoresearchRunning = { startedAt: number; command: string; toolUseId?: string }

export type AutoresearchRunTail = { toolUseId: string; elapsed: string; tail: string }

export type AutoresearchToolNames = {
  init_experiment: string
  run_experiment: string
  log_experiment: string
}

export type AutoresearchLoop = {
  sessionId: string
  mode: boolean
  busy: boolean
  turnId: string | null
  pendingUserMessage: boolean
  pendingResumeMessage: string | null
  experimentsThisSession: number
  autoResumeTurns: number
  lastRunChecks: { pass: boolean; output: string; duration: number } | null
  lastRunDuration: number | null
  toolNames: AutoresearchToolNames | null
  questionWait: AutoresearchQuestionWait | null
}

export type AutoresearchQuestionWait = { until: number; minutes: number }

export type AutoresearchRunRow = {
  command: string
  exitCode: number | null
  durationSeconds: number
  passed: boolean
  crashed: boolean
  timedOut: boolean
  tailOutput: string
  checksPass: boolean | null
  checksTimedOut: boolean
  checksOutput: string
  checksDuration: number
  parsedMetrics: Record<string, number> | null
  parsedPrimary: number | null
  metricName: string
  metricUnit: string
  truncation?: { truncated: boolean; truncatedBy: 'lines' | 'bytes' | null; outputLines: number; totalLines: number }
  fullOutputPath?: string
}

export type AutoresearchLogRow = {
  experiment: AutoresearchResult
  runNumber: number
  bestMetric: number | null
  best: number | null
  metricName: string
  metricUnit: string
  secondaryMetrics: AutoresearchMetricDef[]
  wallClockSeconds: number | null
}

export type AutoresearchToolDetails =
  | { tool: 'init_experiment' }
  | { tool: 'run_experiment'; details: AutoresearchRunRow }
  | { tool: 'log_experiment'; details: AutoresearchLogRow }

export type AutoresearchPane = { offset: number }

declare module 'claude-code' {
  interface PluginState {
    autoresearch: {
      mode: boolean
      experiment: AutoresearchExperiment
      running: AutoresearchRunning | null
      runTail: AutoresearchRunTail | null
      loop: AutoresearchLoop
      pane: AutoresearchPane
      toolDetails: StateFamily<AutoresearchToolDetails | null>
    }
  }
}
