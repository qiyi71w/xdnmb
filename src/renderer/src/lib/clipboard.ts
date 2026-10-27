import type { ClipboardEditCommand } from '../../../shared/api'

/** Puts app-given plain text on the system clipboard. The main process writes it; nothing is read back. */
export function copyText(text: string): Promise<void> {
  return window.xidao.clipboard.run({ command: 'writeText', text })
}

/** Runs an edit command on this window as its Edit menu would: on the focused field or selection. */
export function runEditCommand(command: ClipboardEditCommand): Promise<void> {
  return window.xidao.clipboard.run({ command })
}
