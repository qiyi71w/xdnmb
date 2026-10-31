// What usage statistics are for, what they send, to whom, for how long, and what they cannot
// promise. The first-run question leads with the purpose and the data and keeps the rest one click
// away; 设置 › 系统 › 使用统计 shows everything. All of it must match the public privacy notes
// (README) and what the main process actually sends.

import './analytics.css'

export const ANALYTICS_PURPOSE = '帮作者了解大约有多少安装在使用汐岛，以及各版本和系统的占比。'

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

/** Receiver, counting, retention, privacy limits and how to change the choice: `dt`/`dd` pairs. */
export function AnalyticsTerms({ receiver }: { receiver: string | null }) {
  return (
    <>
      <dt>发给谁</dt>
      <dd>汐岛作者在甲骨文云上运营的统计服务{receiver !== null && <>（{receiver}）</>}。</dd>
      <dt>怎样算一天</dt>
      <dd>按北京时间自然日，窗口有焦点、未最小化且屏幕未锁定时才算使用；只在后台驻留不算。</dd>
      <dt>保留多久</dt>
      <dd>与统计标识关联的每日记录保留 31 天；不含标识的每日汇总保留 12 个月。</dd>
      <dt>隐私边界</dt>
      <dd>
        统计标识会把同一安装不同日期的使用关联起来，所以不是完全匿名。连接时，统计服务和网络运营方能看到你的 IP
        地址；服务不把 IP 存进统计数据，也不用它识别你。统计结果是参与统计的安装数，不是准确的人数。
      </dd>
      <dt>以后更改</dt>
      <dd>在“设置 › 系统 › 使用统计”中随时关闭（只停止以后的发送），或删除仍与本机标识关联的记录。</dd>
    </>
  )
}

/** Everything, as one list (设置). */
export function AnalyticsDisclosure({ receiver }: { receiver: string | null }) {
  return (
    <dl className="analytics-disclosure">
      <dt>用途</dt>
      <dd>{ANALYTICS_PURPOSE}</dd>
      <dt>发送什么</dt>
      <dd>
        <AnalyticsSentData />
      </dd>
      <AnalyticsTerms receiver={receiver} />
    </dl>
  )
}
