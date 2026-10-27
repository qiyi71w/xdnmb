import { describe, expect, it } from 'vitest'
import { EMPTY_FIELDS, type IdentityChoice, type PostTarget, type SavedDraft } from '../../src/shared/drafts'
import type { IdentityOverview } from '../../src/shared/identity'
import {
  editorFor,
  editorOnScreen,
  editorForDraft,
  editorsReducer,
  identityStatus,
  INITIAL_EDITORS,
  pendingInTab,
  saveInput,
  wantsWrite,
  type Editor,
  type EditorsAction,
  type EditorsState
} from '../../src/renderer/src/features/editor/editorsState'

const run = (state: EditorsState, ...actions: EditorsAction[]) => actions.reduce(editorsReducer, state)
const replyA: PostTarget = { kind: 'reply', threadId: '50000001' }
const replyB: PostTarget = { kind: 'reply', threadId: '50000002' }
const newThread: PostTarget = { kind: 'thread', forumId: '4' }
const byDefault = (credentialId: string): IdentityChoice => ({ source: 'default', selection: { state: 'selected', credentialId } })

function only(state: EditorsState, tabId: number, target: PostTarget): Editor {
  const editor = editorFor(state, target)
  if (editor === null) throw new Error('no editor')
  expect(editor.tabIds).toContain(tabId)
  return editor
}

function draft(patch: Partial<SavedDraft> = {}): SavedDraft {
  return {
    id: '7', version: 1, createdAt: '2026-10-24T00:00:00.000Z', savedAt: '2026-10-24T00:00:00.000Z',
    target: replyA, credentialId: '1', fields: { ...EMPTY_FIELDS, content: '已保存' }, attachment: null, ...patch
  }
}

const overview = (ids: string[]): IdentityOverview => ({
  protection: 'available', writable: true,
  credentials: ids.map((id) => ({ id, name: `饼干${id}`, cookieId: null, source: 'raw', importedAt: '2026-10-24T00:00:00.000Z' })),
  roles: { 'default-post': { state: 'none' }, 'web-sync': { state: 'none' } }
})

describe('editors across threads and tabs', () => {
  it('keeps a thread’s editor in its tab while the tab shows another thread and restores it on return', () => {
    let state = run(INITIAL_EDITORS, { type: 'open', tabId: 1, target: replyA, identity: byDefault('1') })
    const a = only(state, 1, replyA)
    state = run(state,
      { type: 'edit', editorId: a.id, patch: { content: 'A 的回复' } },
      { type: 'open', tabId: 1, target: replyB, identity: byDefault('1') }
    )
    expect(state.editors).toHaveLength(2)
    expect(only(state, 1, replyB).id).not.toBe(a.id)
    // Back on A: the reply entry restores the same editor and its text instead of starting over.
    state = run(state, { type: 'open', tabId: 1, target: replyA, identity: byDefault('2') })
    expect(only(state, 1, replyA)).toMatchObject({ id: a.id, credentialId: '1', fields: { content: 'A 的回复' } })
  })

  it('shares one editor and its content across tabs showing the same thread', () => {
    let state = run(INITIAL_EDITORS,
      { type: 'open', tabId: 1, target: replyA, identity: byDefault('1') },
      { type: 'open', tabId: 2, target: replyA, identity: byDefault('1') }
    )
    state = run(state, { type: 'edit', editorId: only(state, 1, replyA).id, patch: { content: '标签一' } })
    expect(state.editors).toHaveLength(1)
    expect(only(state, 2, replyA).fields.content).toBe('标签一')
    expect(pendingInTab(state, 2)).toEqual([])
    state = run(state, { type: 'close-tab', tabId: 2 })
    expect(only(state, 1, replyA).fields.content).toBe('标签一')
    expect(only(state, 1, replyA).tabIds).toEqual([1])
    expect(pendingInTab(state, 1)).toHaveLength(1)
    state = run(state, { type: 'close-tab', tabId: 1 })
    expect(state.editors).toEqual([])
  })

  it('fixes the identity at creation: later default changes only reach editors started afterwards', () => {
    let state = run(INITIAL_EDITORS, { type: 'open', tabId: 1, target: replyA, identity: byDefault('1') })
    state = run(state, { type: 'open', tabId: 1, target: replyB, identity: byDefault('2') })
    expect(only(state, 1, replyA).credentialId).toBe('1')
    expect(only(state, 1, replyB).credentialId).toBe('2')
    state = run(state, { type: 'set-identity', editorId: only(state, 1, replyB).id, credentialId: '3' })
    expect(only(state, 1, replyA).credentialId).toBe('1')
  })

  it('reports a removed selection as missing instead of substituting another identity', () => {
    const state = run(INITIAL_EDITORS,
      { type: 'open', tabId: 1, target: replyA, identity: { source: 'thread', selection: { state: 'missing', credentialId: '5' } } },
      { type: 'open', tabId: 1, target: replyB, identity: { source: 'unknown' } },
      { type: 'open', tabId: 1, target: newThread, identity: { source: 'default', selection: { state: 'none' } } }
    )
    const ids = overview(['1'])
    expect(identityStatus(only(state, 1, replyA), ids)).toEqual({ state: 'missing', credentialId: '5' })
    expect(identityStatus(only(state, 1, replyB), ids)).toEqual({ state: 'unknown' })
    expect(identityStatus(only(state, 1, newThread), ids)).toEqual({ state: 'none' })
    const chosen = run(state, { type: 'set-identity', editorId: only(state, 1, replyA).id, credentialId: '1' })
    expect(identityStatus(only(chosen, 1, replyA), ids)).toEqual({ state: 'selected', credentialId: '1', name: '饼干1' })
  })

  it('changes the target only explicitly, keeps the identity and never makes two editors for one target', () => {
    let state = run(INITIAL_EDITORS,
      { type: 'open', tabId: 1, target: replyA, identity: byDefault('1') },
      { type: 'open', tabId: 2, target: replyB, identity: byDefault('2') }
    )
    const a = only(state, 1, replyA)
    expect(run(state, { type: 'retarget', editorId: a.id, target: replyB })).toBe(state)
    state = run(state, { type: 'retarget', editorId: a.id, target: newThread })
    expect(only(state, 1, newThread)).toMatchObject({ id: a.id, credentialId: '1' })
    expect(editorFor(state, replyA)).toBeNull()
  })
})

