import { flushSync } from 'react-dom'

/**
 * The open modal dialogs (`Modal` and the compose dialog), in opening order. The bottom notices
 * live in the topmost one (outside it everything is inert) unless it keeps them below, and a
 * notice action that takes the user elsewhere first closes them through their own close path.
 */
interface OpenDialog {
  element: HTMLDialogElement
  /** The dialog's own close path (Esc, 取消): it may refuse, e.g. while an action runs. */
  close: () => void
  /** While it is the topmost, the notices stay under it, inert like the rest of the window. */
  noticesBelow: boolean
}

const open: OpenDialog[] = []
const listeners = new Set<() => void>()

function changed(): void {
  for (const listener of listeners) listener()
}

/** Registers a dialog just shown with `showModal()`; returns the unregister, to run before it closes. */
export function registerDialog(element: HTMLDialogElement, close: () => void, noticesBelow = false): () => void {
  const entry: OpenDialog = { element, close, noticesBelow }
  open.push(entry)
  changed()
  return () => {
    const at = open.indexOf(entry)
    if (at < 0) return
    open.splice(at, 1)
    changed()
  }
}

/** The topmost open dialog, or null. */
export function topDialog(): HTMLDialogElement | null {
  return open.at(-1)?.element ?? null
}

/**
 * Where the bottom notices go: the topmost open dialog, or null for their own place in the page
 * (no dialog open, or the topmost keeps them below it).
 */
export function noticeHost(): HTMLDialogElement | null {
  const top = open.at(-1)
  return top === undefined || top.noticesBelow ? null : top.element
}

/** Calls `listener` synchronously whenever a dialog opens or closes; returns the unsubscribe. */
export function onDialogsChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Closes every open dialog, topmost first, each through its own close path. Stops at the first
 * one that stays open (it refused, e.g. while busy) and returns false; true when none is left.
 * Call it from an event handler: each close is committed before the next is asked.
 */
export function closeDialogs(): boolean {
  for (let entry = open.at(-1); entry !== undefined; entry = open.at(-1)) {
    flushSync(entry.close)
    if (open.at(-1) === entry) return false
  }
  return true
}
