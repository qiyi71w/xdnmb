import type { ReadingMode, ThreadCoverage } from '../../../../shared/forum'
import { formatPageList } from '../../lib/format'

/** “第 3 页” or “只看 PO 第 3 页”: PO page numbers are not the pages of 全部. */
export function pageLabel(mode: ReadingMode, pages: string | number): string {
  return mode === 'po' ? `只看 PO 第 ${pages} 页` : `第 ${pages} 页`
}

/**
 * What has actually been observed for this thread in the mode being read. ReplyCount is never
 * shown as completeness; PO pages are labelled as PO pages.
 */
export function CoverageLine({ coverage, mode }: { coverage: ThreadCoverage | null; mode: ReadingMode }) {
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
      <span>已取得{pageLabel(mode, pages.length > 0 ? formatPageList(pages) : '—')}</span>
      {coverage.gaps.length > 0 && <span className="coverage-gap">缺页：{pageLabel(mode, formatPageList(coverage.gaps))}</span>}
      {coverage.endCandidatePage !== null && <span>末尾候选：{pageLabel(mode, coverage.endCandidatePage)}</span>}
      <span>{counts}</span>
    </p>
  )
}
