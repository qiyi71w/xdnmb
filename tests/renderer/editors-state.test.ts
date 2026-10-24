import { describe, expect, it } from 'vitest'
import { EMPTY_FIELDS, type IdentityChoice, type PostTarget, type SavedDraft } from '../../src/shared/drafts'
import type { IdentityOverview } from '../../src/shared/identity'
import {
  editorFor,
  editorForDraft,
  editorsReducer,
  identityStatus,
  INITIAL_EDITORS,
  isUnsaved,
  saveInput,
  unsavedInTab,
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
  const editor = editorFor(state, tabId, target)
  if (editor === null) throw new Error('no editor')
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
  credentials: ids.map((id) => ({ id, name: `饼干${id}`, source: 'raw', importedAt: '2026-10-24T00:00:00.000Z' })),
  roles: { browse: { state: 'none' }, 'default-post': { state: 'none' }, 'web-sync': { state: 'none' } }
})

describe('editors across threads and tabs', () => {
  it('keeps a thread’s editor in its tab while the tab shows another thread and restores it on return', () => {
    let state = run(INITIAL_EDITORS, { type: 'open', tabId: 1, target: replyA, identity: byDefault('1') })
    const a = only(state, 1, replyA)
    state = run(state,
      { type: 'edit', editorId: a.id, patch: { content: 'A 的回复' } },
      { type: 'open', tabId: 1, target: replyB, identity: byDefault('1') }
    )
    expect(only(state, 1, replyB).id).not.toBe(a.id)
    // Back on A: the reply entry restores the same editor and its text instead of starting over.
    state = run(state, { type: 'open', tabId: 1, target: replyA, identity: byDefault('2') })
    expect(only(state, 1, replyA)).toMatchObject({ id: a.id, credentialId: '1', fields: { content: 'A 的回复' } })
  })

  it('gives another tab its own editor for the same thread', () => {
    let state = run(INITIAL_EDITORS,
      { type: 'open', tabId: 1, target: replyA, identity: byDefault('1') },
      { type: 'open', tabId: 2, target: replyA, identity: byDefault('1') }
    )
    state = run(state, { type: 'edit', editorId: only(state, 1, replyA).id, patch: { content: '标签一' } })
    expect(only(state, 2, replyA).fields.content).toBe('')
    expect(unsavedInTab(state, 2)).toEqual([])
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
      { type: 'open', tabId: 1, target: replyB, identity: byDefault('2') }
    )
    const a = only(state, 1, replyA)
    expect(run(state, { type: 'retarget', editorId: a.id, target: replyB })).toBe(state)
    state = run(state, { type: 'retarget', editorId: a.id, target: newThread })
    expect(only(state, 1, newThread)).toMatchObject({ id: a.id, credentialId: '1' })
    expect(editorFor(state, 1, replyA)).toBeNull()
  })
})

