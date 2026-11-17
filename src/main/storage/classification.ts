import type { AppSettings } from '../../shared/settings'

/*
 * 数据归类: what personal-data export and import do with each table, setting and user data entry.
 * The one source for export trimming, import merging and their tests; nothing else keeps a list.
 * Every table of the current schema, every setting key and every entry the app keeps in the user
 * data directory belongs to exactly one class (tests compare the tables and entries with what the
 * app actually creates; a setting key missing here is a type error). See docs/development.md.
 *
 * - `overwrite` (随文件覆盖): exported; an import replaces the target's with the file's.
 * - `target-kept` (目标机保留): not exported; an import keeps the target's.
 * - `target-appended` (目标机保留并追加): exported (offline copies optionally); an import keeps the
 *   target's and adds the file's. Each part (`AppendedPart`) has its own import merge and keeps its
 *   files in its own place (`APPENDED_FILES`).
 * - `secret` (秘密): exported only when chosen, under the export passphrase; an import re-encrypts the
 *   file's with the target's system protection and keeps the target's.
 * - `not-exported` (不导出): not exported; the target rebuilds it or starts from its initial state.
 */

export const DATA_CLASSES = ['overwrite', 'target-kept', 'target-appended', 'secret', 'not-exported'] as const
export type DataClass = (typeof DATA_CLASSES)[number]

/**
 * How a `not-exported` table or entry is left out. `cache`: ordinary cache, trimmed by the rules of
 * 清理普通缓存, so what personal records protect (visited threads' head text and reply counts,
 * content drafts and sending records refer to, images offline copies hold) goes with those records.
 * `rebuilt`: derived state the target rebuilds or starts afresh (search index, image holders,
 * readers and content clock, the reminder checker, temporary files).
 */
export type NotExportedPart = 'cache' | 'rebuilt'

/** The parts of `target-appended`: 离线副本 and 草稿, each merged as a whole on import. */
export const APPENDED_PARTS = ['offline-copies', 'drafts'] as const
export type AppendedPart = (typeof APPENDED_PARTS)[number]

export type Classification =
  | { class: Exclude<DataClass, 'not-exported' | 'target-appended'> }
  | { class: 'target-appended'; part: AppendedPart }
  | { class: 'not-exported'; part: NotExportedPart }

const overwrite = { class: 'overwrite' } as const
const targetKept = { class: 'target-kept' } as const
const offlineCopies = { class: 'target-appended', part: 'offline-copies' } as const
const drafts = { class: 'target-appended', part: 'drafts' } as const
const secret = { class: 'secret' } as const
const cache = { class: 'not-exported', part: 'cache' } as const
const rebuilt = { class: 'not-exported', part: 'rebuilt' } as const

/**
 * `settings` holds rows of different classes: each row is classified by its key (`settingClass`).
 * The database file is classified by its tables.
 */
export const BY_SETTING_KEY = { class: 'by-setting-key' } as const
export const BY_TABLE = { class: 'by-table' } as const

/**
 * Every table of the current schema, by name. An FTS5 virtual table's shadow tables
 * (`<name>_data`, `_idx`, `_content`, `_docsize`, `_config`) go with it; SQLite's own tables
 * (`sqlite_sequence`) go with the rows they describe.
 */
export const TABLES: Readonly<Record<string, Classification | typeof BY_SETTING_KEY>> = {
  // 浏览历史与保留标题
  thread_visits: overwrite,
  retained_titles: overwrite,
  // 阅读模式、阅读位置、阅读观察 (pages read and which thread each post was seen in)
  thread_reading: overwrite,
  reading_positions: overwrite,
  reading_observations: overwrite,
  post_threads: overwrite,
  // 发送记录及 PO 提示开关
  publication_attempts: overwrite,
  publication_settings: overwrite,
  // 屏蔽；饼干标色及自动标色记录
  local_blocks: overwrite,
  cookie_colors: overwrite,
  cookie_color_auto: overwrite,
  // 提醒规则、基线状态、基线区段、本机回复归属、回复数观察
  reminder_rules: overwrite,
  reminder_state: overwrite,
  reminder_baseline_segments: overwrite,
  reminder_local_replies: overwrite,
  reminder_count_observations: overwrite,
  // 身份角色（默认发言饼干、网页同步对象）；串内饼干选择
  identity_roles: overwrite,
  thread_post_identities: overwrite,
  // 订阅配置、观察、操作、基线、计划
  subscription_configuration: overwrite,
  subscription_observations: overwrite,
  subscription_operations: overwrite,
  subscription_baselines: overwrite,
  subscription_plans: overwrite,
  // 工作区
  workspace: overwrite,
  settings: BY_SETTING_KEY,
  // 官网账号会话
  account_session: targetKept,
  // 离线副本（含其页、发言、原图）；草稿与草稿附图
  offline_copies: offlineCopies,
  offline_pages: offlineCopies,
  offline_page_posts: offlineCopies,
  offline_images: offlineCopies,
  drafts,
  draft_attachments: drafts,
  // 饼干凭据；App UUID
  credentials: secret,
  subscription_app_credentials: secret,
  // 普通缓存：版块目录、列表页、串页、发言与回复数、图片
  directory_snapshot: cache,
  feed_pages: cache,
  thread_pages: cache,
  posts: cache,
  thread_reply_counts: cache,
  image_resources: cache,
  // 搜索索引
  search_state: rebuilt,
  search_sources: rebuilt,
  search_documents: rebuilt,
  search_backfill: rebuilt,
  search_fts: rebuilt,
  // 图片持有关系、阅读持有者与内容时钟；提醒检查器的单例运行状态
  image_holders: rebuilt,
  content_readers: rebuilt,
  content_clock: rebuilt,
  reminder_checker: rebuilt
}