describe('drafts in editors', () => {
  it('continues each saved draft in one shared editor without replacing its content on a plain reply', () => {
    let state = run(INITIAL_EDITORS, { type: 'open-draft', tabId: 3, draft: draft() })
    expect(editorForDraft(state, '7')).toMatchObject({ tabId: 3, fields: { content: '已保存' }, credentialId: '1' })
    state = run(state, { type: 'open-draft', tabId: 4, draft: draft() })
    expect(only(state, 4, replyA).draft?.id).toBe('7')
    state = run(state, { type: 'open', tabId: 5, target: replyA, identity: byDefault('2') })
    expect(state.editors).toHaveLength(1)
    expect(only(state, 5, replyA)).toMatchObject({ draft: { id: '7' }, fields: { content: '已保存' }, credentialId: '1' })
  })

  it('wants a draft once text or an image is there, not for identity, target, watermark or whitespace alone', () => {
    let state = run(INITIAL_EDITORS, { type: 'open', tabId: 1, target: replyA, identity: byDefault('1') })
    const editor = only(state, 1, replyA)
    state = run(state,
      { type: 'set-identity', editorId: editor.id, credentialId: '2' },
      { type: 'edit', editorId: editor.id, patch: { watermark: true, content: ' \n ', title: '  ' } },
      { type: 'retarget', editorId: editor.id, target: replyB })
    expect(wantsWrite(only(state, 1, replyB))).toBe(false)
    state = run(state, { type: 'edit', editorId: editor.id, patch: { name: '无名氏' } })
    expect(wantsWrite(only(state, 1, replyB))).toBe(true)
    const attachment = { id: '12', format: 'png' as const, bytes: 100, width: 10, height: 10, originalName: 'image.png', url: 'xidao-image://draft/image.png' }
    state = run(state, { type: 'edit', editorId: editor.id, patch: { name: '' } }, { type: 'set-attachment', editorId: editor.id, attachment })
    expect(wantsWrite(only(state, 1, replyB))).toBe(true)
  })

  it('a saved editor wants a write for any change of its draft, and its draft deleted once emptied', () => {
    let state = run(INITIAL_EDITORS, { type: 'open-draft', tabId: 1, draft: draft() })
    const editor = only(state, 1, replyA)
    expect(wantsWrite(editor)).toBe(false)
    for (const action of [
      { type: 'set-identity', editorId: editor.id, credentialId: '9' },
      { type: 'retarget', editorId: editor.id, target: replyB },
      { type: 'edit', editorId: editor.id, patch: { watermark: true } }
    ] satisfies EditorsAction[]) expect(wantsWrite(run(state, action).editors[0]!)).toBe(true)
    // Emptied (whitespace only): its draft is out of date and goes; once cleared, nothing is left to do.
    state = run(state, { type: 'edit', editorId: editor.id, patch: { content: '   ' } })
    expect(wantsWrite(only(state, 1, replyA))).toBe(true)
    state = run(state, { type: 'draft-cleared', editorId: editor.id, draftId: '7' })
    expect(only(state, 1, replyA).draft).toBeNull()
    expect(wantsWrite(only(state, 1, replyA))).toBe(false)
    // Clearing names a draft: a stale clear of another draft changes nothing.
    const rebound = run(state, { type: 'saved', editorId: editor.id, draft: draft({ id: '8' }) })
    expect(run(rebound, { type: 'draft-cleared', editorId: editor.id, draftId: '7' })).toBe(rebound)
  })

  it('edits made while a save was in flight still want a write after it completes, to the same draft', () => {
    let state = run(INITIAL_EDITORS, { type: 'open', tabId: 1, target: replyA, identity: byDefault('1') })
    const editor = only(state, 1, replyA)
    state = run(state, { type: 'edit', editorId: editor.id, patch: { content: '第一版' } })
    const sent = saveInput(only(state, 1, replyA))
    expect(sent).toMatchObject({ draftId: null, target: replyA, credentialId: '1', attachmentId: null, fields: { content: '第一版' } })
    state = run(state,
      { type: 'edit', editorId: editor.id, patch: { content: '第一版又改' } },
      { type: 'saved', editorId: editor.id, draft: draft({ fields: sent.fields, credentialId: '1' }) }
    )
    expect(wantsWrite(only(state, 1, replyA))).toBe(true)
    expect(saveInput(only(state, 1, replyA)).draftId).toBe('7')
  })

  it('deleting a draft empties and collapses its editor (target and identity stay), or closes it', () => {
    let state = run(INITIAL_EDITORS, { type: 'open-draft', tabId: 1, draft: draft() })
    const editor = only(state, 1, replyA)
    state = run(state, { type: 'edit', editorId: editor.id, patch: { title: '标题' } }, { type: 'draft-deleted', editorId: editor.id })
    expect(only(state, 1, replyA)).toMatchObject({ id: editor.id, target: replyA, credentialId: '1', fields: EMPTY_FIELDS, attachment: null, draft: null, expanded: false })
    expect(wantsWrite(only(state, 1, replyA))).toBe(false)
    expect(editorForDraft(state, '7')).toBeNull()
    // Opening its target again starts from the emptied editor.
    state = run(state, { type: 'open', tabId: 1, target: replyA, identity: byDefault('2') })
    expect(only(state, 1, replyA)).toMatchObject({ id: editor.id, expanded: true, credentialId: '1' })

    const library = run(INITIAL_EDITORS, { type: 'open-draft', tabId: 1, draft: draft() }, { type: 'open', tabId: 1, target: replyB, identity: byDefault('1') })
    const closed = run(library, { type: 'close-editor', editorId: only(library, 1, replyA).id })
    expect(closed.editors.map((item) => item.target)).toEqual([replyB])
  })

  it('continues another draft of the same target in the editor already there, and only there', () => {
    let state = run(INITIAL_EDITORS,
      { type: 'open', tabId: 1, target: replyA, identity: byDefault('2') },
      { type: 'open-draft', tabId: 1, draft: draft({ id: '9', target: replyB }) })
    const editor = only(state, 1, replyA)
    state = run(state, { type: 'edit', editorId: editor.id, patch: { content: '先写的' } }, { type: 'set-expanded', editorId: editor.id, expanded: false })
    const second = draft({ id: '8', credentialId: '3', fields: { ...EMPTY_FIELDS, content: '第二份' } })
    state = run(state, { type: 'load-draft', editorId: editor.id, draft: second })
    expect(only(state, 1, replyA)).toMatchObject({ id: editor.id, draft: second, credentialId: '3', fields: { content: '第二份' }, expanded: true })
    expect(wantsWrite(only(state, 1, replyA))).toBe(false)
    // Never another target's draft (one editor per target), nor a draft another editor continues.
    expect(run(state, { type: 'load-draft', editorId: editor.id, draft: draft({ id: '10', target: replyB }) })).toBe(state)
    expect(run(state, { type: 'load-draft', editorId: editor.id, draft: draft({ id: '9' }) })).toBe(state)
  })

  it('collects only last-owner editors whose draft is out of date, including hidden and emptied ones', () => {
    let state = run(INITIAL_EDITORS,
      { type: 'open', tabId: 1, target: replyA, identity: byDefault('1') },
      { type: 'open', tabId: 1, target: replyB, identity: byDefault('1') },
      { type: 'open-draft', tabId: 1, draft: draft({ target: newThread }) },
      { type: 'open', tabId: 2, target: replyA, identity: byDefault('1') }
    )
    state = run(state,
      { type: 'edit', editorId: only(state, 1, replyB).id, patch: { content: '隐藏的 B' } },
      { type: 'edit', editorId: only(state, 1, newThread).id, patch: { content: '' } },
      { type: 'edit', editorId: only(state, 2, replyA).id, patch: { content: '另一标签' } }
    )
    expect(pendingInTab(state, 1).map((editor) => editor.target)).toEqual([replyB, newThread])
    state = run(state, { type: 'close-tab', tabId: 1 })
    expect(state.editors.map((editor) => editor.tabId)).toEqual([2])
    expect(only(state, 2, replyA).fields.content).toBe('另一标签')
  })

  it('restores duplicate targets by newest saved time, retaining the older saved draft', () => {
    const older = draft({ id: '7', fields: { ...EMPTY_FIELDS, content: '旧内容' } })
    const newer = draft({ id: '8', savedAt: '2026-10-25T00:00:00.000Z', fields: { ...EMPTY_FIELDS, content: '新内容' } })
    const items = [{ tabId: 1, expanded: false, draft: older }, { tabId: 2, expanded: true, draft: newer }]
    for (const ordered of [items, [...items].reverse()]) {
      const state = run(INITIAL_EDITORS, { type: 'restore-drafts', items: ordered })
      expect(state.editors).toHaveLength(1)
      expect(only(state, 1, replyA)).toMatchObject({ draft: newer, fields: { content: '新内容' }, expanded: true })
      expect(only(state, 2, replyA).id).toBe(only(state, 1, replyA).id)
      expect(older.fields.content).toBe('旧内容')
      expect(editorForDraft(state, older.id)).toBeNull()
    }
    const tied = run(INITIAL_EDITORS, { type: 'restore-drafts', items: [
      { tabId: 2, expanded: true, draft: { ...newer, savedAt: older.savedAt } },
      { tabId: 1, expanded: false, draft: older }
    ] })
    expect(editorFor(tied, replyA)?.draft?.id).toBe(older.id)
  })

  it('shares new-thread boards, keeps other boards independent, and preserves send locks across tabs', () => {
    let state = run(INITIAL_EDITORS,
      { type: 'open', tabId: 1, target: newThread, identity: byDefault('1') },
      { type: 'open', tabId: 2, target: newThread, identity: byDefault('2') },
      { type: 'open', tabId: 3, target: { kind: 'thread', forumId: '18' }, identity: byDefault('1') })
    expect(state.editors).toHaveLength(2)
    const editor = only(state, 2, newThread)
    expect(editor.credentialId).toBe('1')
    state = run(state, { type: 'publish-start', editorId: editor.id, requestId: 'shared-send' })
    const locked = only(state, 1, newThread)
    state = run(state,
      { type: 'edit', editorId: editor.id, patch: { content: '不能改' } },
      { type: 'draft-deleted', editorId: editor.id },
      { type: 'load-draft', editorId: editor.id, draft: draft({ target: newThread }) },
      { type: 'close-editor', editorId: editor.id })
    expect(only(state, 2, newThread)).toEqual(locked)
    state = run(state, { type: 'close-tab', tabId: 2 })
    expect(only(state, 1, newThread).publication?.phase).toBe('submitting')
  })
})

