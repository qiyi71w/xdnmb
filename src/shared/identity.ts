/**
 * Cookie identities (饼干凭据) as seen by the renderer. Secrets never cross this boundary after
 * import: the renderer only receives local references, names and states.
 */

/** Local reference to a stored credential: a decimal string of a never-reused local ID. */
export type CredentialId = string

/** Which paste entry produced the credential. */
export type CredentialSource = 'export' | 'raw'

export interface CredentialSummary {
  id: CredentialId
  /** User-visible display name; not secret, and not the public 饼干 ID. */
  name: string
  /**
   * Public 饼干 ID shown beside this cookie's posts, used only to recognise them (own posts, PO
   * cookie, quotes of mine). `null`: unknown — imported before IDs were kept; such a cookie is used
   * as usual but matches nothing. Never derived from the display name.
   */
  cookieId: string | null
  source: CredentialSource
  /** ISO-8601 time of the local import. */
  importedAt: string
}

/**
 * Independent identity roles. Changing one never changes another.
 * - `default-post`: default 发言饼干 for new edits (consumed by posting/drafts).
 * - `web-sync`: the fixed 网页订阅 同步对象 (consumed by subscription sync).
 *
 * Forum reads use the first credential of the ordered list; with no credential they carry none.
 */
export type IdentityRole = 'default-post' | 'web-sync'

export const IDENTITY_ROLES: readonly IdentityRole[] = ['default-post', 'web-sync']

/**
 * - `none`: nothing chosen.
 * - `selected`: the chosen credential exists locally.
 * - `missing`: the chosen credential was removed. The reference is kept as missing and is never
 *   replaced by another credential; operations depending on this role require a new choice.
 */
export type RoleSelection =
  | { state: 'none' }
  | { state: 'selected'; credentialId: CredentialId }
  | { state: 'missing'; credentialId: CredentialId }

/**
 * OS secret protection (Windows DPAPI / macOS Keychain via Electron safeStorage).
 * `unavailable` covers no OS protection and Linux's plain-text fallback; nothing is then stored
 * in plain text, imports are refused and operations needing a secret are blocked.
 */
export type ProtectionState = 'available' | 'unavailable'

export interface IdentityOverview {
  protection: ProtectionState
  /** False when local storage is read-only/unavailable: imports, renames, removals and selections are refused. */
  writable: boolean
  /** In the user's order; the first one is sent with forum reads. */
  credentials: CredentialSummary[]
  roles: Record<IdentityRole, RoleSelection>
}

export type ImportFormatError =
  /** Nothing but whitespace was pasted. */
  | 'empty'
  /** Input exceeds the accepted size. */
  | 'too-long'
  /** Export entry: neither Base64 (plain or percent-encoded) nor JSON. */
  | 'not-base64'
  /** Export entry: an address that is not the official export QR image, or carries no `text`. */
  | 'not-export-url'
  /** Export entry: Base64 decoded, but not UTF-8 JSON. */
  | 'not-json'
  /** Export entry: JSON lacks a non-empty string `cookie`. */
  | 'missing-cookie'
  /** Export entry: JSON lacks a usable `name`, which is the cookie's public 饼干 ID. */
  | 'missing-cookie-id'
  /** The userhash contains characters a cookie value cannot carry (spaces, `;`, quotes, controls…). */
  | 'invalid-cookie'

export type NameError = 'empty' | 'too-long' | 'invalid'

/** A typed 饼干 ID: empty, longer than {@link COOKIE_ID_MAX_LENGTH}, or containing whitespace/controls. */
export type CookieIdError = 'empty' | 'too-long' | 'invalid'

/**
 * What re-importing an already stored userhash did to that entry's 饼干 ID. Nothing else of the
 * entry (name, order, roles) ever changes.
 * - `filled`: the entry had no ID; the import's ID was stored.
 * - `same`: the entry already has this ID.
 * - `conflict`: the entry has a different ID; it was kept as is.
 */
export type DuplicateCookieId = 'filled' | 'same' | 'conflict'

/** Import failures. None of them echo any part of the pasted input. */
export type ImportFailure =
  | { reason: 'format'; detail: ImportFormatError }
  /** `required`: export payload without a usable name and none given. */
  | { reason: 'name'; detail: NameError | 'required' }
  /** Userhash entry: the typed 饼干 ID is not acceptable. */
  | { reason: 'cookie-id'; detail: CookieIdError }
  /** Same userhash already stored: only its 饼干 ID may have been filled in (see `cookieId`); `existing` is the entry afterwards. */
  | { reason: 'duplicate'; existing: CredentialSummary; cookieId: DuplicateCookieId }
  | { reason: 'protection-unavailable' }
  /** An existing credential could not be decrypted, so duplicates cannot be ruled out. */
  | { reason: 'decrypt-failed' }
  | { reason: 'storage' }

/**
 * `ok` means the format was accepted and the credential stored encrypted; it says nothing about
 * whether the forum currently accepts it.
 */
export type ImportResult = { ok: true; credential: CredentialSummary } | { ok: false; failure: ImportFailure }

export type IdentityMutationResult =
  | { ok: true }
  | { ok: false; reason: 'not-found' | 'storage' | 'name' | 'cookie-id'; nameError?: NameError; cookieIdError?: CookieIdError }

/** Name limits shared by import and rename. */
export const CREDENTIAL_NAME_MAX_LENGTH = 40
/** Upper bound for a typed 饼干 ID (forum IDs are a handful of characters). */
export const COOKIE_ID_MAX_LENGTH = 32
/** Maximum pasted input length accepted by either import entry. */
export const IMPORT_INPUT_MAX_LENGTH = 8192
