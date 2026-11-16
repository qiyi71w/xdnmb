import { describe, expect, it } from 'vitest'
import {
  exportFailureText, exportPercent, exportProgressText, exportTaskReducer, offlineChoiceText, unavailableText,
  type ExportTask, type ExportTaskEvent
} from '../../src/renderer/src/features/content/exportState'

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
  })
})
