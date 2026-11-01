// What usage statistics are for and what they send. The first-run question and 设置 › 系统 ›
// 使用统计 show the same text; it must match the public user notes (docs/analytics-service.md) and what the main
// process actually sends.

import './analytics.css'

export const ANALYTICS_PURPOSE = '帮作者了解汐岛的大致使用人数，以及各版本和系统的占比。'

/** The data sent, and the most likely worries about what is not. */
export function AnalyticsSentData() {
  return (
    <>
      <p>每天第一次在前台使用汐岛时发送：</p>
      <ul>
        <li>随机生成的统计标识和凭证，与饼干、账号和设备无关</li>
        <li>汐岛版本号</li>
        <li>系统：Windows 或 macOS</li>
      </ul>
      <p>不发送饼干、串号、浏览或发言内容，也不发送使用时长。</p>
    </>
  )
}

/** Purpose and data sent, as one list (设置). */
export function AnalyticsDisclosure() {
  return (
    <dl className="analytics-disclosure">
      <dt>用途</dt>
      <dd>{ANALYTICS_PURPOSE}</dd>
      <dt>发送什么</dt>
      <dd>
        <AnalyticsSentData />
      </dd>
    </dl>
  )
}