describe('failed send editor on screen', () => {
  it('counts an explicitly failed editor as on screen only while it stays expanded on a displayed target', () => {
    let state = run(INITIAL_EDITORS, { type: 'open', tabId: 1, target: replyA, identity: byDefault('1') })
    const editor = only(state, 1, replyA)
    state = run(state, { type: 'publish-start', editorId: editor.id, requestId: 'r1' },
      { type: 'publish-failed', editorId: editor.id, problem: 'rejected', draft: draft({ fields: { ...EMPTY_FIELDS, content: '会被拒绝' } }) })
    // The failure keeps the editor expanded, bound to its draft: its own notice is on screen.
    expect(only(state, 1, replyA)).toMatchObject({ expanded: true, publication: null, draft: { id: '7' } })
    expect(editorOnScreen(state, editor.id, [replyA])).toBe(true)
    // Another tab, another thread or the settings page displays something else.
    expect(editorOnScreen(state, editor.id, [replyB])).toBe(false)
    expect(editorOnScreen(state, editor.id, [])).toBe(false)
    // Collapsed, or gone: not on screen.
    expect(editorOnScreen(run(state, { type: 'set-expanded', editorId: editor.id, expanded: false }), editor.id, [replyA])).toBe(false)
    expect(editorOnScreen(state, 'other-editor', [replyA])).toBe(false)
  })
})
