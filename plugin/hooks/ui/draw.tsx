// Draws marked text (ui/styled.ts) with a surface's own elements: one Text per line,
// a nested Text per styled span.

import type { BoxProps, ElementConstructor, RenderElement, TextProps } from 'claude-code'

import { styledLines, type Span } from './styled.ts'

export type TextElements = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
}

type Wrap = NonNullable<TextProps['wrap']>

function spanProps(span: Span): TextProps {
  const props: TextProps = {}
  if (span.color) props.color = span.color
  if (span.bold) props.bold = true
  return props
}

/** One line of spans as one Text (a blank line keeps its row). */
export function lineTree(els: TextElements, spans: Span[], wrap: Wrap, key: string): RenderElement {
  const { Text } = els
  if (spans.length === 0) {
    return <Text key={key} wrap={wrap}>{' '}</Text>
  }
  return (
    <Text key={key} wrap={wrap}>
      {spans.map((span, index) => (
        <Text key={String(index)} {...spanProps(span)}>{span.text}</Text>
      ))}
    </Text>
  )
}

/** Lines already cut to width (the dashboard's): each drawn as one row, never wrapped. */
export function linesTree(els: TextElements, lines: readonly string[], width?: number): RenderElement {
  const { Box } = els
  const rows = lines.map((line, index) => lineTree(els, styledLines(line)[0] ?? [], 'truncate-end', `l${index}`))
  return width === undefined
    ? <Box flexDirection="column">{rows}</Box>
    : <Box flexDirection="column" width={width}>{rows}</Box>
}

/** Free text (a tool row's), wrapped to the row as pi's Text wraps it. */
export function textTree(els: TextElements, text: string): RenderElement {
  const { Box } = els
  return (
    <Box flexDirection="column">
      {styledLines(text).map((spans, index) => lineTree(els, spans, 'wrap', `l${index}`))}
    </Box>
  )
}

/** A tool result's stored output as the text the model read. */
export function outputText(output: unknown): string {
  if (typeof output === 'string') return output
  const blocks = Array.isArray(output)
    ? output
    : output && typeof output === 'object' && Array.isArray((output as { content?: unknown }).content)
      ? (output as { content: unknown[] }).content
      : null
  if (blocks) {
    return blocks
      .map(block => (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : ''))
      .join('')
  }
  return output === undefined || output === null ? '' : JSON.stringify(output)
}
