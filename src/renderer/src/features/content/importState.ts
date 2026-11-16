import type {
  ImportBlock, ImportConfirmResult, ImportFailure, ImportInspection, ImportRejection, ImportSummary
} from '../../../../shared/api'

/*
 * 导入个人数据 as the renderer sees it: one flow for the window (it outlives the 设置 tab), from the
 * open dialog and the file check to the confirmation and its outcome. Pure; `useImportFlow` holds
 * the state.
 */

/** Why a confirmed import did not happen; the data is unchanged either way. */
export type ImportOutcome = { kind: 'failed' } | { kind: 'blocked'; reason: ImportBlock }

export type ImportFlow =
  | { phase: 'idle' }
  /** 导入个人数据… pressed: the open dialog, then the file check. */
  | { phase: 'inspecting'; cancelling: boolean }
  /**
   * 输入导出口令: the file is encrypted. `wrong`: the last passphrase was not the file's (any number
   * of tries). `busy`: one is being tried, then the rest of the check runs.
   */
  | { phase: 'locked'; wrong: boolean; busy: boolean; cancelling: boolean }
  /** The file was refused or could not be checked. */
  | { phase: 'refused'; problem: { rejection: ImportRejection } | { failure: ImportFailure } }
  /** The confirmation. `busy`: 导入并重新启动 is running (the quit takes over once prepared). */
  | { phase: 'confirming'; summary: ImportSummary; busy: boolean; outcome: ImportOutcome | null }

export type ImportFlowEvent =
  | { type: 'inspect' }
  /** `null`: the request itself failed. */
  | { type: 'inspected'; result: ImportInspection | null }
  /** 继续 in 输入导出口令. */
  | { type: 'submit' }
  /** `null`: the request itself failed. */
  | { type: 'submitted'; result: ImportInspection | null }
  /** 取消 or Esc in the confirmation or 输入导出口令, or 取消 while the file is checked. */
  | { type: 'cancel' }
  | { type: 'confirm' }
  | { type: 'confirmed'; result: ImportConfirmResult | null }
  /** A refusal was seen and is put away (settings left, a new import). */
  | { type: 'dismiss' }

const IDLE: ImportFlow = { phase: 'idle' }

/** Whether a press of 导入个人数据… is ignored now. */
export function importBusy(flow: ImportFlow): boolean {
  return flow.phase === 'inspecting' || flow.phase === 'locked' || flow.phase === 'confirming'
}

/** Whether 导入并重新启动 can run: once per checked file, never after it failed or was blocked. */
export function canConfirm(flow: ImportFlow): boolean {
  return flow.phase === 'confirming' && !flow.busy && flow.outcome === null
}

/** Whether 继续 can try `passphrase`: a non-empty one, while none is being tried. */
export function canSubmit(flow: ImportFlow, passphrase: string): boolean {
  return flow.phase === 'locked' && !flow.busy && !flow.cancelling && passphrase.length > 0
}

/** Where a check's answer leads; `null`: the request itself failed. */
function checked(result: ImportInspection | null): ImportFlow {
  if (result === null) return { phase: 'refused', problem: { failure: { reason: 'read' } } }
  switch (result.status) {
    case 'dismissed': return IDLE
    case 'passphrase': return { phase: 'locked', wrong: result.wrong, busy: false, cancelling: false }
    case 'ready': return { phase: 'confirming', summary: result.summary, busy: false, outcome: null }
    case 'rejected': return { phase: 'refused', problem: { rejection: result.rejection } }
    case 'failed': return { phase: 'refused', problem: { failure: result.failure } }
  }
}

