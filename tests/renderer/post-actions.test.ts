import { describe, expect, it } from 'vitest'
import { REPORT_REASONS, parseReportContent, reportContent, reportDraftContent, reportReason, type ReportFields } from '../../src/shared/report'
import { isPostBlocked, type LocalBlock } from '../../src/shared/blocks'
import { editorFor, editorsReducer, INITIAL_EDITORS, saveInput } from '../../src/renderer/src/features/editor/editorsState'
import { EMPTY_FIELDS, type IdentityChoice, type SavedDraft } from '../../src/shared/drafts'

const identity: IdentityChoice = { source: 'default', selection: { state: 'selected', credentialId: '7' } }
const report: ReportFields = { postId: '123456', reason: '', customReason: '', text: '' }

describe('report form content', () => {
  it('requires a known reason and a nonempty single-line custom reason', () => {
    expect(reportReason(report)).toBeNull()
    expect(reportContent(report)).toBeNull()
    expect(reportContent({ ...report, reason: '伪造理由' })).toBeNull()
    expect(reportContent({ ...report, reason: '其他', customReason: '  ' })).toBeNull()
    expect(reportContent({ ...report, reason: '其他', customReason: '一\n二' })).toBeNull()
    expect(reportContent({ ...report, reason: '其他', customReason: 'a'.repeat(81) })).toBeNull()
    expect(reportContent({ ...report, reason: '其他', customReason: '  其他问题  ' })).toBe('举报理由：其他问题\n>>No.123456')
  })

  it.each(REPORT_REASONS.filter((reason) => reason !== '其他'))('formats %s with the target quote and user text', (reason) => {
    expect(reportContent({ ...report, reason, text: '补充说明\n第二行\n  ' })).toBe(`举报理由：${reason}\n>>No.123456\n补充说明\n第二行`)
    expect(reportContent({ ...report, reason, text: ' \n ' })).toBe(`举报理由：${reason}\n>>No.123456`)
  })

  it('roundtrips unfinished and custom reasons through ordinary saved content', () => {
    for (const fields of [report, { ...report, reason: '其他', customReason: '自定义问题', text: '说明' }]) {
      expect(parseReportContent(reportDraftContent(fields))).toEqual(fields)
    }
    expect(parseReportContent('普通正文')).toBeUndefined()
  })
})

describe('post actions editor transitions', () => {
  it('opens a reply with a quote, preserving the current editor and identity', () => {
    const target = { kind: 'reply' as const, threadId: '100' }
    let state = editorsReducer(INITIAL_EDITORS, { type: 'open-quote', tabId: 1, target, identity, postId: '101' })
    let editor = editorFor(state, 1, target)!
    expect(editor.fields.content).toBe('>>No.101\n')
    state = editorsReducer(state, { type: 'edit', editorId: editor.id, patch: { content: '已有文字' } })
    state = editorsReducer(state, { type: 'open-quote', tabId: 1, target, identity: { source: 'unknown' }, postId: '100' })
    editor = editorFor(state, 1, target)!
    expect(editor.fields.content).toBe('已有文字\n>>No.100\n')
    expect(editor.credentialId).toBe('7')
    expect(state.editors).toHaveLength(1)
    expect(editor.publication).toBeNull()
  })

  it('prepares a report as an ordinary new-thread publication in fid 18, without starting a send', () => {
    let state = editorsReducer(INITIAL_EDITORS, { type: 'open-report', tabId: 1, identity, postId: '123456' })
    const target = { kind: 'thread' as const, forumId: '18' }
    let editor = editorFor(state, 1, target)!
    expect(editor.report?.reason).toBe('')
    expect(editor.publication).toBeNull()
    state = editorsReducer(state, { type: 'edit-report', editorId: editor.id, patch: { reason: '广告q群', text: '链接刷屏\n' } })
    editor = editorFor(state, 1, target)!
    expect(saveInput(editor)).toMatchObject({ target, credentialId: '7', fields: { content: '举报理由：广告q群\n>>No.123456\n链接刷屏' } })
    expect(editor.publication).toBeNull()
  })

  it('resumes and discards a report using the saved reason and text', () => {
    const fields = { ...report, reason: '串版', text: '已保存的说明' }
    const draft: SavedDraft = { id: '77', version: 1, createdAt: '2026-10-25T00:00:00Z', savedAt: '2026-10-25T00:00:00Z', target: { kind: 'thread', forumId: '18' }, credentialId: '7', attachment: null, fields: { ...EMPTY_FIELDS, content: reportDraftContent(fields) } }
    let state = editorsReducer(INITIAL_EDITORS, { type: 'open-draft', tabId: 1, draft })
    const editor = editorFor(state, 1, draft.target)!
    expect(editor.report).toEqual(fields)
    state = editorsReducer(state, { type: 'edit-report', editorId: editor.id, patch: { text: '未保存' } })
    state = editorsReducer(state, { type: 'discard', editorId: editor.id })
    expect(editorFor(state, 1, draft.target)?.report).toEqual(fields)
  })

  it('never changes the payload of a sending reply or report', () => {
    const target = { kind: 'thread' as const, forumId: '18' }
    let state = editorsReducer(INITIAL_EDITORS, { type: 'open-report', tabId: 1, identity, postId: '123456' })
    const editor = editorFor(state, 1, target)!
    state = editorsReducer(state, { type: 'publish-start', editorId: editor.id, requestId: 'synthetic-send' })
    const locked = editorFor(state, 1, target)!
    state = editorsReducer(state, { type: 'edit-report', editorId: editor.id, patch: { reason: '串版' } })
    state = editorsReducer(state, { type: 'open-report', tabId: 1, identity, postId: '999' })
    expect(editorFor(state, 1, target)).toEqual(locked)
  })
})

describe('local block matching', () => {
  const blocks: LocalBlock[] = [
    { kind: 'post', value: '101', createdAt: '2026-10-25T00:00:00Z' },
    { kind: 'cookie', value: 'cookie-a', createdAt: '2026-10-25T00:00:00Z' }
  ]
  it('matches only the exact number or public cookie, including head posts', () => {
    expect(isPostBlocked({ id: '101', userHash: null }, blocks)).toBe(true)
    expect(isPostBlocked({ id: '100', userHash: 'cookie-a' }, blocks)).toBe(true)
    expect(isPostBlocked({ id: '102', userHash: null }, blocks)).toBe(false)
    expect(isPostBlocked({ id: '102', userHash: 'cookie-b' }, blocks)).toBe(false)
    const heads = [{ id: '100', userHash: 'cookie-a' }, { id: '101', userHash: null }, { id: '102', userHash: 'cookie-b' }]
    expect(heads.filter((post) => !isPostBlocked(post, blocks))).toEqual([heads[2]])
    expect(heads.filter((post) => !isPostBlocked(post, []))).toEqual(heads)
  })
})
