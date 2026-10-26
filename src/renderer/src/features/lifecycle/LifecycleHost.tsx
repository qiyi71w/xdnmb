import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AppPlatform } from '../../../../shared/api'
import type { EditorId } from '../../../../shared/drafts'
import type { LifecycleRequest } from '../../../../shared/lifecycle'
import type { PublicationAttempt } from '../../../../shared/publication'
import type { AppSettings } from '../../../../shared/settings'
import { matchShortcut } from '../../app/shortcuts'
import { unsavedEditors, type Editor } from '../editor/editorsState'
import { UnsavedEditorsDialog } from '../editor/UnsavedEditorsDialog'
import { useEditorWorkspace } from '../editor/workspace'
import { serializeWorkspace, type Workspace } from '../tabs/workspaceSnapshot'
import { CloseChoiceDialog, type CloseChoice } from './CloseChoiceDialog'
import { QuitUncheckedDialog, QuitWorkingDialog, UnstoredResultsDialog, WorkspaceSaveFailedDialog, type QuitWork } from './QuitDialogs'

/** What the running quit is asking; `null` while it works without asking. */
type QuitQuestion =
  | { kind: 'unsaved'; editorIds: EditorId[] }
  | { kind: 'unchecked' }
  | { kind: 'save-failed'; saving: boolean }

type Answer = 'continue' | 'cancel'

/** A send that settles by itself: its request, a PO answer, or a lookup of an uncertain request is running. */
function settling(editor: Editor): boolean {
  const publication = editor.publication
  if (publication === null) return false
  return (
    publication.phase === 'submitting' ||
    (publication.phase === 'prompt' && publication.resolving) ||
    (publication.phase === 'uncertain' && publication.checking)
  )
}

function ignore(): undefined {
  return undefined
}

/**
 * Main-process lifecycle requests. `close` offers 后台驻留 / 退出汐岛; `quit` runs the real quit:
 * close competing dialogs, cancel open PO questions, wait for sends that settle by themselves (an
 * uncertain one is checked once; still uncertain stops the quit), handle every unsaved editor of
 * every tab, save the workspace, then let the main process close the window. Nothing is ever sent,
 * a locked editor is never saved, and the window is shown only when there is something to answer.
 * From start to completion or cancellation the rest of the window is inert (a question, or the
 * working dialog), so nothing can change after the unsaved edits were handled.
 * After the startup restore, results the last quit could not store stop it with a retry dialog.
 */
