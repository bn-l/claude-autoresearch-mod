// The dashboard's spinner row while a run is going (pi-autoresearch@939ede8
// index.ts:2616-2635): `  <next #>⠋ running… 1m 05s`, advanced every 80 ms on the
// surface's own clock, so nothing round-trips through the hooks. Once a click gives it
// the keyboard it also takes the overlay's keys (j/k, u/d, g/G, q) and posts them to the
// hooks module, which moves the window.

import type { ClientModule } from 'claude-code'

type Props = { nextIdx: number; startedAt: number; width: number }
type State = { frame: number }

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// ported from pi-autoresearch@939ede8 index.ts:347-354 (a surface module imports nothing)
function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${s}s`
}

const KEY_POSTS: Record<string, { scroll?: number; page?: number; top?: true; bottom?: true; close?: true }> = {
  j: { scroll: 1 },
  down: { scroll: 1 },
  k: { scroll: -1 },
  up: { scroll: -1 },
  d: { page: 1 },
  pagedown: { page: 1 },
  u: { page: -1 },
  pageup: { page: -1 },
  g: { top: true },
  home: { top: true },
  G: { bottom: true },
  end: { bottom: true },
  q: { close: true },
}

const DashboardSpinner: ClientModule<Props, State> = (props, surface) => {
  const { Text } = surface.elements

  if (surface.state === undefined) {
    surface.setState({ frame: 0 })
    surface.every(80, () => surface.setState({ frame: (surface.state?.frame ?? 0) + 1 }))
    surface.onKey(key => {
      const name = key.key === 'g' && key.shift ? 'G' : key.key
      const post = KEY_POSTS[name]
      if (post) surface.post(post)
    })
  }

  const frame = SPINNER[(surface.state?.frame ?? 0) % SPINNER.length]
  const elapsed = formatElapsed(Date.now() - props.startedAt)

  return (
    <Text wrap="truncate-end">
      <Text color="subtle">{`  ${String(props.nextIdx).padEnd(3)}`}</Text>
      <Text color="warning">{`${frame} running… ${elapsed}`}</Text>
    </Text>
  )
}

export default DashboardSpinner
