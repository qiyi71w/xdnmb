import {
  CREDENTIAL_NAME_MAX_LENGTH, IMPORT_INPUT_MAX_LENGTH, validateCookieId, type ImportFormatError, type NameError
} from '../../shared/identity'

/**
 * Parsers for the two paste entries. Results carry the userhash only on success; failures carry
 * a category and never any part of the input. An export always carries its 饼干 ID (payload
 * `name`); a raw userhash carries none, its ID is typed separately.
 */
export type ParsedCredential =
  | { ok: true; userhash: string; cookieId: string | null }
  | { ok: false; error: ImportFormatError }

/** RFC 6265 cookie-octet: printable ASCII except space, `"`, `,`, `;` and `\`. */
const COOKIE_VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/
const MAX_USERHASH_LENGTH = 1024
const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/
const RAW_PREFIX = 'userhash='
// Control characters (C0, DEL, C1) and Unicode line/paragraph separators are not allowed in names.
const NAME_FORBIDDEN = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/

function userhashValue(value: string): ParsedCredential {
  if (value.length > MAX_USERHASH_LENGTH) return { ok: false, error: 'too-long' }
  if (!COOKIE_VALUE.test(value)) return { ok: false, error: 'invalid-cookie' }
  return { ok: true, userhash: value, cookieId: null }
}

function decodeBase64(text: string): string | null {
  const compact = text.replace(/\s+/g, '')
  if (!BASE64.test(compact) || compact.replace(/=+$/, '').length % 4 === 1) return null
  const bytes = Buffer.from(compact.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  if (bytes.length === 0) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return ''
  }
}

/**
 * 官网导出内容: the export page's QR text is JSON `{"cookie": "<userhash>", "name": "…"}`, carried
 * Base64-encoded in the export image URL (orzogc/xdnmb_api `getCookie`; orzogc/xdnmb QR scanner reads
 * the JSON directly). Both forms are accepted; the cookie value is used verbatim. `name` is the
 * cookie's public 饼干 ID; an export without a usable one is refused rather than stored unmatched.
 */
export function parseExportPayload(input: string): ParsedCredential {
  if (input.length > IMPORT_INPUT_MAX_LENGTH) return { ok: false, error: 'too-long' }
  const text = input.trim()
  if (text === '') return { ok: false, error: 'empty' }
  let json: string
  if (text.startsWith('{')) {
    json = text
  } else {
    const decoded = decodeBase64(text)
    if (decoded === null) return { ok: false, error: 'not-base64' }
    json = decoded.trim()
  }
  let value: unknown
  try {
    value = JSON.parse(json) as unknown
  } catch {
    return { ok: false, error: 'not-json' }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, error: 'not-json' }
  const record = value as Record<string, unknown>
  if (typeof record.cookie !== 'string' || record.cookie.trim() === '') return { ok: false, error: 'missing-cookie' }
  const parsed = userhashValue(record.cookie.trim())
  if (!parsed.ok) return parsed
  const cookieId = typeof record.name === 'string' ? validateCookieId(record.name) : null
  if (cookieId === null || !cookieId.ok) return { ok: false, error: 'missing-cookie-id' }
  return { ok: true, userhash: parsed.userhash, cookieId: cookieId.cookieId }
}

/** 原始 userhash: the cookie value, optionally pasted as `userhash=<value>`. */
export function parseRawUserhash(input: string): ParsedCredential {
  if (input.length > IMPORT_INPUT_MAX_LENGTH) return { ok: false, error: 'too-long' }
  let text = input.trim()
  if (text.startsWith(RAW_PREFIX)) text = text.slice(RAW_PREFIX.length).trim()
  if (text === '') return { ok: false, error: 'empty' }
  return userhashValue(text)
}

export function validateName(input: string): { ok: true; name: string } | { ok: false; error: NameError } {
  const name = input.trim()
  if (name === '') return { ok: false, error: 'empty' }
  if ([...name].length > CREDENTIAL_NAME_MAX_LENGTH) return { ok: false, error: 'too-long' }
  if (NAME_FORBIDDEN.test(name)) return { ok: false, error: 'invalid' }
  return { ok: true, name }
}
