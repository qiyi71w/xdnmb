import type { EditorId } from '../../../../shared/drafts'
import type { Editor } from '../editor/editorsState'

/*
 * What a quit does with sends before it saves anything: open PO questions are cancelled, sends that
 * settle by themselves are waited for, and an uncertain request is looked up once more. A send whose
 * state still cannot be checked stops the quit (有发送的状态无法确认). Pure over the given editors.
 */

/** A send that settles by itself: its request, a PO answer, or a lookup of an uncertain request is running. */
export function settling(editor: Editor): boolean {
  const publication = editor.publication
  if (publication === null) return false
  return (
    publication.phase === 'submitting' ||
    (publication.phase === 'prompt' && publication.resolving) ||
    (publication.phase === 'uncertain' && publication.checking)
  )
}

export interface QuitSendsDeps {
  /** The editors as committed now. */
  current(): readonly Editor[]
  cancelPrompt(editorId: EditorId): Promise<unknown>
  recheck(editorId: EditorId): Promise<unknown>
  /** Resolved once everything dispatched before the call is committed. */
  flush(): Promise<void>
  /** Resolved after the next committed change of the editors. */
  nextChange(): Promise<void>
}

/** Waits until no send settles by itself; `false`: some send is still uncertain after its one more lookup. */
export async function settleQuitSends(deps: QuitSendsDeps): Promise<boolean> {
  const rechecked = new Set<EditorId>()
  for (;;) {
    const editors = deps.current()
    const prompts = editors.filter((editor) => editor.publication?.phase === 'prompt' && !editor.publication.resolving)
    if (prompts.length > 0) {
      await Promise.all(prompts.map((editor) => deps.cancelPrompt(editor.id)))
      await deps.flush()
      continue
    }
    if (editors.some(settling)) {
      await deps.nextChange()
      continue
    }
    const unchecked = editors.filter(
      (editor) => editor.publication?.phase === 'uncertain' && !editor.publication.checking && !rechecked.has(editor.id)
    )
    if (unchecked.length > 0) {
      for (const editor of unchecked) rechecked.add(editor.id)
      await Promise.all(unchecked.map((editor) => deps.recheck(editor.id)))
      await deps.flush()
      continue
    }
    return !editors.some((editor) => editor.publication?.phase === 'uncertain')
  }
}