export function LifecycleHost({
  platform,
  onSettingsChange,
  closeModals,
  buildWorkspace,
  whenRestored
}: {
  platform: AppPlatform | null
  onSettingsChange: (settings: AppSettings) => void
  /** Closes the app's other dialogs (settings, drafts, attempts, own posts, a tab's close question). */
  closeModals: () => void
  /** The workspace now, each shown thread captured where it is; `null` before the tabs exist. */
  buildWorkspace: () => Workspace | null
  /** Settles once the startup restore (tabs and reopened drafts) is done. */
  whenRestored: () => Promise<void>
}) {
  const { store } = useEditorWorkspace()
  const [choiceOpen, setChoiceOpen] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const [question, setQuestion] = useState<QuitQuestion | null>(null)
  /** A quit is running (`null`: none); shown as the working dialog whenever no question is open. */
  const [work, setWork] = useState<QuitWork | null>(null)
  /** Results of sends the last quit could not store; `null`: nothing to show. */
  const [unstored, setUnstored] = useState<PublicationAttempt[] | null>(null)
  const choiceOpenRef = useRef(false)
  const quitting = useRef(false)
  /** The running quit showed the window to ask something. */
  const presented = useRef(false)
  const answerRef = useRef<((answer: Answer) => void) | null>(null)

  // ---------- Waiting for committed state ----------
  /** Resolved after the next commit of the editors' state (any change). */
  const changeWaiters = useRef<(() => void)[]>([])
  useEffect(() => {
    const waiters = changeWaiters.current
    changeWaiters.current = []
    for (const resolve of waiters) resolve()
  }, [store.state])
  const nextChange = useCallback(() => {
    const { promise, resolve } = Promise.withResolvers<void>()
    changeWaiters.current.push(resolve)
    return promise
  }, [])

  /** Resolved once everything dispatched before the call is committed (and `store.current()` shows it). */
  const [flushTick, setFlushTick] = useState(0)
  const flushWaiters = useRef<(() => void)[]>([])
  useEffect(() => {
    const waiters = flushWaiters.current
    flushWaiters.current = []
    for (const resolve of waiters) resolve()
  }, [flushTick])
  const flush = useCallback(() => {
    const { promise, resolve } = Promise.withResolvers<void>()
    flushWaiters.current.push(resolve)
    setFlushTick((tick) => tick + 1)
    return promise
  }, [])

  // ---------- Quit ----------
  const ask = useCallback(
    async (next: QuitQuestion): Promise<Answer> => {
      presented.current = true
      await window.xidao.lifecycle.presentQuit().catch(ignore)
      const { promise, resolve } = Promise.withResolvers<Answer>()
      answerRef.current = resolve
      setQuestion(next)
      return promise
    },
    []
  )

  const answer = useCallback((value: Answer) => {
    const resolve = answerRef.current
    answerRef.current = null
    resolve?.(value)
  }, [])

  /**
   * Cancels open PO questions and waits until no send is settling by itself; uncertain requests are
   * looked up once more. `false`: some send is still uncertain.
   */
  const settle = useCallback(async (): Promise<boolean> => {
    const rechecked = new Set<EditorId>()
    for (;;) {
      const editors = store.current().editors
      const prompts = editors.filter((editor) => editor.publication?.phase === 'prompt' && !editor.publication.resolving)
      if (prompts.length > 0) {
        await Promise.all(prompts.map((editor) => store.resolvePrompt(editor.id, 'cancel', false)))
        await flush()
        continue
      }
      if (editors.some(settling)) {
        await nextChange()
        continue
      }
      const unchecked = editors.filter(
        (editor) => editor.publication?.phase === 'uncertain' && !editor.publication.checking && !rechecked.has(editor.id)
      )
      if (unchecked.length > 0) {
        for (const editor of unchecked) rechecked.add(editor.id)
        await Promise.all(unchecked.map((editor) => store.recheck(editor.id)))
        await flush()
        continue
      }
      return !editors.some((editor) => editor.publication?.phase === 'uncertain')
    }
  }, [store, flush, nextChange])

  const quit = useCallback(async () => {
    quitting.current = true
    presented.current = false
    let completed = false
    const cancel = () => {
      setQuestion(null)
      void window.xidao.lifecycle.cancelQuit().catch(ignore)
    }
    try {
      // In one commit: competing dialogs close and the working dialog takes the focus.
      setWork('preparing')
      setUnstored(null)
      closeModals()
      choiceOpenRef.current = false
      setChoiceOpen(false)
      await whenRestored()
      await flush()

      if (!(await settle())) {
        await ask({ kind: 'unchecked' })
        cancel()
        return
      }

      const unsaved = unsavedEditors(store.current())
      if (unsaved.length > 0) {
        const choice = await ask({ kind: 'unsaved', editorIds: unsaved.map((editor) => editor.id) })
        setQuestion(null)
        if (choice === 'cancel') {
          cancel()
          return
        }
        // Saved drafts and discards must be in the state the workspace is built from.
        await flush()
      }

      setWork('saving')
      for (;;) {
        const workspace = buildWorkspace()
        let saved = false
        if (workspace !== null) {
          try {
            saved = (await window.xidao.lifecycle.saveWorkspace({ workspace: serializeWorkspace(workspace) })).ok
          } catch {
            saved = false
          }
        }
        if (saved) break
        if ((await ask({ kind: 'save-failed', saving: false })) === 'cancel') {
          cancel()
          return
        }
        setQuestion({ kind: 'save-failed', saving: true })
      }
      setQuestion(null)
      completed = await window.xidao.lifecycle.completeQuit().then(
        () => true,
        () => false
      )
    } finally {
      quitting.current = false
      presented.current = false
      // After a completed quit the window is about to close: it stays inert until then.
      if (!completed) setWork(null)
    }
  }, [closeModals, whenRestored, flush, settle, ask, store, buildWorkspace])

  // The app-level dispatcher skips shortcuts while a modal dialog covers the app; a running quit
  // takes them all for its whole duration (dialog or not), before that dispatcher, which skips
  // prevented events.
  const quitRunning = work !== null
  useLayoutEffect(() => {
    if (!quitRunning || platform === null) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (matchShortcut(event, platform) !== null) event.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [quitRunning, platform])

  // ---------- Results the last quit could not store ----------
  useEffect(() => {
    let alive = true
    void (async () => {
      await whenRestored()
      const { attempts } = await window.xidao.lifecycle.listUnstoredResults()
      // A running quit owns the window and its questions; it also closes this dialog when it starts.
      if (alive && !quitting.current && attempts.length > 0) setUnstored(attempts)
    })().catch(ignore)
    return () => {
      alive = false
    }
  }, [whenRestored])

  // ---------- Close choice ----------
  const choose = useCallback(
    async (choice: CloseChoice, remember: boolean) => {
      setChoosing(true)
      if (remember) {
        try {
          // Not saved: the effective settings come back unchanged; the choice still happens now.
          onSettingsChange((await window.xidao.settings.update({ closeAction: choice })).settings)
        } catch {
          // Keeps the current setting; the choice still happens now.
        }
      }
      setChoosing(false)
      // A quit that started meanwhile closed this question and owns the window now.
      if (!choiceOpenRef.current) return
      choiceOpenRef.current = false
      setChoiceOpen(false)
      if (choice === 'background') void window.xidao.lifecycle.reside().catch(ignore)
      else void window.xidao.lifecycle.requestQuit().catch(ignore)
    },
    [onSettingsChange]
  )

  const dismissChoice = useCallback(() => {
    choiceOpenRef.current = false
    setChoiceOpen(false)
  }, [])

  // ---------- Requests ----------
  const onRequest = useRef<(request: LifecycleRequest) => void>(() => undefined)
  useLayoutEffect(() => {
    onRequest.current = (request) => {
      if (request.kind === 'close') {
        if (quitting.current || choiceOpenRef.current) return
        choiceOpenRef.current = true
        setChoiceOpen(true)
        return
      }
      if (quitting.current) {
        // Asked again (tray, close button) while a question waits: bring the window back to it.
        if (presented.current) void window.xidao.lifecycle.presentQuit().catch(ignore)
        return
      }
      void quit()
    }
  })

  useEffect(() => window.xidao.lifecycle.onRequest((request) => onRequest.current(request)), [])

  return (
    <>
      {choiceOpen && (
        <CloseChoiceDialog
          platform={platform}
          busy={choosing}
          onChoose={(choice, remember) => void choose(choice, remember)}
          onDismiss={dismissChoice}
        />
      )}
      {work !== null && question === null && <QuitWorkingDialog work={work} />}
      {question?.kind === 'unchecked' && <QuitUncheckedDialog onClose={() => answer('cancel')} />}
      {question?.kind === 'unsaved' && (
        <UnsavedEditorsDialog
          label="退出汐岛"
          intro={`还有 ${question.editorIds.length} 份未保存的编辑`}
          verb="退出"
          editorIds={question.editorIds}
          onFinish={() => answer('continue')}
          onCancel={() => answer('cancel')}
        />
      )}
      {question?.kind === 'save-failed' && (
        <WorkspaceSaveFailedDialog saving={question.saving} onRetry={() => answer('continue')} onCancel={() => answer('cancel')} />
      )}
      {unstored !== null && (
        <UnstoredResultsDialog
          attempts={unstored}
          onCancel={() => setUnstored(null)}
          onStored={() => {
            setUnstored(null)
            void window.xidao.lifecycle.requestQuit().catch(ignore)
          }}
        />
      )}
    </>
  )
}
