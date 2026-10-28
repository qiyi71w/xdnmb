import { Parser } from 'htmlparser2'
import type { NoteBlock, NoteInline } from '../../shared/updates'

/**
 * Release notes arrive as the HTML GitHub rendered for the release body (Atom feed). They are
 * untrusted: only headings, paragraphs, lists, code and `https:` links survive, as plain data the
 * renderer draws with ordinary elements. Scripts, styles, frames, images and every attribute but a
 * link's address are dropped; nothing is ever handed to the renderer as HTML.
 */

/** Input beyond this is not parsed (UTF-16 code units); GitHub release bodies are limited to 125 000 characters. */
const MAX_INPUT = 300_000
/** Text kept across all blocks; the full notes stay one click away on GitHub. */
const MAX_TEXT = 60_000
const MAX_BLOCKS = 600

/** Removed together with everything inside them. */
const DROPPED: Readonly<Record<string, true>> = Object.fromEntries(
  ['script', 'style', 'template', 'iframe', 'frame', 'object', 'embed', 'svg', 'math', 'noscript', 'head', 'title', 'img', 'video', 'audio', 'picture', 'source', 'input', 'button', 'select', 'textarea', 'form']
    .map((tag) => [tag, true])
)
const HEADINGS: Readonly<Record<string, 1 | 2 | 3>> = { h1: 1, h2: 2, h3: 3, h4: 3, h5: 3, h6: 3 }
/** Elements that end the current paragraph when they start or end. */
const BLOCKS: Readonly<Record<string, true>> = Object.fromEntries(
  ['p', 'div', 'section', 'article', 'blockquote', 'details', 'summary', 'table', 'thead', 'tbody', 'tr', 'hr', 'dl', 'dt', 'dd', 'figure', 'figcaption', 'markdown-accessiblity-table', 'body', 'html']
    .map((tag) => [tag, true])
)
const STRONG: Readonly<Record<string, true>> = { strong: true, b: true }
const EMPHASIS: Readonly<Record<string, true>> = { em: true, i: true }
const CODE: Readonly<Record<string, true>> = { code: true, kbd: true, samp: true }

interface Element {
  tag: string
  href: string | null
  children: (Element | string)[]
}

function parseTree(html: string): Element {
  const root: Element = { tag: 'root', href: null, children: [] }
  const stack = [root]
  const parser = new Parser({
    onopentag(tag, attrs) {
      const node: Element = { tag, href: tag === 'a' ? (attrs.href ?? null) : null, children: [] }
      stack.at(-1)!.children.push(node)
      stack.push(node)
    },
    ontext(text) { stack.at(-1)!.children.push(text) },
    onclosetag() { if (stack.length > 1) stack.pop() }
  }, { decodeEntities: true, lowerCaseTags: true })
  parser.write(html.slice(0, MAX_INPUT))
  parser.end()
  return root
}

/** Absolute `https:` address without credentials; relative ones resolve against `base`. */
function safeLink(href: string | null, base: string): string | null {
  if (href === null || href.length > 2048 || !URL.canParse(href, base)) return null
  const url = new URL(href, base)
  return url.protocol === 'https:' && url.username === '' && url.password === '' ? url.href : null
}

interface Marks { strong?: true; emphasis?: true; code?: true }

type ListItem = { depth: 0 | 1 | 2; content: NoteInline[] }

class Builder {
  readonly blocks: NoteBlock[] = []
  private text = 0
  private inline: NoteInline[] = []

  constructor(private readonly base: string) {}

  get full(): boolean {
    return this.text >= MAX_TEXT || this.blocks.length >= MAX_BLOCKS
  }

  /** Takes `length` characters from the budget; false once it is spent. */
  private spend(length: number): boolean {
    if (this.full) return false
    this.text += length
    return true
  }

  addText(raw: string, marks: Marks): void {
    const text = marks.code === true ? raw : raw.replace(/\s+/g, ' ')
    if (text === '' || !this.spend(text.length)) return
    const last = this.inline.at(-1)
    if (last?.kind === 'text' && last.strong === marks.strong && last.emphasis === marks.emphasis && last.code === marks.code) {
      last.text += text
      return
    }
    this.inline.push({ kind: 'text', text, ...marks })
  }

  addLink(text: string, href: string | null): void {
    const url = safeLink(href, this.base)
    const label = text.replace(/\s+/g, ' ').trim()
    if (url === null) {
      this.addText(label, {})
      return
    }
    if (!this.spend(label.length + url.length)) return
    this.inline.push({ kind: 'link', text: label === '' ? url : label, url })
  }

  addBreak(): void {
    if (this.inline.length > 0 && this.inline.at(-1)!.kind !== 'break') this.inline.push({ kind: 'break' })
  }

  /** The inline run collected so far, without surrounding spaces or breaks; null when nothing is left. */
  takeInline(): NoteInline[] | null {
    const run = this.inline
    this.inline = []
    while (run.at(-1)?.kind === 'break') run.pop()
    while (run[0]?.kind === 'break') run.shift()
    const first = run[0]
    if (first?.kind === 'text' && first.code === undefined) first.text = first.text.trimStart()
    const last = run.at(-1)
    if (last?.kind === 'text' && last.code === undefined) last.text = last.text.trimEnd()
    const kept = run.filter((item) => item.kind !== 'text' || item.text !== '')
    return kept.length === 0 ? null : kept
  }

