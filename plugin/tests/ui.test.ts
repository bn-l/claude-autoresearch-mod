// The drawings go through each surface's element table (nested Text, plain Buttons,
// the pane's Client), and the pane's own window moves on its keys, `ui.scroll` and the
// Client's posts. Content is checked for facts (run numbers, metric, command), not layout.

import { describe, expect, test, tier } from 'claude-code/testing'
import type { RenderSurface } from 'claude-code'

import { logWithBaseline, logWithRuns, tool, world, type World } from './support/world.ts'

tier('user')

const PANE_ID = 'autoresearch-dashboard'
const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const satisfies readonly RenderSurface[]
const CLIENT_SURFACES = ['terminal', 'desktop'] as const
const SESSION = { surface: 'terminal', isInteractive: true, cwd: '/work' } as const
const TYPED = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 11 },
  view: {},
}

const paneProps = (bodyRows: number) => ({
  title: '🔬 autoresearch: sort speed',
  isFocused: true,
  bodyColumns: 100,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows },
  view: {},
})

/** A benchmark that prints a line, then runs until the test's clock passes 5 s. */
function heldBenchmark(on: Parameters<typeof world>[0], w: () => World) {
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: 'sorting 1000 items\n' }
    await w().clock.sleep(5000)
    yield { stream: 'stdout' as const, text: 'METRIC total_ms=37\n' }
    return { value: { code: 0, signal: null } }
  })
}

describe('the band above the prompt', () => {
  for (const surface of SURFACES) {
    test(`draws the runs on ${surface}`, async ($, on) => {
      const w = world(on, { files: { '/work/.auto/log.jsonl': logWithBaseline() } })
      on('ui.render', () => ({ type: 'engine', ref: 0 }))
      await $.session.start(SESSION)
      await w.clock.settle()

      const band = await $.ui.mount({ plugin: 'autoresearch', surface, component: 'AbovePrompt', props: BAND })
      expect((await band.find({ text: /autoresearch: sort speed/ }))?.text).toBeDefined()
      expect((await band.find({ text: /baseline/ }))?.text).toBeDefined()
      expect((await band.findAll({ text: /42/ })).length).toBeGreaterThan(0)
      await band.unmount()
    })
  }

  test('stays out of the way while the mode is off', async ($, on) => {
    const w = world(on)
    on('ui.render', () => ({ type: 'engine', ref: 0 }))
    await $.session.start(SESSION)
    await w.clock.settle()

    const band = await $.ui.mount({ plugin: 'autoresearch', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await band.find({ text: /autoresearch/ })).toBeUndefined()
  })
})

describe('tool rows', () => {
  for (const surface of SURFACES) {
    test(`a running benchmark's row shows its command and output on ${surface}`, async ($, on) => {
      let w!: World
      heldBenchmark(on, () => w)
      w = world(on, { files: { '/work/.auto/log.jsonl': logWithBaseline() } })
      on('ui.render', () => ({ type: 'engine', ref: 0 }))
      await $.session.start(SESSION)

      const call = $.tool.call({ tool: tool('run_experiment'), tool_use_id: 'toolu_run', command: 'bash .auto/measure.sh' })
      await w.clock.advance(1000)

      const row = await $.ui.mount({
        plugin: 'autoresearch',
        surface,
        component: 'ToolUse',
        requestId: 'toolu_run',
        props: {
          tool_use_id: 'toolu_run',
          tool: tool('run_experiment'),
          input: { command: 'bash .auto/measure.sh' },
          // What 2.1.285 hands a plugin tool's row while it runs.
          isRunning: false,
          isErrored: false,
          isInterrupted: false,
        },
      })
      expect((await row.find({ text: /bash \.auto\/measure\.sh/ }))?.text).toBeDefined()
      expect((await row.find({ text: /⏳ Running \d+s…/ }))?.text).toBeDefined()
      expect((await row.find({ text: /sorting 1000 items/ }))?.text).toBeDefined()

      await w.clock.advance(5000)
      const answer = await call
      expect(answer.result).toContain('total_ms')

      const result = await $.ui.mount({
        plugin: 'autoresearch',
        surface,
        component: 'ToolResult',
        requestId: 'toolu_run',
        props: { tool_use_id: 'toolu_run', tool: tool('run_experiment'), output: answer.result, isErrored: false },
      })
      expect((await result.findAll({ text: /37/ })).length).toBeGreaterThan(0)
    })
  }
})

describe('the fullscreen dashboard', () => {
  for (const surface of SURFACES) {
    test(`opens from /autoresearch dashboard, scrolls and closes on ${surface}`, async ($, on) => {
      const w = world(on, { files: { '/work/.auto/log.jsonl': logWithRuns(40) } })
      await $.session.start(SESSION)
      await w.clock.settle()

      await $.command.run({ command: 'autoresearch', args: 'dashboard', ...TYPED })
      expect(w.opened).toEqual([PANE_ID])

      const pane = await $.ui.mount({ plugin: 'autoresearch', surface, component: 'Pane', requestId: PANE_ID, props: paneProps(12) })
      expect((await pane.find({ text: /sort speed/ }))?.text).toBeDefined()
      const info = async () => (await pane.find({ type: 'Text', text: /esc close/ }))?.text ?? ''
      expect(await info()).toMatch(/ 1-10\/\d+$/)

      await pane.press({ key: 'down' })
      expect(await info()).toMatch(/ 2-11\/\d+$/)
      await pane.press({ key: 'pagedown' })
      expect(await info()).toMatch(/ 12-21\/\d+$/)
      await pane.press({ key: 'top' })
      expect(await info()).toMatch(/ 1-10\/\d+$/)

      // End: the engine asks for the whole tree
      const total = Number(/\/(\d+)$/.exec(await info())?.[1])
      await $.ui.scroll({ component: 'Pane', requestId: PANE_ID, offset: 0, by: 10_000, bodyRows: 12, contentRows: 10_000, origin: { kind: 'person' } })
      expect(await info()).toMatch(new RegExp(` ${total - 9}-${total}/${total}$`))
      await $.ui.scroll({ component: 'Pane', requestId: PANE_ID, offset: 0, by: -1, bodyRows: 12, contentRows: 10_000, origin: { kind: 'person' } })
      expect(await info()).toMatch(new RegExp(` ${total - 10}-${total - 1}/${total}$`))

      await pane.press({ key: 'close' })
      expect(w.closed).toContain(PANE_ID)
    })
  }

  for (const surface of CLIENT_SURFACES) {
    test(`shows a spinner row while a run is going, which takes the vim keys, on ${surface}`, async ($, on) => {
      let w!: World
      heldBenchmark(on, () => w)
      w = world(on, { files: { '/work/.auto/log.jsonl': logWithRuns(3) } })
      await $.session.start(SESSION)

      const call = $.tool.call({ tool: tool('run_experiment'), tool_use_id: 'toolu_run', command: 'bash .auto/measure.sh' })
      await w.clock.settle()

      const pane = await $.ui.mount({ plugin: 'autoresearch', surface, component: 'Pane', requestId: PANE_ID, props: paneProps(30) })
      const spinner = await pane.find({ in: 'spinner', text: /running…/ })
      expect(spinner?.text).toContain('4')
      await pane.advance(80)
      expect((await pane.find({ in: 'spinner', text: /running…/ }))?.text).not.toBe(spinner?.text)

      await pane.key({ key: 'q', in: 'spinner' })
      expect(w.closed).toContain(PANE_ID)

      await w.clock.advance(5000)
      await call
    })
  }
})
