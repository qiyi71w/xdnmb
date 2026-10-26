// Global settings and theme files. Updates run one at a time so concurrent changes (e.g. a slider and
// an import) never overwrite each other with stale values. Paths come only from the system dialogs
// shown by the IPC layer; the renderer never supplies one.
import { open, writeFile } from 'node:fs/promises'
import type { SettingsUpdateResult, ThemeExportResult, ThemeImportResult } from '../shared/api'
import { applySettingsPatch, DEFAULT_SETTINGS, type AppSettings } from '../shared/settings'
import { MAX_THEME_FILE_BYTES, parseThemeDocument, serializeThemeDocument, themeDocument, themeFromBuiltin } from '../shared/theme'
import type { ReadingStore } from './storage/contract'

export type SettingsStore = Pick<ReadingStore, 'loadSettings' | 'saveSettings'>

export interface SettingsService {
  get(): Promise<AppSettings>
  update(patch: unknown): Promise<SettingsUpdateResult>
  /** `path` is the file chosen in the open dialog, or `null` when it was cancelled. */
  importTheme(path: string | null): Promise<ThemeImportResult>
  /** `path` is the file chosen in the save dialog, or `null` when it was cancelled. */
  exportTheme(path: string | null, systemDark: boolean): Promise<ThemeExportResult>
}

type ReadResult = { ok: true; text: string } | { ok: false; reason: 'read' | 'too-large' }

/** Reads at most `MAX_THEME_FILE_BYTES` (+1 to detect larger files) as strict UTF-8. */
async function readThemeFile(path: string): Promise<ReadResult | { ok: 'invalid-text' }> {
  let handle
  try {
    handle = await open(path, 'r')
    const buffer = Buffer.alloc(MAX_THEME_FILE_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > MAX_THEME_FILE_BYTES) return { ok: false, reason: 'too-large' }
    try {
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buffer.subarray(0, length))
      return { ok: true, text }
    } catch {
      return { ok: 'invalid-text' }
    }
  } catch {
    return { ok: false, reason: 'read' }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export function createSettingsService(store: SettingsStore, onSaved?: (settings: AppSettings) => void): SettingsService {
  let queue: Promise<unknown> = Promise.resolve()
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const run = queue.then(work, work)
    queue = run.catch(() => undefined)
    return run
  }

  /** A settings row that cannot be read leaves the defaults in effect rather than failing the UI. */
  const load = () => store.loadSettings().catch((): AppSettings => ({ ...DEFAULT_SETTINGS }))

  async function save(settings: AppSettings): Promise<boolean> {
    try {
      await store.saveSettings(settings)
      onSaved?.(settings)
      return true
    } catch {
      return false
    }
  }

  return {
    get: () => serial(load),

    update: (patch) =>
      serial(async () => {
        const current = await load()
        const next = applySettingsPatch(current, patch)
        if (!next.ok) return { saved: false, settings: current, issues: next.issues }
        const saved = await save(next.value)
        return { saved, settings: saved ? next.value : current, issues: [] }
      }),

    importTheme: (path) =>
      serial(async (): Promise<ThemeImportResult> => {
        if (path === null) return { status: 'cancelled' }
        const file = await readThemeFile(path)
        if (file.ok === false) return { status: 'failed', reason: file.reason }
        const parsed = file.ok === 'invalid-text' ? null : parseThemeDocument(file.text)
        if (parsed === null) return { status: 'rejected', issues: [{ kind: 'syntax' }] }
        if (!parsed.ok) return { status: 'rejected', issues: parsed.issues }
        const current = await load()
        const next: AppSettings = { ...current, customTheme: parsed.theme, reading: parsed.reading, customThemeEnabled: true }
        return (await save(next)) ? { status: 'imported', settings: next } : { status: 'failed', reason: 'not-saved' }
      }),

    exportTheme: (path, systemDark) =>
      serial(async (): Promise<ThemeExportResult> => {
        if (path === null) return { status: 'cancelled' }
        const current = await load()
        const scheme = current.colorScheme === 'light' || current.colorScheme === 'dark' ? current.colorScheme : systemDark ? 'dark' : 'light'
        const theme = current.customTheme ?? themeFromBuiltin(scheme)
        try {
          await writeFile(path, serializeThemeDocument(themeDocument(theme, current.reading)), 'utf8')
          return { status: 'exported' }
        } catch {
          return { status: 'failed' }
        }
      })
  }
}

/** File name offered by the save dialog for a theme name. */
export function themeFileName(settings: AppSettings): string {
  const name = settings.customTheme?.name ?? '汐岛主题'
  return `${name.replace(/[\\/:*?"<>|]/g, '_')}.json`
}