  push(block: NoteBlock): void {
    if (this.blocks.length < MAX_BLOCKS) this.blocks.push(block)
  }

  flushParagraph(): void {
    const content = this.takeInline()
    if (content !== null) this.push({ kind: 'paragraph', content })
  }

  addCode(text: string): void {
    const trimmed = text.replace(/^\n+|\s+$/g, '')
    if (trimmed !== '' && this.spend(trimmed.length)) this.push({ kind: 'code', text: trimmed })
  }
}

function textOf(node: Element | string): string {
  if (typeof node === 'string') return node
  return Object.hasOwn(DROPPED, node.tag) ? '' : node.children.map(textOf).join('')
}

/** Adds the inline content of `node` to the builder's current run. */
function inline(node: Element | string, builder: Builder, marks: Marks): void {
  if (builder.full) return
  if (typeof node === 'string') {
    builder.addText(node, marks)
    return
  }
  if (Object.hasOwn(DROPPED, node.tag)) return
  if (node.tag === 'br') {
    builder.addBreak()
    return
  }
  if (node.tag === 'a') {
    builder.addLink(textOf(node), node.href)
    return
  }
  const next: Marks = { ...marks }
  if (Object.hasOwn(STRONG, node.tag)) next.strong = true
  if (Object.hasOwn(EMPHASIS, node.tag)) next.emphasis = true
  if (Object.hasOwn(CODE, node.tag)) next.code = true
  // Block children inside inline context (a paragraph in a list item) become line breaks.
  const block = Object.hasOwn(BLOCKS, node.tag)
  if (block) builder.addBreak()
  for (const child of node.children) inline(child, builder, next)
  if (block) builder.addBreak()
}

function listItems(list: Element, depth: number, builder: Builder, items: ListItem[]): void {
  for (const item of list.children) {
    if (builder.full) return
    if (typeof item === 'string' || item.tag !== 'li') continue
    const nested: Element[] = []
    for (const child of item.children) {
      if (typeof child !== 'string' && (child.tag === 'ul' || child.tag === 'ol')) nested.push(child)
      else inline(child, builder, {})
    }
    const content = builder.takeInline()
    if (content !== null) items.push({ depth: Math.min(depth, 2) as 0 | 1 | 2, content })
    for (const child of nested) listItems(child, depth + 1, builder, items)
  }
}

function blocks(node: Element, builder: Builder): void {
  for (const child of node.children) {
    if (builder.full) return
    if (typeof child === 'string') {
      inline(child, builder, {})
      continue
    }
    const { tag } = child
    if (Object.hasOwn(DROPPED, tag)) continue
    const heading = Object.hasOwn(HEADINGS, tag) ? HEADINGS[tag] : undefined
    if (heading !== undefined) {
      builder.flushParagraph()
      inline(child, builder, {})
      const content = builder.takeInline()
      if (content !== null) builder.push({ kind: 'heading', level: heading, content })
    } else if (tag === 'ul' || tag === 'ol') {
      builder.flushParagraph()
      const items: ListItem[] = []
      listItems(child, 0, builder, items)
      if (items.length > 0) builder.push({ kind: 'list', ordered: tag === 'ol', items })
    } else if (tag === 'pre') {
      builder.flushParagraph()
      builder.addCode(textOf(child))
    } else if (tag === 'td' || tag === 'th') {
      inline(child, builder, {})
      builder.addText(' ', {})
    } else if (Object.hasOwn(BLOCKS, tag)) {
      builder.flushParagraph()
      blocks(child, builder)
      builder.flushParagraph()
    } else inline(child, builder, {})
  }
}

/**
 * Structured notes from the release-body HTML; `base` resolves relative links (the release page).
 * A missing body (GitHub reports it as "No content.") gives `[]`, never placeholder text.
 */
export function releaseNotesFromHtml(html: string | null, base: string): NoteBlock[] {
  if (html === null || html.trim() === '' || html.trim() === 'No content.') return []
  const builder = new Builder(base)
  blocks(parseTree(html), builder)
  builder.flushParagraph()
  return builder.blocks
}

/** Release notes as the updater reports them: one body, or (full changelog) one entry per feed release by its own tag. */
export type ReportedNotes = string | ReadonlyArray<{ version: string; note: string | null }> | null | undefined

/**
 * The notes of exactly release `version`, or null when they are unknown: never another release's.
 * A single body comes from the metadata of the release's own tag; in a changelog only the entry of
 * `version` counts, so a release missing from the feed has unknown notes.
 */
export function releaseNotesFor(reported: ReportedNotes, version: string, base: string): NoteBlock[] | null {
  if (typeof reported === 'string') return releaseNotesFromHtml(reported, base)
  const entry = reported?.find((candidate) => candidate.version === version)
  return entry === undefined ? null : releaseNotesFromHtml(entry.note, base)
}
