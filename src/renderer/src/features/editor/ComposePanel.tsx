// The floating 发言编辑 panel. Entries are the 发新串 button beside a board's name and the 回复
// button in the thread toolbar; the panel is a centred modal over a dimmed reader. Editors keep the
// store's semantics: closing only collapses, content stays.

import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { targetKey, type EditorId, type PostTarget } from '../../../../shared/drafts'
import { Icon } from '../../components/Icon'
import { useCover } from '../../lib/appCovered'
import { openLayer, type Layer } from '../../lib/layers'
import { rememberComposeOpener, returnComposeFocus } from '../directory/navStore'
import { EditorPanel, useComposeOpen } from './EditorPanel'
import { targetText } from './editorText'
import { editorFor, type Editor } from './editorsState'
import { focusKey } from './useEditorsStore'
import { useEditorWorkspace } from './workspace'

export interface ComposeTarget {
  target: PostTarget
  /** Its tab is active and the pane it belongs to (list or reader) is shown. */
  displayed: boolean
}

/** A target's entry button and its confirmed-send note, for the pane that places them. */
export interface ComposeEntry {
  tabId: number
  entry: ReactNode
  note: ReactNode
}

/** Tab content plus the panels of the targets it shows. */
export function ComposeFrame({ tabId, targets, children }: { tabId: number; targets: readonly ComposeTarget[]; children: ReactNode }) {
  useOnePanelPerTab(targets)
  return (
    <div className="compose-frame">
      <div className="compose-frame-main">{children}</div>
      {targets.map(({ target, displayed }) => (
        <ComposePanel key={targetKey(target)} tabId={tabId} target={target} displayed={displayed} />
      ))}
      {!targets.some(({ target }) => target.kind === 'thread' && target.forumId === '18') && (
        <ComposePanel tabId={tabId} target={{ kind: 'thread', forumId: '18' }} displayed={targets.some(({ displayed }) => displayed)} />
      )}
    </div>
  )
}

/**
 * At most one expanded editor per tab: whichever editor expands (an entry, 继续 from 草稿, 更改目标)
 * collapses the others of its tab. Collapsing keeps their content.
 */
function useOnePanelPerTab(targets: readonly ComposeTarget[]): void {
  const { store } = useEditorWorkspace()
  const { state, dispatch } = store
  const previous = useRef<ReadonlySet<EditorId>>(new Set())
  useLayoutEffect(() => {
    const visible = targets.filter(({ displayed }) => displayed).map(({ target }) => targetKey(target))
    if (visible.length > 0) visible.push(targetKey({ kind: 'thread', forumId: '18' }))
    const expanded = state.editors.filter((editor) => visible.includes(targetKey(editor.target)) && editor.expanded)
    const before = previous.current
    previous.current = new Set(expanded.map((editor) => editor.id))
    if (expanded.length < 2) return
    const keep = expanded.filter((editor) => !before.has(editor.id)).at(-1)
    if (keep === undefined) return
    for (const editor of expanded) if (editor.id !== keep.id) dispatch({ type: 'set-expanded', editorId: editor.id, expanded: false })
  }, [state, targets, dispatch])
}

