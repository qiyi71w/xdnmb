// What usage statistics send, to whom, for how long, and what they cannot promise. The same text
// is the first-run question and the explanation in 设置 › 系统 › 使用统计; it must match the public
// privacy notes (README) and what the main process actually sends.

import './analytics.css'

export function AnalyticsDisclosure({ receiver, id }: { receiver: string | null; id?: string }) {
  return (
    <dl className="analytics-disclosure" id={id}>
      <dt>用途</dt>
      <dd>帮作者了解大约有多少安装在使用汐岛，以及各版本和系统的占比。</dd>
      <dt>发送什么</dt>
      <dd>
        <p>每个北京时间自然日里，第一次在前台使用汐岛（窗口有焦点、未最小化、屏幕未锁定）时发送一次：</p>
        <ul>
          <li>开启时随机生成的统计标识，与饼干、账号和设备信息无关</li>
          <li>汐岛版本号</li>
          <li>系统：Windows 或 macOS</li>
        </ul>
        <p>不发送饼干、串号、阅读／搜索／发言内容，也不发送使用时长或具体时间。</p>
      </dd>
      <dt>发给谁</dt>
      <dd>汐岛作者在甲骨文云上运营的统计服务{receiver !== null && <>（{receiver}）</>}。</dd>
      <dt>保留多久</dt>
      <dd>与统计标识关联的每日记录保留 31 天；不含标识的每日汇总保留 12 个月。</dd>
      <dt>隐私边界</dt>
      <dd>
        统计标识会把同一安装不同日期的使用关联起来，所以不是完全匿名。连接时，统计服务和网络运营方能看到你的 IP
        地址；服务不把 IP 存进统计数据，也不用它识别你。统计结果是参与统计的安装数，不是准确的人数。
      </dd>
      <dt>以后更改</dt>
      <dd>在“设置 › 系统 › 使用统计”中随时关闭（只停止以后的发送），或删除仍与本机标识关联的记录。</dd>
    </dl>
  )
}
