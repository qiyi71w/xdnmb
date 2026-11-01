// Windows package checks for CI (x64 runner):
//   inspect  the NSIS installer and the unpacked app: latest.yml checksum, executable and SQLite
//            native module architecture, version resources, embedded icon, fixed update source
//   install  install silently for the current user into a fresh directory, start the installed app
//            with a separate data directory, save a setting and read it back after a restart, then
//            uninstall silently
// The app keeps a profile only under its own data directory; nothing outside the runner is written.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSmoke, metadataFiles, metadataVersion, sha512, sleep } from './smoke.mjs'

const ROOT = process.cwd()
const DIST = join(ROOT, 'dist')
const UNPACKED = join(DIST, 'win-unpacked')
const RESULTS = join(ROOT, 'windows-smoke')
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const INSTALLER = join(DIST, `xidao-${version}-win-x64.exe`)
const EXECUTABLE = 'xidao.exe'
const PRODUCT_NAME = '汐岛'
const START_MENU_LINK = join(process.env.APPDATA ?? '', 'Microsoft/Windows/Start Menu/Programs', `${PRODUCT_NAME}.lnk`)
const UNINSTALL_KEYS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
const MACHINE_X64 = 0x8664
const RT_ICON = 3
const RT_VERSION = 16
/**
 * The temporary folder in its long form. The runner's TEMP is an 8.3 short path (RUNNER~1); the
 * checks install where users do, under long paths.
 */
const TEMP = realpathSync.native(tmpdir())

/** The app's processes, recorded when a quit is stuck. */
function diagnose() {
  const tasks = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${EXECUTABLE}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).stdout
  return { tasks: tasks.trim().split(/\r?\n/) }
}
const { log, check, launch, quit, main } = createSmoke(RESULTS, { diagnose })

/**
 * The parts of a PE image the checks read: its machine type and the raw data of every resource of
 * one type (all names and languages).
 */
function peImage(path) {
  const file = readFileSync(path)
  const header = file.readUInt32LE(0x3c)
  if (file.readUInt32LE(header) !== 0x4550) throw new Error(`${path} is not a PE image`)
  const machine = file.readUInt16LE(header + 4)
  const sectionCount = file.readUInt16LE(header + 6)
  const optionalSize = file.readUInt16LE(header + 20)
  const optional = header + 24
  // Data directory 2 (resources) of a PE32+ (0x20b) or PE32 optional header.
  const directories = optional + (file.readUInt16LE(optional) === 0x20b ? 112 : 96)
  const resourceRva = file.readUInt32LE(directories + 2 * 8)
  const sections = Array.from({ length: sectionCount }, (_, index) => {
    const at = optional + optionalSize + index * 40
    return { rva: file.readUInt32LE(at + 12), size: Math.max(file.readUInt32LE(at + 8), file.readUInt32LE(at + 16)), raw: file.readUInt32LE(at + 20) }
  })
  const offsetOf = (rva) => {
    const section = sections.find((entry) => rva >= entry.rva && rva < entry.rva + entry.size)
    if (section === undefined) throw new Error(`${path}: address ${rva} is outside every section`)
    return rva - section.rva + section.raw
  }
  function resources(type) {
    if (resourceRva === 0) return []
    const root = offsetOf(resourceRva)
    const entries = (directory) => Array.from(
      { length: file.readUInt16LE(directory + 12) + file.readUInt16LE(directory + 14) },
      (_, index) => ({ id: file.readUInt32LE(directory + 16 + index * 8), target: file.readUInt32LE(directory + 20 + index * 8) })
    )
    const leaves = (target) => {
      if (target & 0x80000000) return entries(root + (target & 0x7fffffff)).flatMap((entry) => leaves(entry.target))
      const start = offsetOf(file.readUInt32LE(root + target))
      return [file.subarray(start, start + file.readUInt32LE(root + target + 4))]
    }
    // Named entries carry the high bit in `id`, so only the numeric type matches.
    const entry = entries(root).find((candidate) => candidate.id === type)
    return entry === undefined ? [] : leaves(entry.target)
  }
  return { machine, resources }
}

/** A value of the version resource's string table (UTF-16, keys and values padded with NULs). */
function versionString(image, key) {
  const [blob] = image.resources(RT_VERSION)
  return blob === undefined ? undefined : new RegExp(`${key}\\0+([^\\0]+)`).exec(blob.toString('utf16le'))?.[1]
}

/** The image data of every size in an `.ico` file. */
function iconImages(path) {
  const file = readFileSync(path)
  return Array.from({ length: file.readUInt16LE(4) }, (_, index) => {
    const at = 6 + index * 16
    const start = file.readUInt32LE(at + 12)
    return file.subarray(start, start + file.readUInt32LE(at + 8))
  })
}

/** Version resources, architecture and embedded icon of an app executable. */
function checkExecutable(path, label) {
  const image = peImage(path)
  check(`${label} executable architecture`, image.machine === MACHINE_X64, { machine: image.machine.toString(16) })
  const strings = Object.fromEntries(['ProductName', 'FileDescription', 'ProductVersion', 'FileVersion'].map((key) => [key, versionString(image, key)]))
  // electron-builder writes the file version as the app version and the product version with a fourth part.
  check(`${label} version resources`, strings.ProductName === PRODUCT_NAME && strings.FileVersion === version && strings.ProductVersion === `${version}.0`, strings)
  const embedded = image.resources(RT_ICON)
  const expected = iconImages(join(ROOT, 'resources/icons/xidao-icon.ico'))
  check(`${label} icon is the xidao icon`, expected.length > 0 && expected.every((data) => embedded.some((icon) => icon.equals(data))), { sizes: expected.length, embedded: embedded.length })
}

