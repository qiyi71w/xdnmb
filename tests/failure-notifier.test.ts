import { describe, expect, it } from 'vitest'
import { EMPTY_FIELDS } from '../src/shared/drafts'
import type { PublicationAttempt, SendFailureNotice } from '../src/shared/publication'
import { createFailureNotifier } from '../src/main/publication/failureNotifier'

function failed(id: string): PublicationAttempt {
  return {
    id, requestId: `request-${id}`, editorId: `editor-${id}`, draftId: null,
    payload: { draftId: null, target: { kind: 'reply', threadId: '42' }, credentialId: '1', fields: { ...EMPTY_FIELDS, content: '正文' }, attachmentId: null },
    state: 'failed', problem: 'rejected', createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:01.000Z',
    postId: null, threadId: null, savedDraftId: `draft-${id}`, cookieId: null
  }
}

/** A window that may be in front or not, may have a renderer or not, and system notifications that may fail. */
function harness(options: { supported?: boolean; showThrows?: boolean } = {}) {
  const state = { front: false, renderer: true }
  const inApp: string[] = []
  const opened: SendFailureNotice[] = []
  const created: Array<{ title: string; body: string; listeners: Map<string, () => void> }> = []
  const notifier = createFailureNotifier({
    foreground: () => state.front,
    showInApp(notice, missed) {
      if (!state.renderer) return false
      inApp.push(missed ? `${notice.attemptId} (missed)` : notice.attemptId)
      return true
    },
    isSupported: () => options.supported ?? true,
    create(message) {
      const listeners = new Map<string, () => void>()
      created.push({ ...message, listeners })
      return {
        on(event, listener) { listeners.set(event, listener) },
        show() { if (options.showThrows === true) throw new Error('desktop failure') }
      }
    },
    forumName: async () => null,
    async openDraft(notice) { opened.push(notice) }
  })
  return { state, inApp, opened, created, notifier }
}

describe('send failure notifier', () => {
  it('shows a system notification behind the window and opens the draft when it is clicked', async () => {
    const h = harness()
    await h.notifier.recorded(failed('a'))
    expect(h.inApp).toEqual([])
    expect(h.created.map(({ title, body }) => ({ title, body }))).toEqual([{ title: '发送失败：论坛拒绝了这次发言', body: '回复 No.42，内容已存为草稿' }])
    h.created[0]!.listeners.get('click')!()
    expect(h.opened).toEqual([{ attemptId: 'a', editorId: 'editor-a', draftId: 'draft-a', problem: 'rejected', target: { kind: 'reply', threadId: '42' } }])
    // A shown system notification owes no in-app notice later.
    h.state.front = true
    h.notifier.windowShown()
    expect(h.inApp).toEqual([])
  })

  it.each([
    ['unsupported', { supported: false }],
    ['throws on show', { showThrows: true }]
  ])('owes an in-app notice when the system notification is %s, delivered once the window is shown', async (_name, options) => {
    const h = harness(options)
    await h.notifier.recorded(failed('a'))
    expect(h.inApp).toEqual([])
    h.notifier.windowShown()
    h.notifier.windowShown()
    expect(h.inApp).toEqual(['a (missed)'])
  })

  it('keeps a notice owed for a failed system notification until a renderer takes it', async () => {
    const h = harness()
    await h.notifier.recorded(failed('a'))
    await h.notifier.recorded(failed('b'))
    h.created[0]!.listeners.get('failed')!()
    h.created[1]!.listeners.get('failed')!()
    h.state.renderer = false
    h.notifier.windowShown()
    expect(h.inApp).toEqual([])
    h.state.renderer = true
    h.notifier.windowShown()
    expect(h.inApp).toEqual(['a (missed)', 'b (missed)'])
  })

  it('reports a system notification that fails while the window is in front in the app at once', async () => {
    const h = harness()
    await h.notifier.recorded(failed('a'))
    h.state.front = true
    h.created[0]!.listeners.get('failed')!()
    expect(h.inApp).toEqual(['a (missed)'])
  })

  it('shows failures in the app while the window is in front, and nothing for other results', async () => {
    const h = harness()
    h.state.front = true
    await h.notifier.recorded(failed('a'))
    for (const state of ['confirmed', 'unknown', 'unconfirmed'] as const) await h.notifier.recorded({ ...failed(state), state })
    await h.notifier.recorded({ ...failed('no-draft'), savedDraftId: null })
    expect(h.inApp).toEqual(['a'])
    expect(h.created).toEqual([])
  })
})
