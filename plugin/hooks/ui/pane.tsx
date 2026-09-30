// The fullscreen dashboard (pi-autoresearch@939ede8 index.ts:2609-2737) as a pane. The
// overlay's layout is kept: the title row, a window over every row of
// renderDashboardLines plus the spinner row while a run is going, and a footer. The
// engine draws the frame (F5). The window is this mod's own, as diff's is: the tree is
// the visible rows, and `ui.scroll` (the arrows, page keys, Home/End) moves it. Rows past
// the footer that never show make the tree as tall as the content, so the engine hands
// every scroll key over and Home/End read as the whole content. The footer's plain
// Buttons are the vim keys (hotkeys work once the pane holds the keyboard); `G` folds to
// `g` there, so the bottom is End (F5).

import type { ButtonProps, ClientProps, ElementConstructor, RenderElement } from 'claude-code'

import {
  overlayTitleLine,
  overlaySpinnerLine,
  renderDashboardLines,
} from '../upstream/dashboard-lines.ts'
import { clamp, type ExperimentState } from '../upstream/experiment-core.ts'
import { lineTree, type TextElements } from './draw.tsx'
import { markerTheme, styledLines } from './styled.ts'

export const PANE_ID = 'autoresearch-dashboard'

export type PaneElements = TextElements & {
  Button: ElementConstructor<ButtonProps>
  Client?: ElementConstructor<ClientProps>
}

export interface PaneInput {
  state: ExperimentState
  running: { startedAt: number } | null
  width: number
  bodyRows: number
  offset: number
  now: number
}

export interface PaneLayout {
  title: string
  rows: string[]
  /** The spinner row's index in `rows` coordinates, or -1. */
  spinnerRow: number
  spinner: { nextIdx: number; startedAt: number } | null
  totalRows: number
  viewportRows: number
  maxScroll: number
  offset: number
  width: number
}

export function paneLayout(input: PaneInput): PaneLayout {
  const width = Math.max(4, input.width)
  const rows = renderDashboardLines(input.state, width, markerTheme, 0)
  const spinner = input.running ? { nextIdx: input.state.results.length + 1, startedAt: input.running.startedAt } : null
  const spinnerRow = spinner ? rows.length : -1
  if (spinner) rows.push(overlaySpinnerLine(spinner.nextIdx, 0, input.now - spinner.startedAt, width, markerTheme))
  const totalRows = rows.length
  const viewportRows = Math.max(1, input.bodyRows - 2)
  const maxScroll = Math.max(0, totalRows - viewportRows)
  return {
    title: overlayTitleLine(input.state, width, markerTheme),
    rows,
    spinnerRow,
    spinner,
    totalRows,
    viewportRows,
    maxScroll,
    offset: clamp(input.offset, 0, maxScroll),
    width,
  }
}

/** The offset after a `ui.scroll` of `by` rows over a tree of `contentRows` in `bodyRows`. */
export function scrolledOffset(
  layout: Pick<PaneLayout, 'offset' | 'maxScroll' | 'viewportRows'>,
  scroll: { by: number; bodyRows: number; contentRows: number },
): number {
  const size = Math.abs(scroll.by)
  const direction = Math.sign(scroll.by)
  const isEnd = size >= scroll.contentRows && scroll.contentRows > scroll.bodyRows
  if (isEnd) return direction < 0 ? 0 : layout.maxScroll
  const step = size >= scroll.bodyRows ? layout.viewportRows : size
  return clamp(layout.offset + direction * step, 0, layout.maxScroll)
}

export interface PaneActions {
  scrollBy: (rows: number) => void
  scrollPage: (pages: number) => void
  top: () => void
  bottom: () => void
  close: () => void
}

export function paneTree(els: PaneElements, layout: PaneLayout, actions: PaneActions): RenderElement {
  const { Box, Text, Button, Client } = els
  const out: RenderElement[] = [lineTree(els, styledLines(layout.title)[0] ?? [], 'truncate-end', 'title')]

  const visible = layout.rows.slice(layout.offset, layout.offset + layout.viewportRows)
  visible.forEach((row, index) => {
    const at = layout.offset + index
    if (at === layout.spinnerRow && layout.spinner && Client) {
      out.push(
        <Client
          key="spinner"
          module="./dashboard-client.tsx"
          props={{ nextIdx: layout.spinner.nextIdx, startedAt: layout.spinner.startedAt, width: layout.width }}
          height={1}
        />,
      )
      return
    }
    out.push(lineTree(els, styledLines(row)[0] ?? [], 'truncate-end', `r${at}`))
  })
  for (let i = visible.length; i < layout.viewportRows; i++) {
    out.push(lineTree(els, [], 'truncate-end', `pad${i}`))
  }

  const scrollInfo = layout.totalRows > layout.viewportRows
    ? `${layout.offset + 1}-${Math.min(layout.offset + layout.viewportRows, layout.totalRows)}/${layout.totalRows}`
    : ''
  out.push(
    <Box key="footer" flexDirection="row" gap={1}>
      <Button key="down" plain hotkey="j" label="↓" onPress={() => actions.scrollBy(1)} />
      <Button key="up" plain hotkey="k" label="↑" onPress={() => actions.scrollBy(-1)} />
      <Button key="pagedown" plain hotkey="d" label="pgdn" onPress={() => actions.scrollPage(1)} />
      <Button key="pageup" plain hotkey="u" label="pgup" onPress={() => actions.scrollPage(-1)} />
      <Button key="top" plain hotkey="g" label="top" onPress={() => actions.top()} />
      <Button key="close" plain hotkey="q" label="close" onPress={() => actions.close()} />
      <Text color="subtle" wrap="truncate-end">{`end bottom • esc close${scrollInfo ? ` ${scrollInfo}` : ''}`}</Text>
    </Box>,
  )
  for (let i = 0; i < layout.maxScroll; i++) {
    out.push(lineTree(els, [], 'truncate-end', `below${i}`))
  }

  return <Box flexDirection="column" width={layout.width}>{out}</Box>
}
