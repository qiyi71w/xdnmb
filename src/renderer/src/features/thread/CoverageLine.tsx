import type { ThreadCoverage } from '../../../../shared/forum'
import { formatPageList } from '../../lib/format'

/** What has actually been observed for this thread. ReplyCount is never shown as completeness. */
export function CoverageLine({ coverage }: { coverage: ThreadCoverage | null }) {
  if (coverage === null) return <p className="coverage">尚未取得页面</p>
  const pages = coverage.pages.map((item) => item.page)
  const reported = coverage.reportedReplyCount
  const obtained = coverage.obtainedReplyCount

  let counts: string
  if (reported === null) counts = `服务端未提供回复计数，已取得 ${obtained} 条`
  else if (coverage.countMismatch === true) counts = `服务端计数 ${reported}，已取得 ${obtained}`
  else if (coverage.countMismatch === false) counts = `服务端计数 ${reported}，已取得 ${obtained}，两者一致`
  else counts = `覆盖不完整：服务端计数 ${reported}，已取得 ${obtained}`

  return (
    <p className="coverage">
      <span>已取得第 {pages.length > 0 ? formatPageList(pages) : '—'} 页</span>
      {coverage.gaps.length > 0 && <span className="coverage-gap">缺页：第 {formatPageList(coverage.gaps)} 页</span>}
      {coverage.endCandidatePage !== null && <span>末尾候选：第 {coverage.endCandidatePage} 页</span>}
      <span>{counts}</span>
    </p>
  )
}
