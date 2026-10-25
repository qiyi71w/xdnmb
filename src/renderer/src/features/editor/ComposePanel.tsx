// PROTOTYPE (throwaway): the floating 发言编辑 panel of the reading main line. Replaces the bottom
// docks only in builds with VITE_XIDAO_PROTOTYPE=1. Entries are the 发新串 button beside a board's
// name and the 回复 button in the thread toolbar; the panel is either a centred modal over a dimmed
// reader or a drawer beside the tab content (prototype switcher, `editorVariant`). Editors keep the
// store's semantics: closing only collapses, content stays.

import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { targetKey, type EditorId, type PostTarget } from '../../../../shared/drafts'
import { Icon } from '../../components/Icon'
import { useCover } from '../../lib/appCovered'
import { openLayer, type Layer } from '../../lib/layers'
import {
  rememberComposeOpener,
  returnComposeFocus,
  setComposeDrawerWidth,
  useEditorVariant,
  type EditorVariant
} from '../directory/prototype/prototypeStore'
import { EditorPanel, useComposeOpen } from './EditorDock'
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
  entry: ReactNode
  note: ReactNode
}

/**
 * Tab content plus the panels of the targets it shows. An open drawer sits beside the content,
 * which gives up the drawer's width (App takes it out of the layout width as well), so the thread
 * stays readable and scrollable beside it.
 */
export function ComposeFrame({ tabId, targets, children }: { tabId: number; targets: readonly ComposeTarget[]; children: ReactNode }) {
  const variant = useEditorVariant()
  useOnePanelPerTab(tabId)
  return (
    <div className="compose-frame">
      <div className="compose-frame-main">{children}</div>
      {targets.map(({ target, displayed }) => (
        <ComposePanel key={targetKey(target)} tabId={tabId} target={target} displayed={displayed} variant={variant} />
      ))}
    </div>
  )
}

/**
 * At most one expanded editor per tab: whichever editor expands (an entry, 继续 from 草稿, 更改目标)
 * collapses the others of its tab. Collapsing keeps their content.
 */
function useOnePanelPerTab(tabId: number): void {
  const { store } = useEditorWorkspace()
  const { state, dispatch } = store
  const previous = useRef<ReadonlySet<EditorId>>(new Set())
  useLayoutEffect(() => {
    const expanded = state.editors.filter((editor) => editor.tabId === tabId && editor.expanded)
    const before = previous.current
    previous.current = new Set(expanded.map((editor) => editor.id))
    if (expanded.length < 2) return
    const keep = expanded.filter((editor) => !before.has(editor.id)).at(-1)
    if (keep === undefined) return
    for (const editor of expanded) if (editor.id !== keep.id) dispatch({ type: 'set-expanded', editorId: editor.id, expanded: false })
  }, [state, tabId, dispatch])
}

function ComposePanel({
  tabId,
  target,
  displayed,
  variant
}: {
  tabId: number
  target: PostTarget
  displayed: boolean
  variant: EditorVariant
}) {
  const workspace = useEditorWorkspace()
  const { store } = workspace
  const editor = editorFor(store.state, tabId, target)
  const key = focusKey(tabId, target)
  /** Set when the panel goes away by the user's action or with focus inside. */
  const focusBar = useRef(false)
  const expanded = editor?.expanded === true

  // Closed (收起, Esc, sent and confirmed, discarded): focus goes back to the opener. A panel that
  // only changed variant or stopped being displayed leaves focus alone.
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
  const panel = <EditorPanel key={editor.id} editor={editor} label={label} displayed={displayed} focusBar={focusBar} layout="float" />
  return variant === 'modal' ? (
    <ComposeModal label={`发言编辑：${label}`} onCollapse={collapse}>
      {panel}
    </ComposeModal>
  ) : (
    <ComposeDrawer label={`发言编辑：${label}`} onCollapse={collapse}>
      {panel}
    </ComposeDrawer>
  )
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'

/**
 * A: centred over a dimmed app. Focus stays inside; Esc or a press on the backdrop collapses it.
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

/**
 * B: beside the tab content, no backdrop. Esc collapses it while focus is inside. Reports the
 * width it takes from the content for the layout (0 while it floats over a narrow window).
 */
function ComposeDrawer({ label, onCollapse, children }: { label: string; onCollapse: () => void; children: ReactNode }) {
  const drawerRef = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const drawer = drawerRef.current
    if (drawer === null) return
    const measure = () =>
      setComposeDrawerWidth(getComputedStyle(drawer).position === 'absolute' ? 0 : drawer.getBoundingClientRect().width)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(drawer)
    return () => {
      observer.disconnect()
      setComposeDrawerWidth(null)
    }
  }, [])
  return (
    <section
      ref={drawerRef}
      className="compose-drawer"
      aria-label={label}
      data-keeps-arrows=""
      onKeyDown={(event) => {
        // A layer above (a quote card, a menu) takes Esc first and marks it handled.
        if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return
        event.preventDefault()
        event.stopPropagation()
        onCollapse()
      }}
    >
      {children}
    </section>
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
  const editor = editorFor(store.state, tabId, target)
  const { opening, expand } = useComposeOpen(tabId, target, editor)
  const key = focusKey(tabId, target)
  const resume = editor !== null && hasContent(editor)
  return (
    <button
      type="button"
      className={className}
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
      {resume ? '继续编辑' : target.kind === 'reply' ? '回复' : '发新串'}
    </button>
  )
}

/** The last send from this tab to this target was confirmed: said until a new editor opens there. */
export function ComposeSentNote({ tabId, target }: { tabId: number; target: PostTarget }) {
  const { store } = useEditorWorkspace()
  const editor = editorFor(store.state, tabId, target)
  const sent = editor === null ? store.published.get(focusKey(tabId, target)) : undefined
  if (sent === undefined) return null
  return (
    <span className="compose-sent">
      <Icon name="check" size={13} />
      {sent.isThread ? `新串已发出：No.${sent.postId}` : `已发送 No.${sent.postId}`}，已记为自己的发言
    </span>
  )
}