describe('drafts in editors', () => {
  it('continues a saved draft in one editor only and never picks it up for a plain reply entry', () => {
    let state = run(INITIAL_EDITORS, { type: 'open-draft', tabId: 3, draft: draft() })
    expect(editorForDraft(state, '7')).toMatchObject({ tabId: 3, fields: { content: '已保存' }, credentialId: '1' })
    expect(run(state, { type: 'open-draft', tabId: 4, draft: draft() })).toBe(state)
    state = run(state, { type: 'open', tabId: 5, target: replyA, identity: byDefault('2') })
    expect(only(state, 5, replyA)).toMatchObject({ draft: null, fields: { content: '' }, credentialId: '2' })
  })

  it('discarding returns a draft editor to its saved version; only a new editor disappears', () => {
    let state = run(INITIAL_EDITORS, { type: 'open-draft', tabId: 1, draft: draft() })
    const editor = only(state, 1, replyA)
    expect(isUnsaved(editor)).toBe(false)
    state = run(state,
      { type: 'edit', editorId: editor.id, patch: { content: '改了' } },
      { type: 'set-identity', editorId: editor.id, credentialId: '9' },
      { type: 'retarget', editorId: editor.id, target: replyB }
    )
    expect(isUnsaved(only(state, 1, replyB))).toBe(true)
    state = run(state, { type: 'discard', editorId: editor.id })
    expect(only(state, 1, replyA)).toMatchObject({ id: editor.id, credentialId: '1', fields: { content: '已保存' } })

    state = run(state, { type: 'open', tabId: 1, target: newThread, identity: byDefault('1') })
    const fresh = only(state, 1, newThread)
    state = run(state, { type: 'discard', editorId: fresh.id })
    expect(editorFor(state, 1, newThread)).toBeNull()
  })

  it('discarding a retargeted draft whose saved target is now edited by another editor keeps both reachable', () => {
    let state = run(INITIAL_EDITORS, { type: 'open-draft', tabId: 1, draft: draft() })
    const continued = only(state, 1, replyA)
    state = run(state,
      { type: 'retarget', editorId: continued.id, target: replyB },
      { type: 'open', tabId: 1, target: replyA, identity: byDefault('2') }
    )
    const other = only(state, 1, replyA)
    state = run(state, { type: 'edit', editorId: other.id, patch: { content: '另一份' } }, { type: 'discard', editorId: continued.id })

    expect(state.editors.filter((editor) => editor.tabId === 1 && editor.target.kind === 'reply' && editor.target.threadId === replyA.threadId))
      .toHaveLength(1)
    expect(only(state, 1, replyA)).toMatchObject({ id: other.id, fields: { content: '另一份' } })
    // The saved version is untouched in the library; continuing it again is possible from there.
    expect(editorForDraft(state, '7')).toBeNull()
    expect(editorFor(state, 1, replyB)).toBeNull()
  })

  it('a new editor needs saving once it has text or an image, not for identity or target alone', () => {
    let state = run(INITIAL_EDITORS, { type: 'open', tabId: 1, target: replyA, identity: byDefault('1') })
    const editor = only(state, 1, replyA)
    state = run(state, { type: 'set-identity', editorId: editor.id, credentialId: '2' }, { type: 'edit', editorId: editor.id, patch: { watermark: true } })
    expect(isUnsaved(only(state, 1, replyA))).toBe(false)
    state = run(state, { type: 'edit', editorId: editor.id, patch: { email: 'sage' } })
    expect(isUnsaved(only(state, 1, replyA))).toBe(true)
  })

  it('edits made while a save was in flight stay unsaved after it completes', () => {
    let state = run(INITIAL_EDITORS, { type: 'open', tabId: 1, target: replyA, identity: byDefault('1') })
    const editor = only(state, 1, replyA)
    state = run(state, { type: 'edit', editorId: editor.id, patch: { content: '第一版' } })
    const sent = saveInput(only(state, 1, replyA))
    expect(sent).toMatchObject({ draftId: null, target: replyA, credentialId: '1', attachmentId: null, fields: { content: '第一版' } })
    state = run(state,
      { type: 'edit', editorId: editor.id, patch: { content: '第一版又改' } },
      { type: 'saved', editorId: editor.id, draft: draft({ fields: sent.fields, credentialId: '1' }) }
    )
    expect(isUnsaved(only(state, 1, replyA))).toBe(true)
    expect(saveInput(only(state, 1, replyA)).draftId).toBe('7')
  })

  it('collects every unsaved editor of the closing tab, including hidden ones, and drops only that tab', () => {
    let state = run(INITIAL_EDITORS,
      { type: 'open', tabId: 1, target: replyA, identity: byDefault('1') },
      { type: 'open', tabId: 1, target: replyB, identity: byDefault('1') },
      { type: 'open-draft', tabId: 1, draft: draft({ target: newThread }) },
      { type: 'open', tabId: 2, target: replyA, identity: byDefault('1') }
    )
    state = run(state,
      { type: 'edit', editorId: only(state, 1, replyA).id, patch: { content: '收起的 A' } },
      { type: 'edit', editorId: only(state, 2, replyA).id, patch: { content: '另一标签' } }
    )
    expect(unsavedInTab(state, 1).map((editor) => editor.target)).toEqual([replyA])
    state = run(state, { type: 'close-tab', tabId: 1 })
    expect(state.editors.map((editor) => editor.tabId)).toEqual([2])
    expect(only(state, 2, replyA).fields.content).toBe('另一标签')
  })
})
