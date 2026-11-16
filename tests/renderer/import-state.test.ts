import { describe, expect, it } from 'vitest'
import type { ImportSummary } from '../../src/shared/api'
import {
  canConfirm, canSubmit, importBusy, importConfirmText, importFlowReducer, importOutcomeText, importProblemText,
  type ImportFlow, type ImportFlowEvent
} from '../../src/renderer/src/features/content/importState'

const run = (events: ImportFlowEvent[], from: ImportFlow = { phase: 'idle' }) => events.reduce(importFlowReducer, from)
const summary: ImportSummary = { exportedAt: '2026-11-16T08:00:00.000Z', appVersion: '1.5.0', offlineThreads: 3, secrets: false, local: { history: 120, sendRecords: 7 } }
const ready: ImportFlowEvent = { type: 'inspected', result: { status: 'ready', summary } }

describe('import flow state', () => {
  it('checks once, then confirms with the file’s facts and what this machine keeps', () => {
    const checking = run([{ type: 'inspect' }])
    expect(checking).toEqual({ phase: 'inspecting', cancelling: false })
    expect(importBusy(checking)).toBe(true)
    // A repeated press while checking changes nothing.
    expect(importFlowReducer(checking, { type: 'inspect' })).toBe(checking)
    const confirming = importFlowReducer(checking, ready)
    expect(confirming).toEqual({ phase: 'confirming', summary, busy: false, outcome: null })
    expect(canConfirm(confirming)).toBe(true)
    expect(importConfirmText(summary, '2026-11-16 16:00:00')).toBe(
      '文件导出于 2026-11-16 16:00:00，来自汐岛 1.5.0，包含浏览历史、阅读位置、草稿、发送记录、屏蔽、饼干颜色、提醒、设置和离线副本（3 个串）。' +
      '导入后，本机的浏览历史（120 条）、发送记录（7 条）和其他个人数据、设置将被替换；本机的饼干、App UUID、官网登录、离线副本和草稿会保留。'
    )
    expect(importConfirmText({ ...summary, offlineThreads: 0 }, 't')).toContain('包含浏览历史、阅读位置、草稿、发送记录、屏蔽、饼干颜色、提醒和设置。')
  })

  it('a dismissed dialog or a cancelled check leaves nothing; a refused file says why', () => {
    expect(run([{ type: 'inspect' }, { type: 'inspected', result: { status: 'dismissed' } }])).toEqual({ phase: 'idle' })
    const cancelling = run([{ type: 'inspect' }, { type: 'cancel' }])
    expect(cancelling).toEqual({ phase: 'inspecting', cancelling: true })
    expect(importFlowReducer(cancelling, { type: 'inspected', result: { status: 'dismissed' } })).toEqual({ phase: 'idle' })

    const refused = (result: ImportFlowEvent) => {
      const flow = run([{ type: 'inspect' }, result])
      if (flow.phase !== 'refused') throw new Error(flow.phase)
      return importProblemText(flow.problem)
    }
    expect(refused({ type: 'inspected', result: { status: 'rejected', rejection: { reason: 'not-export' } } })).toBe('这不是汐岛导出的文件')
    expect(refused({ type: 'inspected', result: { status: 'rejected', rejection: { reason: 'newer', appVersion: '1.7.0' } } }))
      .toBe('此文件来自汐岛 1.7.0，请先升级到该版本或更高版本')
    expect(refused({ type: 'inspected', result: { status: 'rejected', rejection: { reason: 'corrupt' } } })).toBe('文件已损坏或不完整')
    expect(refused({ type: 'inspected', result: { status: 'failed', failure: { reason: 'space' } } })).toBe('导入失败：磁盘空间不足')
    expect(refused({ type: 'inspected', result: null })).toBe('导入失败：读取文件或本机数据时出错')
    // Put away when 设置 is left or a new import starts.
    const flow = run([{ type: 'inspect' }, { type: 'inspected', result: { status: 'rejected', rejection: { reason: 'corrupt' } } }, { type: 'dismiss' }])
    expect(flow).toEqual({ phase: 'idle' })
  })

  it('is busy while 导入并重新启动 runs: repeated presses and Esc do nothing, and the quit takes over', () => {
    const busy = run([{ type: 'inspect' }, ready, { type: 'confirm' }])
    expect(busy).toMatchObject({ phase: 'confirming', busy: true })
    expect(canConfirm(busy)).toBe(false)
    expect(importFlowReducer(busy, { type: 'confirm' })).toBe(busy)
    expect(importFlowReducer(busy, { type: 'cancel' })).toBe(busy)
    expect(importFlowReducer(busy, { type: 'confirmed', result: { status: 'restarting' } })).toBe(busy)
  })

  it('stays in the confirmation saying nothing changed when preparing fails or the quit is called off', () => {
    const failed = run([{ type: 'inspect' }, ready, { type: 'confirm' }, { type: 'confirmed', result: { status: 'failed' } }])
    expect(failed).toEqual({ phase: 'confirming', summary, busy: false, outcome: { kind: 'failed' } })
    expect(canConfirm(failed)).toBe(false)
    expect(importOutcomeText({ kind: 'failed' })).toBe('没能准备导入，数据没有改动。')
    expect(run([{ type: 'confirmed', result: null }], { phase: 'confirming', summary, busy: true, outcome: null })).toMatchObject({ outcome: { kind: 'failed' } })

    const blocked = run([{ type: 'inspect' }, ready, { type: 'confirm' }, { type: 'confirmed', result: { status: 'blocked', reason: 'unchecked' } }])
    expect(blocked).toMatchObject({ busy: false, outcome: { kind: 'blocked', reason: 'unchecked' } })
    expect(importOutcomeText({ kind: 'blocked', reason: 'unchecked' })).toBe('没有导入：有发送的状态无法确认，数据没有改动。')
    expect(importOutcomeText({ kind: 'blocked', reason: 'drafts' })).toBe('没有导入：有草稿没能保存，数据没有改动。')
    expect(importOutcomeText({ kind: 'blocked', reason: 'workspace' })).toBe('没有导入：工作区没能保存，数据没有改动。')
    expect(importOutcomeText({ kind: 'blocked', reason: 'other' })).toBe('没有导入：汐岛没有重新启动，数据没有改动。')
    // Closing it afterwards ends the flow.
    expect(importFlowReducer(blocked, { type: 'cancel' })).toEqual({ phase: 'idle' })
  })

  it('asks for the passphrase of an encrypted file, as many times as needed, then confirms', () => {
    const locked = run([{ type: 'inspect' }, { type: 'inspected', result: { status: 'passphrase', wrong: false } }])
    expect(locked).toEqual({ phase: 'locked', wrong: false, busy: false, cancelling: false })
    expect(importBusy(locked)).toBe(true)
    expect(importFlowReducer(locked, { type: 'inspect' })).toBe(locked)
    // 继续 needs something typed.
    expect(canSubmit(locked, '')).toBe(false)
    expect(canSubmit(locked, '口令')).toBe(true)

    const trying = importFlowReducer(locked, { type: 'submit' })
    expect(trying).toEqual({ phase: 'locked', wrong: false, busy: true, cancelling: false })
    expect(canSubmit(trying, '口令')).toBe(false)
    expect(importFlowReducer(trying, { type: 'submit' })).toBe(trying)
    // Wrong: stays in the dialog for another try, any number of times.
    let flow = importFlowReducer(trying, { type: 'submitted', result: { status: 'passphrase', wrong: true } })
    expect(flow).toEqual({ phase: 'locked', wrong: true, busy: false, cancelling: false })
    for (let attempt = 0; attempt < 3; attempt++) {
      flow = run([{ type: 'submit' }, { type: 'submitted', result: { status: 'passphrase', wrong: true } }], flow)
      expect(flow).toEqual({ phase: 'locked', wrong: true, busy: false, cancelling: false })
      expect(canSubmit(flow, '再试')).toBe(true)
    }
    const confirming = run([{ type: 'submit' }, { type: 'submitted', result: { status: 'ready', summary: { ...summary, secrets: true } } }], flow)
    expect(confirming).toMatchObject({ phase: 'confirming', busy: false, outcome: null })
    expect(importConfirmText({ ...summary, secrets: true }, 't')).toContain('设置和离线副本（3 个串），以及饼干与 App UUID。')
  })

  it('refuses a damaged file or one this machine cannot protect after or before the passphrase; 取消 gives it up', () => {
    const locked: ImportFlow = { phase: 'locked', wrong: true, busy: false, cancelling: false }
    const corrupt = run([{ type: 'submit' }, { type: 'submitted', result: { status: 'rejected', rejection: { reason: 'corrupt' } } }], locked)
    expect(corrupt.phase === 'refused' && importProblemText(corrupt.problem)).toBe('文件已损坏或不完整')
    expect(run([{ type: 'submit' }, { type: 'submitted', result: null }], locked)).toMatchObject({ phase: 'refused' })
    const unprotected = run([{ type: 'inspect' }, { type: 'inspected', result: { status: 'rejected', rejection: { reason: 'protection' } } }])
    expect(unprotected.phase === 'refused' && importProblemText(unprotected.problem)).toBe('文件含饼干，但本机无法安全保存，不能导入')

    // 取消 or Esc: right away when nothing is tried; while a try runs, it ends given up whatever it found.
    expect(importFlowReducer(locked, { type: 'cancel' })).toEqual({ phase: 'idle' })
    const cancelling = run([{ type: 'submit' }, { type: 'cancel' }], locked)
    expect(cancelling).toEqual({ phase: 'locked', wrong: true, busy: true, cancelling: true })
    expect(canSubmit(cancelling, '口令')).toBe(false)
    expect(importFlowReducer(cancelling, { type: 'submitted', result: { status: 'ready', summary } })).toEqual({ phase: 'idle' })
    expect(importFlowReducer(cancelling, { type: 'submitted', result: { status: 'dismissed' } })).toEqual({ phase: 'idle' })
  })
})
