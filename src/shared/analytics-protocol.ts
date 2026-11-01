// Public wire contract of the voluntary usage-statistics service (server/analytics).
// The desktop client and the service share these names, limits and formats; the
// behaviour behind them is documented in docs/analytics-service.md.
// Kept dependency-free and erasable-syntax-only so plain Node can load it.

export const ANALYTICS_PROTOCOL_VERSION = 1

export const ANALYTICS_PATHS = {
  register: '/v1/instances',
  activity: '/v1/activity'
} as const

/** Request bodies above this size are rejected with `payload_too_large`. */
export const ANALYTICS_MAX_BODY_BYTES = 1024

export type AnalyticsPlatform = 'windows' | 'macos'
export const ANALYTICS_PLATFORMS: readonly AnalyticsPlatform[] = ['windows', 'macos']

/** 16 random bytes, base64url without padding. Identifies an instance; never authorizes. */
export const ANALYTICS_INSTANCE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/
/** 32 random bytes, base64url without padding. Authorizes reports of its own instance only. */
export const ANALYTICS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
/** Xidao release version: `major.minor.patch` with an optional short pre-release tag. */
export const ANALYTICS_VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,23})?$/
/** Statistics day in Beijing time (UTC+8), `YYYY-MM-DD`. */
export const ANALYTICS_STAT_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export interface AnalyticsCredentials {
  instanceId: string
  token: string
}

export interface AnalyticsRegisterRequest {
  protocol: typeof ANALYTICS_PROTOCOL_VERSION
}

export interface AnalyticsActivityRequest extends AnalyticsCredentials {
  protocol: typeof ANALYTICS_PROTOCOL_VERSION
  version: string
  platform: AnalyticsPlatform
}

/** `201` for a new registration. Registration alone is never counted as activity. */
export type AnalyticsRegisterResponse = AnalyticsCredentials

/** `200`; `duplicate` is true when this instance had already been counted for `statDay`. */
export interface AnalyticsActivityResponse {
  statDay: string
  duplicate: boolean
}

export type AnalyticsErrorCode =
  | 'invalid_request'
  | 'unsupported_protocol'
  | 'unsupported_media_type'
  | 'payload_too_large'
  | 'invalid_credentials'
  | 'rate_limited'
  | 'capacity_exhausted'
  | 'not_found'
  | 'method_not_allowed'
  | 'server_error'

export interface AnalyticsErrorResponse {
  error: AnalyticsErrorCode
}
