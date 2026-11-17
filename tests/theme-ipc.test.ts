import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSettingsService } from '../src/main/appearance'
import { registerIpc } from '../src/main/ipc'
import { openReadingDatabase, type ReadingDatabase } from '../src/main/storage/database'
import { IpcChannel } from '../src/shared/api'
import { DEFAULT_SETTINGS } from '../src/shared/settings'
import { parseThemeDocument, serializeThemeDocument, themeDocument, themeFromBuiltin } from '../src/shared/theme'
import { customThemes } from '../src/shared/themeList'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input?: unknown) => unknown>(),
  saveDialog: { defaultPaths: [] as string[], answer: null as string | null },
  openDialog: { shown: 0, answer: null as string | null }
}))
vi.mock('electron', () => ({
  ipcMain: { handle(channel: string, handler: (event: unknown, input?: unknown) => unknown) { electron.handlers.set(channel, handler) } },
  BrowserWindow: { fromWebContents: () => null },
  dialog: {
    async showSaveDialog(options: { defaultPath: string }) {
      electron.saveDialog.defaultPaths.push(options.defaultPath)
      const path = electron.saveDialog.answer
      return path === null ? { canceled: true } : { canceled: false, filePath: path }
    },
    async showOpenDialog() {
      electron.openDialog.shown++
      const path = electron.openDialog.answer
      return path === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [path] }
    }
  },
  clipboard: {}, nativeTheme: {}, shell: {}
}))

const trusted = { id: 1, send: () => undefined, isDestroyed: () => false }
const untrusted = { id: 2, send: () => undefined, isDestroyed: () => false }

const theme = (name: string) => ({ ...themeFromBuiltin('light'), name })

let root: string
let db: ReadingDatabase

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'xidao-theme-ipc-'))
  db = openReadingDatabase(join(root, 'xidao.sqlite'))
  electron.saveDialog.defaultPaths = []
  electron.saveDialog.answer = null
  electron.openDialog.shown = 0
  electron.openDialog.answer = null
  const settings = createSettingsService({ loadSettings: async () => db.loadSettings(), saveSettings: async (value) => db.saveSettings(value) })
  // 青瓷 (in use), then 夜航.
  expect((await settings.update({ customTheme: theme('青瓷'), customThemeEnabled: true, customThemeList: { others: [theme('夜航')], currentIndex: 0 } })).saved).toBe(true)
  electron.handlers.clear()
  registerIpc({
    reminders: { onChanged: () => () => undefined },
    settings,
    isTrustedSender: (event: IpcMainInvokeEvent) => (event.sender as unknown) === trusted
  } as unknown as Parameters<typeof registerIpc>[0])
})

afterEach(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

function call(channel: string, sender: unknown, ...input: unknown[]): Promise<unknown> {
  const handler = electron.handlers.get(channel)
  if (handler === undefined) throw new Error(`${channel} not registered`)
  return Promise.resolve().then(() => handler({ sender }, ...input))
}

const files = () => readdirSync(root).filter((name) => name.endsWith('.json'))

describe('theme file operations', () => {
  it('exports the named custom theme through the save dialog in main, offering its name, and returns no path', async () => {
    const path = join(root, 'chosen.json')
    electron.saveDialog.answer = path
    const outcome = await call(IpcChannel.exportTheme, trusted, { name: '夜航' })
    expect(outcome).toEqual({ status: 'exported' })
    expect(electron.saveDialog.defaultPaths).toEqual(['夜航.json'])
    expect(parseThemeDocument(readFileSync(path, 'utf8'))).toEqual({ ok: true, theme: theme('夜航'), reading: DEFAULT_SETTINGS.reading })
    expect(JSON.stringify(outcome)).not.toContain(root)
  })

  it('refuses other callers, a name that is not text or is too long, and extra fields, before any dialog', async () => {
    electron.saveDialog.answer = join(root, 'x.json')
    await expect(call(IpcChannel.exportTheme, untrusted, { name: '夜航' })).rejects.toThrow('invalid request')
    for (const input of [
      undefined, null, '夜航', ['夜航'], {}, { name: 1 }, { name: null }, { name: ['夜航'] }, { name: { text: '夜航' } },
      { name: '长'.repeat(41) }, { name: '😀'.repeat(41) }, { name: 'x'.repeat(65_536) }, { name: '夜航', path: join(root, 'x.json') }
    ]) {
      await expect(call(IpcChannel.exportTheme, trusted, input)).rejects.toThrow('invalid request')
    }
    expect(electron.saveDialog.defaultPaths).toEqual([])
    expect(files()).toEqual([])
  })

  it('answers not-found for 汐岛 or a name no custom theme has, without showing the dialog', async () => {
    electron.saveDialog.answer = join(root, 'x.json')
    for (const name of ['汐岛', '纸白', '长'.repeat(40), '😀'.repeat(40)]) {
      expect(await call(IpcChannel.exportTheme, trusted, { name })).toEqual({ status: 'failed', reason: 'not-found' })
    }
    expect(electron.saveDialog.defaultPaths).toEqual([])
    expect(files()).toEqual([])
  })

  it('imports through the open dialog in main as a new theme, refusing at the limit', async () => {
    const path = join(root, 'night.json')
    writeFileSync(path, serializeThemeDocument(themeDocument(theme('夜航'), { font: 'serif', fontSize: 20, readingWidth: 30 })))
    electron.openDialog.answer = path
    expect(await call(IpcChannel.importTheme, trusted)).toMatchObject({ status: 'imported', settings: { customTheme: { name: '夜航 2' }, customThemeEnabled: true } })
    expect(customThemes(db.loadSettings()).map((item) => item.name)).toEqual(['青瓷', '夜航', '夜航 2'])
    expect(db.loadSettings().reading).toEqual(DEFAULT_SETTINGS.reading)

    const themes = Array.from({ length: 50 }, (_, index) => theme(`主题 ${index + 1}`))
    db.saveSettings({ ...db.loadSettings(), customTheme: themes[0]!, customThemeList: { others: themes.slice(1), currentIndex: 0 } })
    const before = db.loadSettings()
    expect(await call(IpcChannel.importTheme, trusted)).toEqual({ status: 'failed', reason: 'full' })
    expect(db.loadSettings()).toEqual(before)
    electron.openDialog.answer = null
    expect(await call(IpcChannel.importTheme, trusted)).toEqual({ status: 'cancelled' })
    await expect(call(IpcChannel.importTheme, untrusted)).rejects.toThrow('invalid request')
    expect(electron.openDialog.shown).toBe(3)
  })
})
