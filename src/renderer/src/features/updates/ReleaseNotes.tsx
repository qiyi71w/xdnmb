// A release's own notes, already structured by the main process (no HTML): plain React elements,
// links as buttons that open the system browser. Long notes start collapsed to their beginning;
// hidden blocks are not rendered, so nothing out of sight takes keyboard focus.

import { useId, useState, type ReactNode } from 'react'
import type { NoteBlock, NoteInline } from '../../../../shared/updates'
import { EMPTY_NOTES_TEXT, UNKNOWN_NOTES_TEXT } from './updateText'
import '../../components/content.css'

/** Rough lines a collapsed note shows (a paragraph line is about this many characters). */
const COLLAPSED_LINES = 12
const LINE_CHARS = 60
/** Notes only this much longer than the collapsed part are shown whole. */
const COLLAPSE_SLACK = 4

function blockLines(block: NoteBlock): number {
  switch (block.kind) {
    case 'heading':
      return 1
    case 'paragraph': {
      const chars = block.content.reduce((sum, part) => sum + (part.kind === 'break' ? LINE_CHARS : part.text.length), 0)
      return Math.max(1, Math.ceil(chars / LINE_CHARS))
    }
    case 'list':
      return block.items.length
    case 'code':
      return block.text.split('\n').length
  }
}

/** The leading part of `notes` within `lines`; a list may be cut after some of its items. */
function leading(notes: readonly NoteBlock[], lines: number): NoteBlock[] {
  const shown: NoteBlock[] = []
  let left = lines
  for (const block of notes) {
    if (left <= 0) break
    const size = blockLines(block)
    if (size <= left) {
      shown.push(block)
      left -= size
    } else if (block.kind === 'list') {
      shown.push({ ...block, items: block.items.slice(0, left) })
      left = 0
    } else if (shown.length === 0) {
      shown.push(block)
      left = 0
    } else {
      break
    }
  }
  return shown
}

function Inline({ content }: { content: readonly NoteInline[] }) {
  return content.map((part, index) => {
    if (part.kind === 'break') return <br key={index} />
    if (part.kind === 'link') {
      return (
        <button
          key={index}
          type="button"
          className="content-link"
          title={`在系统浏览器中打开：${part.url}`}
          onClick={() => {
            window.xidao.links.openExternal({ url: part.url }).catch(() => undefined)
          }}
        >
          {part.text}
        </button>
      )
    }
    let node: ReactNode = part.text
    if (part.code === true) node = <code>{node}</code>
    if (part.emphasis === true) node = <em>{node}</em>
    if (part.strong === true) node = <strong>{node}</strong>
    return <span key={index}>{node}</span>
  })
}

interface ListNode {
  content: NoteInline[]
  children: ListNode[]
}

/** Flat items with depths → nested items; a deeper item without a parent at the level above nests under the previous one. */
function nest(items: Extract<NoteBlock, { kind: 'list' }>['items']): ListNode[] {
  const root: ListNode[] = []
  const stack: { depth: number; list: ListNode[] }[] = [{ depth: -1, list: root }]
  for (const item of items) {
    while (stack.length > 1 && stack.at(-1)!.depth >= item.depth) stack.pop()
    const node: ListNode = { content: item.content, children: [] }
    stack.at(-1)!.list.push(node)
    stack.push({ depth: item.depth, list: node.children })
  }
  return root
}

function List({ ordered, nodes }: { ordered: boolean; nodes: readonly ListNode[] }) {
  const items = nodes.map((node, index) => (
    <li key={index}>
      <Inline content={node.content} />
      {node.children.length > 0 && <List ordered={ordered} nodes={node.children} />}
    </li>
  ))
  return ordered ? <ol>{items}</ol> : <ul>{items}</ul>
}

function Block({ block }: { block: NoteBlock }) {
  switch (block.kind) {
    case 'heading': {
      // Under the release title (h5): every notes heading is an h6, sized by its own level.
      return (
        <h6 className={`release-notes-heading is-level-${block.level}`}>
          <Inline content={block.content} />
        </h6>
      )
    }
    case 'paragraph':
      return (
        <p>
          <Inline content={block.content} />
        </p>
      )
    case 'list':
      return <List ordered={block.ordered} nodes={nest(block.items)} />
    case 'code':
      return (
        <pre className="release-notes-code">
          <code>{block.text}</code>
        </pre>
      )
  }
}

export function ReleaseNotes({ notes }: { notes: readonly NoteBlock[] | null }) {
  const notesId = useId()
  const [expanded, setExpanded] = useState(false)

  if (notes === null) return <p className="release-notes-empty">{UNKNOWN_NOTES_TEXT}</p>
  if (notes.length === 0) return <p className="release-notes-empty">{EMPTY_NOTES_TEXT}</p>

  const total = notes.reduce((sum, block) => sum + blockLines(block), 0)
  const collapsible = total > COLLAPSED_LINES + COLLAPSE_SLACK
  const shown = collapsible && !expanded ? leading(notes, COLLAPSED_LINES) : notes

  return (
    <>
      <div className={collapsible && !expanded ? 'release-notes is-collapsed' : 'release-notes'} id={notesId}>
        {shown.map((block, index) => (
          <Block key={index} block={block} />
        ))}
      </div>
      {collapsible && (
        <button
          type="button"
          className="btn btn-small btn-quiet release-notes-toggle"
          aria-expanded={expanded}
          aria-controls={notesId}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? '收起说明' : '展开全部说明'}
        </button>
      )}
    </>
  )
}
