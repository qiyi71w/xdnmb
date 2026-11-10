import type { AnalyticsState } from '../../../../shared/analytics'

/** Why statistics cannot be turned on here; `null` while available. */
export function unavailableText(state: AnalyticsState): string | null {
  switch (state.availability) {
    case 'available':
      return null
    case 'unsupported-platform':
      return '使用统计仅在 Windows 和 macOS 版本中提供'
    case 'not-configured':
      return '此版本未配置统计服务，不会发送统计'
    case 'storage-unavailable':
      return '本机数据库只读或无法打开，无法保存统计选择；本次运行不会发送统计'
  }
}
