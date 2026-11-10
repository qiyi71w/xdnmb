// What each third-party service is for, who receives what, how long they keep it and the risk.
// The first-run disclosure, the later question and 设置 › 系统 › 第三方服务 show the same facts;
// they must match the public notes (docs/analytics-service.md for statistics) and what the main
// process actually sends. Plain text only: nothing here loads remote images or documents.

import type { ThirdPartyService } from '../../../../shared/third-party'
import { SEARCH_HOST, SEARCH_SERVICE } from '../search/onlineSearchText'
import './third-party.css'

/** One line saying what turning the service on does. */
export const SERVICE_PURPOSE: Record<ThirdPartyService, string> = {
  updates: '向 GitHub 检查汐岛新版本，按你的操作或设置下载安装包',
  search: `把搜索词发给 ${SEARCH_SERVICE}，在汐岛里显示论坛搜索结果`,
  analytics: '帮作者了解汐岛的大致使用人数，以及各版本和系统的占比'
}

/** The warning the first-run disclosure and 设置 lead with: 汐岛 itself and every service listed. */
export const THIRD_PARTY_WARNING =
  '汐岛和以下服务都不受 X 岛官方支持。这些服务会连接 X 岛以外的服务器，X 岛不保证其数据安全，也不对其中的数据泄露负责。'

/** The same warning in the question for one service. */
export const SERVICE_WARNING = '此服务会连接 X 岛以外的服务器，不受 X 岛官方支持。X 岛不保证其数据安全，也不对其中的数据泄露负责。'

export const STATS_HOST = 'xidao-stats.qiyi71w.com'

function UpdatesFacts() {
  return (
    <>
      <dt>接收方</dt>
      <dd>GitHub：github.com/qiyi71w/xdnmb 的发布页；安装包来自 objects.githubusercontent.com 或 release-assets.githubusercontent.com</dd>
      <dt>发送内容</dt>
      <dd>
        检查和下载所需的请求，带有一个随机生成、保存在本机的更新标识（与使用统计的标识不同），可关联同一安装的多次更新请求。GitHub 能看到你的 IP 地址和客户端信息；不含饼干或任何论坛身份
      </dd>
      <dt>保留</dt>
      <dd>由 GitHub 按其政策决定，汐岛无法控制或得知。更新说明和安装包留在本机，直到被新版本替换、安装或清理</dd>
      <dt>关闭后</dt>
      <dd>不检查也不下载更新；“自动检查更新”等设置保留，但不生效</dd>
    </>
  )
}

function SearchFacts() {
  return (
    <>
      <dt>接收方</dt>
      <dd>
        {SEARCH_SERVICE}（{SEARCH_HOST}），由第三方运营，会把查询交给它的上游搜索引擎
      </dd>
      <dt>发送内容</dt>
      <dd>你提交的搜索词或翻页标记、汐岛版本号；服务器能看到你的 IP 地址。不含饼干、官网登录或订阅 UUID</dd>
      <dt>保留</dt>
      <dd>由 {SEARCH_SERVICE} 和它的上游决定，汐岛无法得知或保证</dd>
      <dt>关闭后</dt>
      <dd>不再发出新的搜索请求，已取得的结果页仍可查看</dd>
    </>
  )
}

function AnalyticsFacts() {
  return (
    <>
      <dt>接收方</dt>
      <dd>汐岛作者运营的 {STATS_HOST}，HTTPS 直连</dd>
      <dt>发送内容</dt>
      <dd>
        每个北京时间自然日第一次在前台使用时，发送随机生成的统计标识和凭证、汐岛版本号、系统（Windows 或 macOS）。不含饼干、浏览、搜索或发言内容
      </dd>
      <dt>风险</dt>
      <dd>
        统计标识会关联同一安装在不同日期的使用，因此不是完全匿名。服务器能看到你的 IP 地址，但不存入统计数据，也不为统计请求记录访问日志；只有 TLS 握手就失败的连接，可能在服务器共享日志里留下 IP
      </dd>
      <dt>保留</dt>
      <dd>关联统计标识的记录 31 天，不含标识的每日汇总 12 个月。关闭只停止以后的发送，已发送的记录按保留期清除</dd>
    </>
  )
}

/** Recipient, data, retention and risk of one service, as a term list. */
export function ServiceFacts({ service, id }: { service: ThirdPartyService; id?: string }) {
  return (
    <dl className="third-party-facts" id={id}>
      {service === 'updates' && <UpdatesFacts />}
      {service === 'search' && <SearchFacts />}
      {service === 'analytics' && <AnalyticsFacts />}
    </dl>
  )
}
