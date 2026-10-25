export const REPORT_REASONS = ['黄赌毒', '政治敏感', '谣言欺诈', '广告q群', '引战辱骂', '串版', '错字自删', '错饼自删', '其他'] as const
export interface ReportFields { postId: string; reason: string; customReason: string; text: string }
export function reportReason(report: ReportFields): string | null {
  if (!REPORT_REASONS.some((reason) => reason === report.reason)) return null
  const reason = report.reason === '其他' ? report.customReason.trim() : report.reason
  return reason.length > 0 && reason.length <= 80 && !/[\r\n]/.test(reason) ? reason : null
}
export function reportContent(report: ReportFields): string | null {
  return reportReason(report) === null ? null : reportDraftContent(report)
}

/** Drafts retain an unfinished reason too; only reportContent may authorize a send. */
export function reportDraftContent(report: ReportFields): string {
  const reason = report.reason === '其他' ? report.customReason.trim() : report.reason
  return `举报理由：${reason}\n>>No.${report.postId}${report.text.trimEnd() === '' ? '' : `\n${report.text.trimEnd()}`}`
}

export function parseReportContent(content: string): ReportFields | undefined {
  const match = /^举报理由：([^\r\n]*)\n>>No\.(\d+)(?:\n([\s\S]*))?$/.exec(content)
  if (match === null) return undefined
  const reason = match[1]!
  const preset = reason === '' || REPORT_REASONS.some((item) => item !== '其他' && item === reason)
  return { postId: match[2]!, reason: preset ? reason : '其他', customReason: preset ? '' : reason, text: match[3] ?? '' }
}
