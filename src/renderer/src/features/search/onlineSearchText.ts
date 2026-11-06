import { SEARCH_SITE_URL, type SearchError } from '../../../../shared/online-search'
import { formatClockTime } from '../../lib/time'

/** Name of the third-party search service, as users see it on its site. */
export const SEARCH_SERVICE = 'nmb-search'

/** Host of the service's fixed website, for saying where a query goes. */
export const SEARCH_HOST = new URL(SEARCH_SITE_URL).host

/**
 * Reason lines of a search failure. The service's own message is shown verbatim as text; a rate
 * limit gives its retry time when the service sent one. Nothing here offers an automatic retry.
 */
export function searchErrorLines(error: SearchError): { reason: string; details: string[] } {
  const service = SEARCH_SERVICE
  switch (error.kind) {
    case 'network':
      return { reason: error.detail === 'timeout' ? `${service} 20 秒内未响应` : `无法连接 ${service}`, details: [] }
    case 'rate-limited':
      return {
        reason: `${service} 限制了请求频率`,
        details: [error.retryAt === null ? '请稍后再试' : `可在 ${formatClockTime(new Date(error.retryAt).toISOString())} 后再试`]
      }
    case 'verification':
      return { reason: `${service} 要求验证后才能访问（HTTP ${error.httpStatus}），汐岛无法代为验证`, details: [] }
    case 'http-status':
      return { reason: `${service} 返回 HTTP ${error.httpStatus}`, details: [] }
    case 'service': {
      const details = [`服务消息：${error.serviceMessage}`]
      if (error.hint === 'rate-limited') details.push('请求过于频繁')
      if (error.hint === 'verification') details.push('服务要求人工验证')
      return { reason: `${service} 返回错误`, details }
    }
    case 'unknown-structure':
      return { reason: error.detail === 'redirect' ? `${service} 要求跳转到其他地址，已拒绝` : `${service} 返回了无法识别的内容`, details: [] }
  }
}
