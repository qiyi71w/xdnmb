import type { AccountFailure, AccountOverview } from '../../../../shared/account'
import {
  CREDENTIAL_NAME_MAX_LENGTH,
  IDENTITY_ROLES,
  IMPORT_INPUT_MAX_LENGTH,
  type CredentialId,
  type CredentialSource,
  type IdentityOverview,
  type IdentityRole,
  type ImportFailure,
  type ImportFormatError,
  type NameError
} from '../../../../shared/identity'

// None of the texts here ever include pasted input: only fixed copy and user-chosen names.

export const SOURCE_LABEL: Record<CredentialSource, string> = {
  export: '官网导出',
  raw: '原始 userhash'
}

export const ROLE_INFO: Record<IdentityRole, { label: string; noneLabel: string }> = {
  'default-post': { label: '默认发言饼干', noneLabel: '未设置' },
  'web-sync': { label: '网页同步对象', noneLabel: '未绑定' }
}

export const MISSING_SELECTION_TEXT = '已移除的饼干，需要重新选择'

/** Roles whose selection (current or missing) points at the credential. */
export function rolesUsing(overview: IdentityOverview, credentialId: CredentialId): IdentityRole[] {
  return IDENTITY_ROLES.filter((role) => {
    const selection = overview.roles[role]
    return selection.state !== 'none' && selection.credentialId === credentialId
  })
}

export function roleList(roles: readonly IdentityRole[]): string {
  return roles.map((role) => ROLE_INFO[role].label).join('、')
}

export type BrowseStatus = { state: 'none' } | { state: 'selected'; name: string }

/** Forum reads carry the first credential of the list; none only when the list is empty. */
export function browseStatus(overview: IdentityOverview): BrowseStatus {
  const first = overview.credentials[0]
  return first === undefined ? { state: 'none' } : { state: 'selected', name: first.name }
}

export function nameErrorText(error: NameError | 'required'): string {
  switch (error) {
    case 'empty':
    case 'required':
      return '请填写名称'
    case 'too-long':
      return `名称不能超过 ${CREDENTIAL_NAME_MAX_LENGTH} 个字符`
    case 'invalid':
      return '名称包含无法使用的字符'
  }
}

/** Local name check matching the stored rules: trimmed, 1–40 characters. */
export function checkName(name: string): NameError | null {
  const trimmed = name.trim()
  if (trimmed === '') return 'empty'
  if ([...trimmed].length > CREDENTIAL_NAME_MAX_LENGTH) return 'too-long'
  return null
}

export type ImportEntry = 'export' | 'raw'

/** Which field an import failure belongs to, for `aria-invalid`. */
export type FailureField = 'secret' | 'name' | null

export function importFailureText(failure: ImportFailure, entry: ImportEntry): { text: string; field: FailureField } {
  switch (failure.reason) {
    case 'format':
      return { text: formatErrorText(failure.detail, entry), field: 'secret' }
    case 'name':
      return {
        text:
          failure.detail === 'required' && entry === 'export' ? '导出内容中没有可用的名称，请填写名称' : nameErrorText(failure.detail),
        field: 'name'
      }
    case 'duplicate':
      return { text: `已有相同饼干「${failure.existing.name}」，未做任何更改`, field: null }
    case 'protection-unavailable':
      return { text: '系统凭据保护不可用，不会以明文保存，未导入', field: null }
    case 'decrypt-failed':
      return { text: '已有饼干无法解密，无法核对重复，请先处理', field: null }
    case 'storage':
      return { text: '本地存储不可写，未导入', field: null }
  }
}

function formatErrorText(detail: ImportFormatError, entry: ImportEntry): string {
  switch (detail) {
    case 'empty':
      return entry === 'export' ? '请先粘贴官网导出内容' : '请先粘贴 userhash'
    case 'too-long':
      return `内容过长（超过 ${IMPORT_INPUT_MAX_LENGTH} 个字符），请确认只粘贴了${entry === 'export' ? '导出内容' : ' userhash'}`
    case 'not-base64':
      return '格式无法识别：不是官网导出的 Base64 或 JSON 内容'
    case 'not-json':
      return '格式无法识别：Base64 解码后不是 JSON'
    case 'missing-cookie':
      return '导出内容中没有饼干（缺少 cookie）'
    case 'invalid-cookie':
      return entry === 'export'
        ? '导出内容中的饼干包含无法使用的字符'
        : 'userhash 包含无法使用的字符（如空格、分号或引号）'
  }
}

/** Why the official-site login cannot start; short, shown in place of the login button. */
export function accountBlockerText(blocker: AccountOverview['blocker']): string {
  switch (blocker) {
    case 'protection-unavailable':
      return '系统凭据保护不可用，不能登录官网'
    case 'storage':
      return '本地存储不可写，不能登录官网'
    case null:
      return '暂时不能登录官网'
  }
}

export function accountFailureText(reason: AccountFailure): string {
  switch (reason) {
    case 'protection-unavailable':
      return '系统凭据保护不可用，未保存登录'
    case 'storage':
      return '本地存储不可写，未完成'
    case 'expired':
      return '登录已过期，请重新登录'
    case 'cancelled':
      return '已取消登录'
    case 'network':
      return '无法连接官网，请重试'
    case 'rate-limited':
      return '官网请求过于频繁，请稍后再试'
    case 'unknown-structure':
      return '无法识别官网返回的页面，未读取或导入饼干'
    case 'blocked':
      return '官网拒绝了这次访问'
  }
}

/** One account cookie that was not stored (duplicates are reported separately). */
export function accountImportFailureText(failure: ImportFailure): string {
  switch (failure.reason) {
    case 'format':
      return '官网导出内容无法识别，未导入'
    case 'name':
      return '导出内容中的名称不可用，未导入'
    default:
      return importFailureText(failure, 'export').text
  }
}

export function accountImportSummary(imported: number, duplicates: number, failures: number): string {
  const parts = [`导入 ${imported} 块`]
  if (duplicates > 0) parts.push(`${duplicates} 块已存在`)
  if (failures > 0) parts.push(`${failures} 块失败`)
  return parts.join('，')
}
