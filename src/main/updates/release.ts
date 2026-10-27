import { UPDATE_REPOSITORY_URL, type UpdateFailure } from '../../shared/updates'

/** The only update source, fixed at build time. */
export const UPDATE_OWNER = 'qiyi71w'
export const UPDATE_REPO = 'xdnmb'

/** Release downloads from github.com redirect to these asset hosts. */
const ASSET_HOSTS: Readonly<Record<string, true>> = { 'objects.githubusercontent.com': true, 'release-assets.githubusercontent.com': true }
const RELEASES_PATH = `/${UPDATE_OWNER}/${UPDATE_REPO}/releases`

/**
 * Whether an update request (including every redirect hop) may be sent: `https:` on the default port,
 * no credentials, and either this repository's releases on github.com or GitHub's release asset hosts.
 */
export function isAllowedUpdateRequest(address: string): boolean {
  if (!URL.canParse(address)) return false
  const url = new URL(address)
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') return false
  if (Object.hasOwn(ASSET_HOSTS, url.hostname)) return true
  return url.hostname === 'github.com' && (url.pathname === `${RELEASES_PATH}.atom` || url.pathname === RELEASES_PATH || url.pathname.startsWith(`${RELEASES_PATH}/`))
}

/** Strict `major.minor.patch` (no pre-release or build part: only stable releases are offered). */
const STABLE_VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/

export function isStableVersion(version: string): boolean {
  return STABLE_VERSION.test(version)
}

/** Positive when `a` is newer than `b`; both must be stable versions. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let index = 0; index < 3; index++) {
    const difference = left[index]! - right[index]!
    if (difference !== 0) return difference
  }
  return 0
}

/** What this installation downloads: the Windows x64 installer, or the DMG of the running Mac's architecture. */
export type PackageTarget = { platform: 'windows' } | { platform: 'mac'; arch: 'x64' | 'arm64' }

/** The release asset name the build produces for `target` (electron-builder `artifactName`). */
export function packageFileName(version: string, target: PackageTarget): string {
  return target.platform === 'windows' ? `xidao-${version}-win-x64.exe` : `xidao-${version}-mac-${target.arch}.dmg`
}

/** A file entry of `latest.yml` / `latest-mac.yml`. */
export interface MetadataFile {
  url: string
  sha512: string
  size?: number
}

/** SHA-512 in base64, as electron-builder writes it (64 bytes → 88 characters). */
const SHA512_BASE64 = /^[A-Za-z0-9+/]{86}==$/

/**
 * The one package of `files` this installation may download, or null. It must be named exactly as
 * the build names it for this version and target (a bare file name: no path, query or other host),
 * carry a well-formed SHA-512 and, when given, a positive size.
 */
export function selectPackage(version: string, files: readonly MetadataFile[], target: PackageTarget): MetadataFile | null {
  const expected = packageFileName(version, target)
  const matches = files.filter((file) => file.url === expected)
  if (matches.length !== 1) return null
  const file = matches[0]!
  if (!SHA512_BASE64.test(file.sha512)) return null
  if (file.size !== undefined && !(Number.isSafeInteger(file.size) && file.size > 0)) return null
  return file
}

/** The release page of a validated tag (`v1.2.3` or `1.2.3` for `version`), or null for any other tag. */
export function releasePageUrl(tag: unknown, version: string): string | null {
  if (tag !== `v${version}` && tag !== version) return null
  return `${UPDATE_REPOSITORY_URL}/releases/tag/${tag}`
}

/** ISO form of the metadata's `releaseDate`, or null when absent or not a date. */
export function releaseDateOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const time = Date.parse(value)
  return Number.isNaN(time) ? null : new Date(time).toISOString()
}

/** Thrown for metadata this installation refuses (wrong version, file, tag or checksum format). */
export class ReleaseSourceError extends Error {
  readonly failure = 'source' as const
}

const STORAGE_CODES: Readonly<Record<string, true>> = { ENOSPC: true, EACCES: true, EPERM: true, EROFS: true, EBUSY: true, EDQUOT: true, EMFILE: true }

/**
 * Classifies an error from checking or downloading. The message is only inspected for codes, never
 * shown: release text and server responses do not reach the UI.
 */
export function classifyUpdateError(error: unknown): UpdateFailure {
  if (error instanceof ReleaseSourceError) return 'source'
  const record = typeof error === 'object' && error !== null ? error : {}
  const code = 'code' in record ? String(record.code) : ''
  const message = error instanceof Error ? error.message : ''
  if (Object.hasOwn(STORAGE_CODES, code)) return 'storage'
  if (code === 'ERR_CHECKSUM_MISMATCH' || /checksum mismatch/.test(message)) return 'integrity'
  // A hop outside the allowed addresses was cancelled by the update session's request filter.
  if (message.includes('net::ERR_BLOCKED_BY_CLIENT')) return 'source'
  if (message.includes('net::ERR_') || code === 'ECONNRESET' || code === 'ETIMEDOUT') return 'network'
  const status = 'statusCode' in record ? Number(record.statusCode) : NaN
  if (status === 404) return 'source'
  if (!Number.isNaN(status)) return 'network'
  // The library's own metadata errors, e.g. a release feed without any published release.
  if (code.startsWith('ERR_UPDATER_') || code.startsWith('ERR_XML_')) return 'source'
  return 'network'
}