function inspect() {
  const latest = join(DIST, 'latest.yml')
  check('latest.yml version', metadataVersion(latest) === version, { version: metadataVersion(latest) })
  const entry = metadataFiles(latest).find((file) => file.url === `xidao-${version}-win-x64.exe`)
  check('installer exists', existsSync(INSTALLER), { installer: INSTALLER })
  if (existsSync(INSTALLER)) {
    check('installer checksum bound by latest.yml', entry?.sha512 === sha512(INSTALLER), { entry })
  }
  checkExecutable(join(UNPACKED, EXECUTABLE), 'unpacked')
  const sqlite = join(UNPACKED, 'resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/win32-x64.node')
  check('better-sqlite3 binary', existsSync(sqlite) && peImage(sqlite).machine === MACHINE_X64, { sqlite })
  const updateConfig = join(UNPACKED, 'resources/app-update.yml')
  const config = existsSync(updateConfig) ? readFileSync(updateConfig, 'utf8') : ''
  check('fixed update source', /owner: qiyi71w/.test(config) && /repo: xdnmb/.test(config) && /provider: github/.test(config), { config })
}

/** Whether an uninstall entry of the current user points into `directory`. */
const registered = (directory) => spawnSync('reg', ['query', UNINSTALL_KEYS, '/s', '/f', directory, '/d']).status === 0

/**
 * The installed app with its own data directory: platform, storage, system protection and the
 * update path, then a setting saved before a restart and read back after it.
 */
async function appChecks(executable, label) {
  const data = mkdtempSync(join(TEMP, 'xidao-data-'))
  let { app, page } = await launch(executable, [`--user-data-dir=${data}`])
  const arch = await app.evaluate(() => process.arch)
  const status = await page.evaluate(() => window.xidao.app.getStatus())
  const updates = await page.evaluate(() => window.xidao.updates.getState())
  const identities = await page.evaluate(() => window.xidao.identities.getOverview())
  check(`${label} app runs`, arch === 'x64' && status.platform === 'win32' && status.storage.state === 'ready', { arch, status })
  check(`${label} installs updates the Windows way`, updates.platform === 'windows' && updates.unavailable === null && updates.currentVersion === version, {
    platform: updates.platform, unavailable: updates.unavailable, version: updates.currentVersion
  })
  check(`${label} system protection available`, identities.protection === 'available' && identities.writable === true, { protection: identities.protection, writable: identities.writable })
  const saved = await page.evaluate(() => window.xidao.settings.update({ density: 'compact' }))
  check(`${label} saves a setting`, saved.saved === true && saved.settings.density === 'compact', { saved: saved.saved, issues: saved.issues })
  check(`${label} quits`, (await quit(app, `${label}-first`)) === 0)

  ;({ app, page } = await launch(executable, [`--user-data-dir=${data}`]))
  const settings = await page.evaluate(() => window.xidao.settings.get())
  check(`${label} keeps the setting after a restart`, settings.density === 'compact')
  await page.screenshot({ path: join(RESULTS, `${label}.png`) })
  check(`${label} quits again`, (await quit(app, `${label}-second`)) === 0)
}

async function install() {
  const directory = mkdtempSync(join(TEMP, 'xidao-install-'))
  // `/D=` must be the last argument and unquoted.
  const installer = spawnSync(INSTALLER, ['/S', `/D=${directory}`], { timeout: 300_000 })
  const executable = join(directory, EXECUTABLE)
  check('silent installation for the current user', installer.status === 0 && existsSync(executable), { status: installer.status, directory })
  if (!existsSync(executable)) return
  checkExecutable(executable, 'installed')
  const uninstaller = readdirSync(directory).find((name) => /^Uninstall .+\.exe$/.test(name))
  check('installation registered with uninstaller and start menu shortcut', uninstaller !== undefined && registered(directory) && existsSync(START_MENU_LINK), {
    uninstaller, shortcut: existsSync(START_MENU_LINK)
  })

  await appChecks(executable, 'installed')

  if (uninstaller === undefined) return
  // The uninstaller copies itself to a temporary file and returns at once. The copy removes the
  // files, then the shortcuts, and deletes the uninstall entry last (electron-builder's
  // uninstaller.nsh), so the entry's removal marks the end of the uninstallation.
  const started = spawnSync(join(directory, uninstaller), ['/S'], { timeout: 120_000 })
  const deadline = Date.now() + 120_000
  while (registered(directory) && Date.now() < deadline) await sleep(500)
  const entry = registered(directory)
  check('silent uninstallation removes the app, its entry and shortcut', started.status === 0 && !existsSync(executable) && !entry && !existsSync(START_MENU_LINK), {
    status: started.status, executable: existsSync(executable), entry, shortcut: existsSync(START_MENU_LINK)
  })
  log('uninstalled', { remaining: existsSync(directory) ? readdirSync(directory) : null })
}

await main({ inspect, install }, process.argv[2])
