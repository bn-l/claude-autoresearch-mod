// Engine-contract points of the wiring that the end-to-end suites reach awkwardly
// (PLAN §7.4): the kickoff submitted after the command, not inside it; `precompute`
// skipped while the mode is on; our tools refused while it is off.

import { describe, expect, test, tier } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'

import { logWithBaseline, tool, world } from './support/world.ts'

tier('user')

const SKILL = '---\nname: autoresearch-create\n---\nSET UP THE SESSION'
const SESSION = { surface: 'terminal', isInteractive: true, cwd: '/work' } as const
const TYPED = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }
const MESSAGES: SessionMessage[] = [{ role: 'user', text: 'hello', toolUses: [] }]
const COMPOSE = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as const

describe('mode gating', () => {
  test('our tools are refused while the mode is off, and never registered', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)

    const answer = await $.tool.call({ tool: tool('run_experiment'), command: 'echo hi' })
    expect(answer.deny).toStartWith('autoresearch mode is off')
    expect(w.registered).toEqual([])
    expect(w.logs).toEqual([])
  })

  test('a session over an existing log turns the mode on and registers the three tools', async ($, on) => {
    const w = world(on, { files: { '/work/.auto/log.jsonl': logWithBaseline() } })
    await $.session.start(SESSION)

    expect(w.registered).toEqual(['init_experiment', 'run_experiment', 'log_experiment'])
    expect(w.logs).toEqual([])
  })
})

describe('/autoresearch', () => {
  test('the kickoff is submitted after the command returns, with the create skill expanded', async ($, on) => {
    const w = world(on, { files: { '*/skills/autoresearch-create/SKILL.md': SKILL } })
    await $.session.start(SESSION)

    await $.command.run({ command: 'autoresearch', args: 'speed up the sort', ...TYPED })
    expect(w.submitted).toEqual([])
    expect(w.toasts).toContain('Autoresearch mode ON — no .auto/prompt.md found, loading autoresearch-create skill')
    expect(w.registered).toEqual(['init_experiment', 'run_experiment', 'log_experiment'])

    await w.clock.settle()
    expect(w.submitted).toHaveLength(1)
    expect(w.submitted[0]).toStartWith('<skill name="autoresearch-create" location="')
    expect(w.submitted[0]).toContain('SET UP THE SESSION')
    expect(w.submitted[0]).toContain('</skill>\n\nspeed up the sort')
    expect(w.logs).toEqual([])
  })

  test('with prompt.md present the kickoff resumes from the rules', async ($, on) => {
    const w = world(on, { files: { '/work/.auto/prompt.md': '# Goal' } })
    await $.session.start(SESSION)

    await $.command.run({ command: 'autoresearch', args: 'go', ...TYPED })
    await w.clock.settle()
    expect(w.toasts).toContain('Autoresearch mode ON — rules loaded from .auto/prompt.md')
    expect(w.submitted).toHaveLength(1)
    expect(w.submitted[0]).not.toContain('<skill')
  })

  test("the kickoff reaches the model as the person's own words, as upstream sends it (F4)", async ($, on) => {
    const w = world(on, { files: { '/work/.auto/prompt.md': '# Goal' } })
    await $.session.start(SESSION)

    await $.command.run({ command: 'autoresearch', args: 'go', ...TYPED })
    await w.clock.settle()
    expect(w.submittedAsUser).toEqual([true])
  })

  test('off turns the tools away again', async ($, on) => {
    const w = world(on, { files: { '/work/.auto/log.jsonl': logWithBaseline() } })
    await $.session.start(SESSION)

    await $.command.run({ command: 'autoresearch', args: 'off', ...TYPED })
    const answer = await $.tool.call({ tool: tool('log_experiment'), commit: 'abc', metric: 1, status: 'keep', description: 'x' })
    expect(answer.deny).toStartWith('autoresearch mode is off')
    expect(w.toasts).toContain('Autoresearch mode OFF')
  })

  test('a burst of notices is merged into one toast, not dropped', async ($, on) => {
    const w = world(on, { files: { '/work/.auto/log.jsonl': logWithBaseline() } })
    await $.session.start(SESSION)
    const before = w.toasts.length

    await $.command.run({ command: 'autoresearch', args: 'go', ...TYPED })
    await $.command.run({ command: 'autoresearch', args: 'off', ...TYPED })
    await $.command.run({ command: 'autoresearch', args: 'dashboard', ...TYPED })
    const burst = w.toasts.slice(before)
    expect(burst.length).toBeLessThanOrEqual(1)

    await w.clock.advance(2100)
    const shown = w.toasts.slice(before).join(' · ')
    expect(w.toasts.length - before).toBe(burst.length + 1)
    expect(shown).toBe(
      "Autoresearch already active — use '/autoresearch off' to stop first · Autoresearch mode OFF · Autoresearch mode is not active",
    )
  })
})

describe('the system prompt (F13)', () => {
  test("the rules are the mod's own section, last, while the mode is on", async ($, on) => {
    world(on, { files: { '/work/.auto/log.jsonl': logWithBaseline() } })
    await $.session.start(SESSION)

    const { sections } = await $.prompt.compose(COMPOSE)
    expect(sections.map(section => section.id)).toEqual(['intro', 'autoresearch:rules'])
    expect(sections[1]?.scope).toBe('session')
    expect(sections[1]?.text).toStartWith('## Autoresearch Mode (ACTIVE)')
    expect(sections[1]?.text).toContain('mcp__autoresearch__run_experiment')

    await $.command.run({ command: 'autoresearch', args: 'off', ...TYPED })
    expect((await $.prompt.compose(COMPOSE)).sections.map(section => section.id)).toEqual(['intro'])
  })
})

describe('compaction', () => {
  test('precompute is skipped while the mode is on', async ($, on) => {
    const w = world(on, { files: { '/work/.auto/log.jsonl': logWithBaseline() } })
    await $.session.start(SESSION)

    const answer = await $.session.compact({ trigger: 'precompute', messages: [...MESSAGES] })
    expect(answer.skip).toBe('autoresearch builds its own summary')
    expect(w.engineCompactions).toEqual([])
  })

  test('while the mode is off every compaction is left to Claude Code', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)

    await $.session.compact({ trigger: 'precompute', messages: [...MESSAGES] })
    await $.session.compact({ trigger: 'manual', messages: [...MESSAGES] })
    expect(w.engineCompactions).toEqual(['precompute', 'manual'])
  })

  test('a manual compaction while on is answered with the summary from the files', async ($, on) => {
    const w = world(on, {
      files: { '/work/.auto/log.jsonl': logWithBaseline(), '/work/.auto/prompt.md': '# Make sort fast' },
    })
    await $.session.start(SESSION)

    const answer = await $.session.compact({ trigger: 'manual', messages: [...MESSAGES] })
    expect(w.engineCompactions).toEqual([])
    const summary = answer.messages?.[0]
    expect(summary?.role).toBe('user')
    expect(summary?.text).toContain('# Make sort fast')
    expect(summary?.text).toContain('baseline')
  })
})