function ComposePanel({ tabId, target, displayed }: { tabId: number; target: PostTarget; displayed: boolean }) {
  const workspace = useEditorWorkspace()
  const { store } = workspace
  const editor = editorFor(store.state, target)
  useLayoutEffect(() => {
    if (editor !== null) store.dispatch({ type: 'attach-tab', editorId: editor.id, tabId })
  }, [editor?.id, tabId, store.dispatch])
  const key = focusKey(tabId, target)
  /** Set when the panel goes away by the user's action or with focus inside. */
  const focusBar = useRef(false)
  const expanded = editor?.expanded === true

  // Closed (收起, Esc, sent and confirmed, discarded): focus goes back to the opener. A panel that
  // only stopped being displayed leaves focus alone.
  useLayoutEffect(() => {
    if (!focusBar.current) return
    focusBar.current = false
    if (!expanded && displayed) returnComposeFocus(key)
  })

  if (editor === null || !editor.expanded || !displayed) return null

  const collapse = () => {
    focusBar.current = true
    store.dispatch({ type: 'set-expanded', editorId: editor.id, expanded: false })
  }
  const label = targetText(target, workspace.forumName)
  const panel = <EditorPanel key={editor.id} tabId={tabId} editor={editor} label={label} displayed={displayed} focusBar={focusBar} />
  return (
    <ComposeModal label={editor.report !== undefined ? `举报 >>No.${editor.report.postId}` : `发言编辑：${label}`} onCollapse={collapse}>
      {panel}
    </ComposeModal>
  )
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'

/**
 * Centred over a dimmed app. Focus stays inside; Esc or a press on the backdrop collapses it.
 * Nothing behind it is judged read while it is shown.
 */
function ComposeModal({ label, onCollapse, children }: { label: string; onCollapse: () => void; children: ReactNode }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const layerRef = useRef<Layer | null>(null)
  const pressedBackdrop = useRef(false)
  useCover(true, 'app')

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return
    const layer = openLayer()
    layerRef.current = layer
    if (!dialog.open) dialog.showModal()
    // The text is what the panel is for; an opening focus request lands there too.
    if (!dialog.contains(document.activeElement) || document.activeElement === dialog) {
      dialog.querySelector<HTMLTextAreaElement>('.editor-content')?.focus()
    }
    // Removing the open dialog takes it out of the top layer; the panel decides where focus goes.
    return () => {
      layer.release()
      layerRef.current = null
    }
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== 'Tab' || dialogRef.current === null) return
    const items = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.getClientRects().length > 0)
    const first = items[0]
    const last = items.at(-1)
    if (first === undefined || last === undefined) return
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="compose-modal"
      aria-label={label}
      aria-modal="true"
      data-keeps-arrows=""
      onKeyDown={onKeyDown}
      onCancel={(event) => {
        event.preventDefault()
        if (layerRef.current?.isTop() !== false) onCollapse()
      }}
      onPointerDown={(event) => {
        pressedBackdrop.current = event.target === event.currentTarget
      }}
      onClick={(event) => {
        if (pressedBackdrop.current && event.target === event.currentTarget) onCollapse()
        pressedBackdrop.current = false
      }}
    >
      {children}
    </dialog>
  )
}

/** Holds something worth continuing: text, an image, a saved draft, or a send. */
function hasContent(editor: Editor): boolean {
  const { content, title, name, email } = editor.fields
  return (
    content !== '' ||
    title !== '' ||
    name !== '' ||
    email !== '' ||
    editor.attachment !== null ||
    editor.draft !== null ||
    editor.publication !== null
  )
}

/** 回复 / 发新串 of one target in one tab; 继续编辑 while a collapsed editor holds content. */
export function ComposeButton({ tabId, target, className = 'btn' }: { tabId: number; target: PostTarget; className?: string }) {
  const { store } = useEditorWorkspace()
  const editor = editorFor(store.state, target)
  const { opening, expand } = useComposeOpen(tabId, target, editor)
  const key = focusKey(tabId, target)
  const resume = editor !== null && hasContent(editor)
  const text = resume ? '继续编辑' : target.kind === 'reply' ? '回复' : '发新串'
  return (
    <button
      type="button"
      className={className}
      title={text}
      data-compose-key={key}
      aria-haspopup="dialog"
      aria-expanded={editor?.expanded === true}
      aria-busy={opening || undefined}
      onClick={(event) => {
        rememberComposeOpener(key, event.currentTarget)
        void expand()
      }}
    >
      <Icon name={resume ? 'draft' : target.kind === 'reply' ? 'reply' : 'plus'} />
      <span className="btn-label">{text}</span>
    </button>
  )
}

/** The last send from this tab to this target was confirmed: said until a new editor opens there. */
export function ComposeSentNote({ tabId, target }: { tabId: number; target: PostTarget }) {
  const { store } = useEditorWorkspace()
  const editor = editorFor(store.state, target)
  const sent = editor === null ? store.published.get(focusKey(tabId, target)) : undefined
  if (sent === undefined) return null
  return (
    <span className="compose-sent">
      <Icon name="check" size={13} />
      {sent.isThread ? `新串已发出：No.${sent.postId}` : `已发送 No.${sent.postId}`}
    </span>
  )
}
