import type { AnnouncementState } from '../../../../shared/announcements'

export interface StatusLine {
  tone: 'info' | 'warning'
  text: string
}

/**
 * What 设置 › 公告 says about the shown announcement: whether it was obtained by this run's latest
 * read or is the copy kept from an earlier read (and why), or why there is none. `time` formats
 * the stored ISO time of the read that obtained it.
 */
export function announcementStatus(state: AnnouncementState, time: (iso: string) => string): StatusLine[] {
  const latest = state.latest
  if (latest === null) {
    switch (state.outcome) {
      case 'network-error':
        return [{ tone: 'warning', text: '读取公告失败' }]
      case 'invalid':
        return [{ tone: 'warning', text: '取得的公告内容无法识别' }]
      case 'disabled':
        return [{ tone: 'info', text: '目前没有启用的公告' }]
      case 'ready':
      case 'not-fetched':
        return [{ tone: 'info', text: '尚未取得公告' }]
    }
  }
  const at = time(latest.fetchedAt)
  const lines: StatusLine[] = []
  if (state.source === 'current') {
    lines.push({ tone: 'info', text: latest.enable ? `${at} 取得` : `${at} 取得，这条公告目前未启用` })
    if (!state.saved) lines.push({ tone: 'warning', text: '没能保存到本机，重启后要重新取得' })
    return lines
  }
  switch (state.outcome) {
    case 'network-error':
      lines.push({ tone: 'warning', text: `最近一次读取失败，下面是 ${at} 取得的公告` })
      break
    case 'invalid':
      lines.push({ tone: 'warning', text: `最近一次取得的内容无法识别，下面是 ${at} 取得的公告` })
      break
    case 'disabled':
      lines.push({ tone: 'info', text: `公告目前未启用，下面是 ${at} 取得的公告` })
      break
    case 'ready':
    case 'not-fetched':
      lines.push({ tone: 'info', text: `下面是 ${at} 取得的公告` })
  }
  return lines
}
