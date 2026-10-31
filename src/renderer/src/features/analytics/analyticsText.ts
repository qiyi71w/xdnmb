import type { AnalyticsChoiceResult, AnalyticsDeletionFailure, AnalyticsState } from '../../../../shared/analytics'

/** Why a statistics choice did not stick, and what this run does now. `null`: the request itself failed. */
export function choiceFailureText(choice: 'on' | 'off', result: AnalyticsChoiceResult | null): string {
  if (result?.result === 'refused') {
    switch (result.reason) {
      case 'deletion-pending':
        return '还有未完成的统计记录删除，先完成删除才能开启'
      case 'protection-unavailable':
        return '系统凭据保护不可用，无法安全保存统计凭证，统计保持关闭'
      case 'unavailable':
        return '现在无法更改统计选择'
    }
  }
  if (choice === 'on') return '没能保存开启，统计保持关闭'
  // A failed off still stopped this run; the next start reads what is on disk.
  if (result?.state.saved === 'on') return '本次运行已停止统计，但没能保存关闭，下次启动仍会开启'
  return '本次运行不会统计，但没能保存选择，下次启动会再次询问'
}

export function deletionFailureText(reason: AnalyticsDeletionFailure): string {
  switch (reason) {
    // No answer: the service may or may not have deleted; only a retry can confirm it.
    case 'network':
      return '没有收到统计服务的确认，删除还没有完成'
    case 'service':
      return '统计服务暂时无法处理，记录还没有删除'
    case 'rejected':
      return '统计服务没有接受本机的删除凭证，记录还没有删除'
    case 'protection-unavailable':
      return '系统凭据保护不可用，读不出删除凭证，记录还没有删除'
    case 'storage':
      return '没能在本机保存删除状态，记录还没有确认删除'
  }
}

/** Why statistics cannot be changed here; `null` while available. */
export function unavailableText(state: AnalyticsState): string | null {
  switch (state.availability) {
    case 'available':
      return null
    case 'unsupported-platform':
      return '使用统计只在 Windows 和 macOS 版本中提供，本机不会发送统计'
    case 'not-configured':
      return '这个版本没有配置统计服务，不会发送任何统计'
    case 'storage-unavailable':
      return '本机数据库只读或无法打开，无法保存统计选择；本次运行不会发送统计'
  }
}
