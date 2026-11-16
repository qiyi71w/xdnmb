import { describe, expect, it, vi } from 'vitest'
import type { ExportEstimate, ExportProgress } from '../../src/shared/api'
import {
  clearedSecrets, editSecrets, EMPTY_PASSPHRASE_TEXT, exportFailureText, exportPassphrase, exportPercent, exportProgressText, exportTaskReducer,
  isBusy, NO_SECRETS, offlineChoiceText, secretsState, unavailableText, type ExportTask, type ExportTaskEvent, type SecretsChoice
} from '../../src/renderer/src/features/content/exportState'
import { exportTask } from '../../src/renderer/src/features/content/useExportTask'

const run = (events: ExportTaskEvent[], from: ExportTask = { phase: 'idle' }) => events.reduce(exportTaskReducer, from)
const running = (writtenBytes: number, totalBytes: number): ExportTaskEvent => ({ type: 'progress', progress: { status: 'running', writtenBytes, totalBytes } })

describe('export dialog state', () => {
  it('shows the offline choice with its size, and the reason when storage is not writable', () => {
    expect(offlineChoiceText({ threads: 3, bytes: 12_400_000 })).toBe('离线副本（3 个串，约 12.4 MB）')
    expect(unavailableText(null)).toBeNull()
    expect(unavailableText({ available: true, running: null, contents: null })).toBeNull()
    expect(unavailableText({ available: false, reason: 'read-only' })).toBe('当前数据库只读，不能导出或导入')
    expect(unavailableText({ available: false, reason: 'unavailable' })).toBe('存储不可用，不能导出或导入')
  })

  it('starts once, follows real progress and completes with the file name', () => {
    const starting = run([{ type: 'start' }])
    expect(starting).toEqual({ phase: 'starting' })
    // A repeated press while starting changes nothing.
    expect(exportTaskReducer(starting, { type: 'start' })).toBe(starting)
    const progressed = run([{ type: 'start-result', result: { status: 'started' } }, running(0, 0), running(400, 1000)], starting)
    expect(progressed).toEqual({ phase: 'running', writtenBytes: 400, totalBytes: 1000, cancelling: false })
    if (progressed.phase === 'running') {
      expect(exportProgressText(progressed)).toBe('正在导出 400 字节 / 1 KB')
      expect(exportPercent(progressed)).toBe(40)
      expect(exportProgressText({ ...progressed, totalBytes: 0 })).toBe('正在导出')
      expect(exportPercent({ ...progressed, totalBytes: 0 })).toBeNull()
    }
    expect(exportTaskReducer(progressed, { type: 'start' })).toBe(progressed)
    const done = exportTaskReducer(progressed, { type: 'progress', progress: { status: 'done', fileName: '汐岛个人数据-2026-11-16.xidao' } })
    expect(done).toEqual({ phase: 'done', fileName: '汐岛个人数据-2026-11-16.xidao' })
    // The start answer arriving after the events does not undo them.
    expect(exportTaskReducer(done, { type: 'start-result', result: { status: 'started' } })).toBe(done)
    expect(exportTaskReducer(done, { type: 'dismiss' })).toEqual({ phase: 'idle' })
  })

  it('cancels once and ends cancelled', () => {
    const cancelling = run([{ type: 'start' }, running(10, 100), { type: 'cancel' }])
    expect(cancelling).toMatchObject({ phase: 'running', cancelling: true })
    expect(exportTaskReducer(cancelling, { type: 'cancel' })).toBe(cancelling)
    // Progress keeps the cancel in flight.
    expect(exportTaskReducer(cancelling, running(20, 100))).toMatchObject({ cancelling: true, writtenBytes: 20 })
    expect(exportTaskReducer(cancelling, { type: 'progress', progress: { status: 'cancelled' } })).toEqual({ phase: 'cancelled' })
    expect(exportTaskReducer({ phase: 'idle' }, { type: 'cancel' })).toEqual({ phase: 'idle' })
  })

  it('reports failures before and after the start', () => {
    expect(run([{ type: 'start' }, { type: 'start-result', result: { status: 'dismissed' } }])).toEqual({ phase: 'idle' })
    const space = run([{ type: 'start' }, { type: 'start-result', result: { status: 'failed', failure: { reason: 'space', shortBytes: 2_500_000 } } }])
    expect(space).toEqual({ phase: 'failed', failure: { reason: 'space', shortBytes: 2_500_000 } })
    if (space.phase === 'failed') expect(exportFailureText(space.failure)).toBe('导出失败：磁盘空间不足，还需约 2.5 MB')
    expect(exportFailureText({ reason: 'sending' })).toBe('导出失败：有发言正在发送，完成后再导出')
    expect(exportFailureText({ reason: 'write' })).toBe('导出失败：无法写入所选位置')
    expect(run([{ type: 'start' }, { type: 'start-result', result: null }])).toEqual({ phase: 'failed', failure: { reason: 'read' } })
    const failed = run([{ type: 'start' }, running(5, 10), { type: 'progress', progress: { status: 'failed', failure: { reason: 'read' } } }])
    expect(failed).toEqual({ phase: 'failed', failure: { reason: 'read' } })
    // A failure is a finished export: 导出… may start again.
    expect(exportTaskReducer(failed, { type: 'start' })).toEqual({ phase: 'starting' })
  })

  it('takes up an export the main process runs and drops one that ended unseen', () => {
    const adopted = exportTaskReducer({ phase: 'idle' }, { type: 'sync', running: { status: 'running', writtenBytes: 3, totalBytes: 9 } })
    expect(adopted).toEqual({ phase: 'running', writtenBytes: 3, totalBytes: 9, cancelling: false })
    expect(exportTaskReducer(adopted, { type: 'sync', running: null })).toEqual({ phase: 'idle' })
    const done: ExportTask = { phase: 'done', fileName: 'a.xidao' }
    expect(exportTaskReducer(done, { type: 'sync', running: null })).toBe(done)
    expect(exportTaskReducer({ phase: 'starting' }, { type: 'sync', running: null })).toEqual({ phase: 'starting' })
    expect(exportTaskReducer({ phase: 'starting' }, { type: 'dismiss' })).toEqual({ phase: 'starting' })
    // 导出… refused because an export this window missed runs: its progress is taken up.
    const busy: ExportTask = { phase: 'failed', failure: { reason: 'busy' } }
    expect(exportTaskReducer(busy, { type: 'sync', running: { status: 'running', writtenBytes: 1, totalBytes: 9 } })).toMatchObject({ phase: 'running' })
  })

  it('keeps a finished outcome when a running report from before it arrives late', () => {
    const stale: ExportTaskEvent = { type: 'sync', running: { status: 'running', writtenBytes: 5, totalBytes: 10 } }
    const outcomes: ExportProgress[] = [
      { status: 'done', fileName: 'a.xidao' }, { status: 'cancelled' }, { status: 'failed', failure: { reason: 'write' } }
    ]
    for (const outcome of outcomes) {
      const ended = run([{ type: 'start' }, { type: 'start-result', result: { status: 'started' } }, running(5, 10), { type: 'progress', progress: outcome }])
      expect(isBusy(ended)).toBe(false)
      const after = exportTaskReducer(ended, stale)
      expect(after).toBe(ended)
      // The next export can start.
      expect(exportTaskReducer(after, { type: 'start' })).toEqual({ phase: 'starting' })
    }
  })

  it('drops an estimate asked for before an outcome this window then heard', async () => {
    const answers: Array<PromiseWithResolvers<ExportEstimate>> = []
    vi.stubGlobal('window', {
      xidao: {
        personalData: {
          exportEstimate: () => {
            const answer = Promise.withResolvers<ExportEstimate>()
            answers.push(answer)
            return answer.promise
          },
          startExport: async () => ({ status: 'started' })
        }
      }
    })
    try {
      expect(await exportTask.start({ includeOffline: false, passphrase: null })).toBe(true)
      exportTask.dispatch(running(5, 10))
      const asked = exportTask.estimate()
      exportTask.dispatch({ type: 'progress', progress: { status: 'done', fileName: 'a.xidao' } })
      // Leaving 设置 puts the outcome away before the old answer arrives.
      exportTask.dispatch({ type: 'dismiss' })
      const contents = { offline: null, totalBytes: 10 }
      answers[0]!.resolve({ available: true, running: { status: 'running', writtenBytes: 5, totalBytes: 10 }, contents })
      expect(await asked).toMatchObject({ available: true })
      // Not busy: the next export starts.
      expect(await exportTask.start({ includeOffline: false, passphrase: null })).toBe(true)
      exportTask.dispatch({ type: 'progress', progress: { status: 'cancelled' } })
      exportTask.dispatch({ type: 'dismiss' })
      // An estimate asked for after the last outcome is taken up as before: an export runs.
      const fresh = exportTask.estimate()
      answers[1]!.resolve({ available: true, running: { status: 'running', writtenBytes: 1, totalBytes: 10 }, contents })
      await fresh
      expect(await exportTask.start({ includeOffline: false, passphrase: null })).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('takes 饼干与 App UUID only with a non-empty passphrase typed the same twice', () => {
    // Off by default: no passphrase, nothing to check, the file is not encrypted.
    expect(NO_SECRETS.include).toBe(false)
    expect(secretsState(NO_SECRETS)).toEqual({ ready: true, mismatch: false, empty: false })
    expect(exportPassphrase({ ...NO_SECRETS, passphrase: 'left over' })).toBeNull()

    const checked = { ...NO_SECRETS, include: true }
    // Just ticked: 导出… is unavailable, with nothing to say yet.
    expect(secretsState(checked)).toEqual({ ready: false, mismatch: false, empty: false })
    expect(secretsState({ ...checked, passphrase: 'abc', edited: true })).toEqual({ ready: false, mismatch: false, empty: false })
    // Different: said beside the second field once it is typed.
    expect(secretsState({ ...checked, passphrase: 'abc', confirmation: 'abd', edited: true })).toEqual({ ready: false, mismatch: true, empty: false })
    expect(secretsState({ ...checked, passphrase: '', confirmation: 'abc', edited: true })).toEqual({ ready: false, mismatch: true, empty: true })
    // Any length or strength, as typed (no trimming).
    const long = '长'.repeat(10_000)
    for (const passphrase of ['1', ' ', long, ' 有空格 ']) {
      expect(secretsState({ include: true, passphrase, confirmation: passphrase, edited: true })).toEqual({ ready: true, mismatch: false, empty: false })
      expect(exportPassphrase({ include: true, passphrase, confirmation: passphrase, edited: true })).toBe(passphrase)
    }
    expect(secretsState({ ...checked, passphrase: 'a ', confirmation: 'a' }).ready).toBe(false)
    expect(exportFailureText({ reason: 'secrets' })).toBe('导出失败：本机的饼干或 App UUID 无法解密')
  })

  it('says an empty passphrase cannot be used once a field has been typed in, until it is filled', () => {
    expect(EMPTY_PASSPHRASE_TEXT).toBe('口令不能为空')
    const checked: SecretsChoice = { ...NO_SECRETS, include: true }
    // The pristine form right after ticking says nothing.
    expect(secretsState(checked).empty).toBe(false)
    // Typed, then cleared.
    const typed = editSecrets(checked, { passphrase: 'a' })
    expect(secretsState(typed)).toEqual({ ready: false, mismatch: false, empty: false })
    const cleared = editSecrets(typed, { passphrase: '' })
    expect(secretsState(cleared)).toEqual({ ready: false, mismatch: false, empty: true })
    // The second field typed while the first is empty.
    const second = editSecrets(checked, { confirmation: 'x' })
    expect(secretsState(second)).toMatchObject({ ready: false, empty: true })
    // Filled: the explanation goes; typed the same twice, 导出… is available.
    const filled = editSecrets(cleared, { passphrase: 'pass' })
    expect(secretsState(filled).empty).toBe(false)
    expect(secretsState(editSecrets(filled, { confirmation: 'pass' }))).toEqual({ ready: true, mismatch: false, empty: false })
    // Without secrets, nothing is checked; once the export has the passphrase, the fields start over.
    expect(secretsState({ ...cleared, include: false })).toEqual({ ready: true, mismatch: false, empty: false })
    expect(secretsState(clearedSecrets(filled))).toEqual({ ready: false, mismatch: false, empty: false })
  })
})