type SettingClass = 'overwrite' | 'target-kept'

/** Every `AppSettings` key. Belonging to this device (system integration, updates, window layout) is `target-kept`. */
export const APP_SETTING_CLASSES: { readonly [K in keyof AppSettings]-?: SettingClass } = {
  reminderInterval: 'overwrite',
  reminderSystemNotifications: 'overwrite',
  reminderAutoQuote: 'overwrite',
  newTabSplitDefault: 'overwrite',
  closeAction: 'target-kept',
  loginLaunchResident: 'target-kept',
  bossKeyEnabled: 'target-kept',
  bossKey: 'target-kept',
  colorScheme: 'overwrite',
  customThemeEnabled: 'overwrite',
  customTheme: 'overwrite',
  customThemeList: 'overwrite',
  reading: 'overwrite',
  imageMaskEnabled: 'overwrite',
  imageMaskStrength: 'overwrite',
  density: 'overwrite',
  motion: 'overwrite',
  rail: 'overwrite',
  boards: 'overwrite',
  boardMarks: 'overwrite',
  listWidth: 'target-kept',
  customKaomoji: 'overwrite',
  recentKaomoji: 'overwrite',
  updateAutoCheck: 'overwrite',
  updateAutoInstall: 'target-kept',
  updateAutoDownload: 'target-kept',
  updateNetwork: 'target-kept',
  defaultSubscriptionSource: 'overwrite',
  subscriptionArrangement: 'overwrite'
}

/** Rows of the `settings` table that are not `AppSettings` keys. */
export const OTHER_SETTING_CLASSES: Readonly<Record<string, SettingClass>> = {
  // X 岛公告状态
  announcements: 'overwrite',
  // 使用统计实例；第三方授权；普通缓存上限
  analytics: 'target-kept',
  thirdPartyConsent: 'target-kept',
  cacheLimitBytes: 'target-kept'
}

/**
 * Every entry the app keeps in the user data directory, by name. Chromium's own profile files there
 * are not the app's and are never exported.
 */
export const USER_DATA_ENTRIES: Readonly<Record<string, Classification | typeof BY_TABLE>> = {
  // With its -wal, -shm and -journal files.
  'xidao.sqlite': BY_TABLE,
  'draft-images': drafts,
  // Cached forum images; originals offline copies hold go with the offline copies.
  images: cache,
  'clipboard-images': rebuilt,
  // This device's backups (pre-upgrade, before-restore) and the swap journal.
  backups: targetKept,
  'upgrade-without-backup.json': targetKept,
  'update-on-start.json': targetKept,
  'update-launched.json': targetKept,
  'update-state.json': targetKept
}

/**
 * The user data directory that keeps each `target-appended` part's files, by the same name in an
 * export file and the import staging: draft attachments in their own entry (moved with the
 * database by an import), offline copies' originals among the cached images.
 */
export const APPENDED_FILES: { readonly [P in AppendedPart]: string } = {
  'offline-copies': 'images',
  drafts: 'draft-images'
}

/** The class of a setting key (an `AppSettings` key or another `settings` row); null when unclassified. */
export function settingClass(key: string): SettingClass | null {
  if (Object.hasOwn(APP_SETTING_CLASSES, key)) return APP_SETTING_CLASSES[key as keyof AppSettings]
  return Object.hasOwn(OTHER_SETTING_CLASSES, key) ? OTHER_SETTING_CLASSES[key] ?? null : null
}

/** Setting keys (`AppSettings` keys and other `settings` rows) of one class. */
export function settingKeysIn(dataClass: SettingClass): string[] {
  return [...Object.entries(APP_SETTING_CLASSES), ...Object.entries(OTHER_SETTING_CLASSES)]
    .filter(([, value]) => value === dataClass)
    .map(([key]) => key)
}

function namesIn(entries: Readonly<Record<string, { class: string; part?: string }>>, dataClass: DataClass, part?: string): string[] {
  return Object.entries(entries)
    .filter(([, value]) => value.class === dataClass && (part === undefined || value.part === part))
    .map(([name]) => name)
}

/** Tables of one class (of one part of `not-exported` or `target-appended` when given). `settings` is in none: see `settingKeysIn`. */
export function tablesIn(dataClass: DataClass, part?: NotExportedPart | AppendedPart): string[] {
  return namesIn(TABLES, dataClass, part)
}

/** User data entries of one class (of one part when given). The database is in none: see `tablesIn`. */
export function userDataEntriesIn(dataClass: DataClass, part?: NotExportedPart | AppendedPart): string[] {
  return namesIn(USER_DATA_ENTRIES, dataClass, part)
}