export function importFlowReducer(flow: ImportFlow, event: ImportFlowEvent): ImportFlow {
  switch (event.type) {
    case 'inspect':
      return importBusy(flow) ? flow : { phase: 'inspecting', cancelling: false }
    case 'inspected':
      // A check that ends after 取消 gives the file up whatever it found.
      if (flow.phase !== 'inspecting') return flow
      return flow.cancelling ? IDLE : checked(event.result)
    case 'submit':
      return flow.phase === 'locked' && !flow.busy && !flow.cancelling ? { ...flow, busy: true } : flow
    case 'submitted':
      // A try that ends after 取消 gives the file up whatever it found.
      if (flow.phase !== 'locked' || !flow.busy) return flow
      return flow.cancelling ? IDLE : checked(event.result)
    case 'cancel':
      if (flow.phase === 'inspecting') return flow.cancelling ? flow : { ...flow, cancelling: true }
      if (flow.phase === 'locked') return flow.busy ? { ...flow, cancelling: true } : IDLE
      return flow.phase === 'confirming' && !flow.busy ? IDLE : flow
    case 'confirm':
      return canConfirm(flow) && flow.phase === 'confirming' ? { ...flow, busy: true } : flow
    case 'confirmed': {
      if (flow.phase !== 'confirming' || !flow.busy) return flow
      const result = event.result
      // The quit takes over; the window closes with the dialog still busy.
      if (result?.status === 'restarting') return flow
      return { ...flow, busy: false, outcome: result?.status === 'blocked' ? { kind: 'blocked', reason: result.reason } : { kind: 'failed' } }
    }
    case 'dismiss':
      return flow.phase === 'refused' ? IDLE : flow
  }
}

export function importRejectionText(rejection: ImportRejection): string {
  switch (rejection.reason) {
    case 'not-export': return '这不是汐岛导出的文件'
    case 'newer': return `此文件来自汐岛 ${rejection.appVersion}，请先升级到该版本或更高版本`
    case 'corrupt': return '文件已损坏或不完整'
    case 'protection': return '文件含饼干，但本机无法安全保存，不能导入'
  }
}

export function importFailureText(failure: ImportFailure): string {
  switch (failure.reason) {
    case 'storage': return '导入失败：存储当前不能写入'
    case 'busy': return '导入失败：已有导入正在进行'
    case 'read': return '导入失败：读取文件或本机数据时出错'
    case 'space': return '导入失败：磁盘空间不足'
  }
}

export function importProblemText(problem: Extract<ImportFlow, { phase: 'refused' }>['problem']): string {
  return 'rejection' in problem ? importRejectionText(problem.rejection) : importFailureText(problem.failure)
}

/** Why a confirmed import did not happen, ending with the data unchanged. */
export function importOutcomeText(outcome: ImportOutcome): string {
  if (outcome.kind === 'failed') return '没能准备导入，数据没有改动。'
  switch (outcome.reason) {
    case 'unchecked': return '没有导入：有发送的状态无法确认，数据没有改动。'
    case 'drafts': return '没有导入：有草稿没能保存，数据没有改动。'
    case 'workspace': return '没有导入：工作区没能保存，数据没有改动。'
    case 'other': return '没有导入：汐岛没有重新启动，数据没有改动。'
  }
}

/** What the file contains, as the confirmation lists it. */
export function importCategoriesText(summary: ImportSummary): string {
  const records = summary.offlineThreads > 0
    ? `浏览历史、阅读位置、草稿、发送记录、屏蔽、饼干颜色、提醒、设置和离线副本（${summary.offlineThreads} 个串）`
    : '浏览历史、阅读位置、草稿、发送记录、屏蔽、饼干颜色、提醒和设置'
  return summary.secrets ? `${records}，以及饼干与 App UUID` : records
}

/** The confirmation's body; `exportedAt` already formatted for display. */
export function importConfirmText(summary: ImportSummary, exportedAt: string): string {
  return `文件导出于 ${exportedAt}，来自汐岛 ${summary.appVersion}，包含${importCategoriesText(summary)}。` +
    `导入后，本机的浏览历史（${summary.local.history} 条）、发送记录（${summary.local.sendRecords} 条）和其他个人数据、设置将被替换；` +
    '本机的饼干、App UUID、官网登录、离线副本和草稿会保留。'
}
