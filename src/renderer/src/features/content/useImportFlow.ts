import { useSyncExternalStore } from 'react'
import { canConfirm, importBusy, importFlowReducer, type ImportFlow, type ImportFlowEvent } from './importState'

/*
 * The window's one import flow. It lives outside React so that leaving the 设置 tab while a file is
 * checked keeps it; every request goes to the main process at most once per step.
 */

let flow: ImportFlow = { phase: 'idle' }
const listeners = new Set<() => void>()

function dispatch(event: ImportFlowEvent): void {
  const next = importFlowReducer(flow, event)
  if (next === flow) return
  flow = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useImportFlow(): ImportFlow {
  return useSyncExternalStore(subscribe, () => flow)
}

export const importFlow = {
  dispatch,
  /** Open dialog and file check. Ignored while a file is checked or confirmed. */
  async inspect(): Promise<void> {
    if (importBusy(flow)) return
    dispatch({ type: 'inspect' })
    const result = await window.xidao.personalData.inspectImport().catch(() => null)
    dispatch({ type: 'inspected', result })
  },
  /** 导入并重新启动; repeated presses while it runs do nothing. */
  async confirm(): Promise<void> {
    if (!canConfirm(flow)) return
    dispatch({ type: 'confirm' })
    const result = await window.xidao.personalData.confirmImport().catch(() => null)
    dispatch({ type: 'confirmed', result })
  },
  /** Gives up the file (while checking, or in the confirmation unless 导入并重新启动 runs). */
  async cancel(): Promise<void> {
    const wasChecked = flow.phase === 'confirming' && !flow.busy && flow.outcome === null
    const checking = flow.phase === 'inspecting' && !flow.cancelling
    dispatch({ type: 'cancel' })
    // After a failed or blocked import, nothing is staged any more.
    if (checking || wasChecked) await window.xidao.personalData.cancelImport().catch(() => undefined)
  }
}
