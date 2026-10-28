// macOS package and update checks for CI (Apple Silicon runner):
//   inspect  both DMGs: architecture, native module, identity, icon, ad-hoc signature, latest-mac.yml checksums
//   x64      the Intel app starts under Rosetta with working storage
//   update   install the current DMG, find / download / verify the next version from a controlled
//            GitHub stand-in, open the DMG, replace the app as a user would, and start the new version
// The stand-in answers only inside the app's update network session; nothing is published.
import { _electron as electron } from 'playwright-core'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = process.cwd()
const DIST = join(ROOT, 'dist')
const NEXT = join(ROOT, 'dist-next')
const RESULTS = join(ROOT, 'mac-smoke')
/** The one `.app` bundle in `dir` (its file name is whatever the build and the file system produced). */
function appIn(dir) {
  const apps = readdirSync(dir).filter((name) => name.endsWith('.app'))
  if (apps.length !== 1) throw new Error(`expected one app in ${dir}: ${JSON.stringify(readdirSync(dir))}`)
  return join(dir, apps[0])
}
const BUNDLE_ID = 'io.github.qiyi71w.xidao'
mkdirSync(RESULTS, { recursive: true })

const failures = []
function log(step, data = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), step, ...data })
  appendFileSync(join(RESULTS, 'log.jsonl'), `${line}\n`)
  console.log(line)
}
function check(name, ok, detail = {}) {
  log(name, { ok, ...detail })
  if (!ok) failures.push(name)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const run = (file, args) => execFileSync(file, args, { encoding: 'utf8' })
const sha512 = (path) => createHash('sha512').update(readFileSync(path)).digest('base64')
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version

/** `files` entries of an electron-builder update file: url, sha512, size. */
function metadataFiles(path) {
  const text = readFileSync(path, 'utf8')
  return [...text.matchAll(/- url: (\S+)\n\s+sha512: (\S+)\n\s+size: (\d+)/g)].map(([, url, hash, size]) => ({ url, sha512: hash, size: Number(size) }))
}
const metadataVersion = (path) => /^version: (\S+)$/m.exec(readFileSync(path, 'utf8'))?.[1]
const plist = (app, key) => run('/usr/bin/plutil', ['-extract', key, 'raw', join(app, 'Contents/Info.plist')]).trim()
const executableOf = (app) => join(app, 'Contents/MacOS', plist(app, 'CFBundleExecutable'))

function attach(dmg) {
  const output = run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-noautoopen', dmg])
  const mount = /\t(\/Volumes\/.+?)\s*$/m.exec(output)?.[1]
  if (mount === undefined) throw new Error(`no mount point for ${dmg}`)
  return mount
}
const detach = (mount) => run('/usr/bin/hdiutil', ['detach', mount, '-force'])

/** Mount points of attached images whose path ends with `name`. */
function mountedImages(name) {
  return run('/usr/bin/hdiutil', ['info']).split(/^=+$/m)
    .filter((entry) => new RegExp(`image-path\\s*: .*${name.replace(/\./g, '\\.')}\\s*$`, 'm').test(entry))
    .flatMap((entry) => [...entry.matchAll(/\t(\/Volumes\/.+?)\s*$/gm)].map((match) => match[1]))
}

function inspect() {
  const latest = join(DIST, 'latest-mac.yml')
  const files = metadataFiles(latest)
  check('latest-mac.yml version', metadataVersion(latest) === version, { version: metadataVersion(latest) })
  for (const arch of ['x64', 'arm64']) {
    const dmg = `xidao-${version}-mac-${arch}.dmg`
    const entry = files.find((file) => file.url === dmg)
    const path = join(DIST, dmg)
    check(`${arch} dmg exists`, existsSync(path), { dmg })
    if (!existsSync(path)) continue
    check(`${arch} dmg checksum bound by latest-mac.yml`, entry?.sha512 === sha512(path) && entry?.size === readFileSync(path).length, { entry })
    const app = appIn(join(DIST, arch === 'x64' ? 'mac' : 'mac-arm64'))
    log(`${arch} app bundle`, { app, name: plist(app, 'CFBundleName'), executable: plist(app, 'CFBundleExecutable') })
    const archs = run('/usr/bin/lipo', ['-archs', executableOf(app)]).trim()
    check(`${arch} executable architecture`, archs === (arch === 'x64' ? 'x86_64' : 'arm64'), { archs })
    const sqlite = join(app, `Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/darwin-${arch}.node`)
    const sqliteArchs = existsSync(sqlite) ? run('/usr/bin/lipo', ['-archs', sqlite]).trim() : null
    check(`${arch} better-sqlite3 binary`, sqliteArchs === (arch === 'x64' ? 'x86_64' : 'arm64'), { sqliteArchs })
    check(`${arch} identity`, plist(app, 'CFBundleIdentifier') === BUNDLE_ID && plist(app, 'CFBundleShortVersionString') === version && plist(app, 'LSMinimumSystemVersion') === '13.0', {
      id: plist(app, 'CFBundleIdentifier'), version: plist(app, 'CFBundleShortVersionString'), minimum: plist(app, 'LSMinimumSystemVersion')
    })
    const icon = join(app, 'Contents/Resources', `${plist(app, 'CFBundleIconFile').replace(/\.icns$/, '')}.icns`)
    check(`${arch} icon is the xidao icon`, existsSync(icon) && sha256(icon) === sha256(join(ROOT, 'resources/icons/xidao-icon.icns')))
    const updateConfig = join(app, 'Contents/Resources/app-update.yml')
    const config = existsSync(updateConfig) ? readFileSync(updateConfig, 'utf8') : ''
    check(`${arch} fixed update source`, /owner: qiyi71w/.test(config) && /repo: xdnmb/.test(config) && /provider: github/.test(config), { config })
    // `codesign -dv` reports on stderr.
    const signature = spawnSync('/usr/bin/codesign', ['-dv', app], { encoding: 'utf8' }).stderr
    check(`${arch} ad-hoc signature only`, /Signature=adhoc/.test(signature), { signature: signature.split('\n').filter((line) => /Signature|Identifier|TeamIdentifier/.test(line)) })
  }
}

/**
 * Node prints this once the main process has finished and is exiting while the test driver's
 * inspector session (`--inspect`) is still attached; that session can keep the process alive.
 */
const EXIT_HELD_BY_DEBUGGER = 'Waiting for the debugger to disconnect'
const finishedOf = new WeakMap()
let launches = 0
async function launch(executablePath, args = [], timeout = 90_000) {
  const app = await electron.launch({ executablePath, args, timeout })
  // The app's own console output, kept as evidence.
  const output = join(RESULTS, `app-${++launches}.log`)
  const finished = Promise.withResolvers()
  finishedOf.set(app, finished.promise)
  let text = ''
  for (const stream of [app.process().stdout, app.process().stderr]) {
    stream?.on('data', (chunk) => {
      appendFileSync(output, chunk)
      text += chunk
      if (text.includes(EXIT_HELD_BY_DEBUGGER)) finished.resolve('finished')
    })
  }
  const page = await app.firstWindow({ timeout: 60_000 })
  await page.waitForLoadState('domcontentloaded')
  await sleep(2500)
  return { app, page }
}
const updateState = (page) => page.evaluate(() => window.xidao.updates.getState())
async function waitFor(page, predicate, label, timeout = 180_000) {
  const start = Date.now()
  for (;;) {
    const state = await updateState(page)
    if (predicate(state)) return state
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${label}: ${JSON.stringify(state)}`)
    await sleep(250)
  }
}
/**
 * A real quit (app menu / Cmd+Q path). Done when the process exits, or when the main process has
 * finished and only the driver's inspector holds it (then the driver ends it). On a timeout,
 * records where the process is and ends it.
 */
async function quit(app, label) {
  const child = app.process()
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)))
  await app.evaluate(({ app }) => { app.quit() }).catch(() => undefined)
  const result = await Promise.race([exited, finishedOf.get(app), sleep(90_000).then(() => 'timeout')])
  if (result === 'finished') {
    const code = await Promise.race([exited, sleep(5000).then(() => 'held')])
    if (code === 'held') {
      log(`quit finished, process held by the driver's debugger: ${label}`)
      child.kill('SIGKILL')
      await exited
      return 0
    }
    return code
  }
  if (result !== 'timeout') return result
  const pid = String(child.pid)
  const windows = await Promise.race([
    app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), destroyed: window.isDestroyed() }))),
    sleep(5000).then(() => 'no answer')
  ]).catch((error) => String(error))
  const tree = spawnSync('/bin/ps', ['-ax', '-o', 'pid,ppid,stat,etime,command'], { encoding: 'utf8' }).stdout.split('\n')
    .filter((line) => line.includes(pid) || /xidao|汐岛/.test(line)).slice(0, 20)
  spawnSync('/usr/bin/sample', [pid, '3', '-file', join(RESULTS, `sample-${label}.txt`)])
  log(`quit stuck: ${label}`, { windows, tree })
  child.kill('SIGKILL')
  await exited
  return result
}
async function openAbout(page) {
  if (!(await page.locator('#shell-set-about').count())) await page.keyboard.press('Meta+,')
  await page.waitForSelector('#shell-set-about', { timeout: 20_000 })
  await page.evaluate(() => document.getElementById('shell-set-about')?.scrollIntoView())
  await sleep(300)
}
const aboutText = (page) => page.locator('#shell-set-about').innerText()

async function x64() {
  const app = appIn(join(DIST, 'mac'))
  const data = mkdtempSync(join(tmpdir(), 'xidao-x64-'))
  // The first start under Rosetta translates the whole x64 Electron first (about 90 s on the runner).
  const { app: running, page } = await launch(executableOf(app), [`--user-data-dir=${data}`], 300_000)
  const arch = await running.evaluate(() => process.arch)
  const status = await page.evaluate(() => window.xidao.app.getStatus())
  const state = await updateState(page)
  check('x64 app runs (Rosetta)', arch === 'x64' && status.storage.state === 'ready' && state.platform === 'mac' && state.unavailable === null, { arch, status, platform: state.platform })
  await page.screenshot({ path: join(RESULTS, 'x64.png') })
  check('x64 app quits', (await quit(running, 'x64')) === 0)
}

/** Serves the next release for the app's update session only (forum and other sessions are untouched). */
async function serveNextRelease(app, next) {
  const file = `xidao-${next}-mac-arm64.dmg`
  const feed = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>v${next}</id><updated>2026-10-27T12:00:00Z</updated><link rel="alternate" type="text/html" href="https://github.com/qiyi71w/xdnmb/releases/tag/v${next}"/><title>v${next}</title><content type="html">&lt;h2&gt;测试 ${next}&lt;/h2&gt;&lt;ul&gt;&lt;li&gt;受控发布源&lt;/li&gt;&lt;/ul&gt;&lt;script&gt;document.title='pwned'&lt;/script&gt;</content></entry></feed>`
  await app.evaluate(async ({ session }, config) => {
    const fs = process.getBuiltinModule('node:fs')
    globalThis.__fake = { ...config, mode: 'normal', requests: [] }
    const update = session.fromPartition('electron-updater', { cache: false })
    update.protocol.handle('https', async (request) => {
      const fake = globalThis.__fake
      const url = new URL(request.url)
      fake.requests.push(`${url.host}${url.pathname}`)
      const base = '/qiyi71w/xdnmb/releases'
      if (url.host === 'github.com' && url.pathname === `${base}.atom`) return new Response(fake.feed, { headers: { 'content-type': 'application/atom+xml' } })
      if (url.host === 'github.com' && url.pathname === `${base}/latest`) return new Response(JSON.stringify({ tag_name: `v${fake.next}` }), { headers: { 'content-type': 'application/json' } })
      if (url.host === 'github.com' && url.pathname === `${base}/download/v${fake.next}/latest-mac.yml`) {
        return fake.mode === 'no-metadata' ? new Response('not found', { status: 404 }) : new Response(fs.readFileSync(fake.yml))
      }
      if (url.host === 'github.com' && url.pathname === `${base}/download/v${fake.next}/${fake.file}`) {
        return new Response(null, { status: 302, headers: { location: `https://release-assets.githubusercontent.com/asset/${fake.file}` } })
      }
      if (url.host === 'release-assets.githubusercontent.com') {
        let bytes = fs.readFileSync(fake.dmg)
        if (fake.mode === 'corrupt') {
          bytes = Buffer.from(bytes)
          bytes[bytes.length - 100] ^= 0xff
        }
        return new Response(bytes, { headers: { 'content-length': String(bytes.length) } })
      }
      return new Response('not found', { status: 404 })
    })
  }, { next, file, feed, yml: join(NEXT, 'latest-mac.yml'), dmg: join(NEXT, file) })
}

async function update() {
  const next = metadataVersion(join(NEXT, 'latest-mac.yml'))
  const mount = attach(join(DIST, `xidao-${version}-mac-arm64.dmg`))
  const bundle = appIn(mount)
  const installed = join('/Applications', bundle.slice(mount.length + 1))
  rmSync(installed, { recursive: true, force: true })
  run('/usr/bin/ditto', [bundle, installed])
  detach(mount)
  check('installed current version', plist(installed, 'CFBundleShortVersionString') === version)

  let { app, page } = await launch(executableOf(installed))
  await openAbout(page)
  const cold = await waitFor(page, (state) => !state.checking && state.lastCheck !== null, 'cold start check')
  // The live source's answer depends on what is published; only that the check ran is required here.
  check('cold start check ran', cold.platform === 'mac' && cold.unavailable === null, { lastCheck: cold.lastCheck })

  await serveNextRelease(app, next)
  await app.evaluate(() => { globalThis.__fake.mode = 'no-metadata' })
  const before = cold.lastCheck.at
  await page.getByRole('button', { name: '检查更新' }).click()
  const missing = await waitFor(page, (state) => !state.checking && state.lastCheck?.at !== before, 'check without metadata')
  check('a release without usable metadata is a failed check, never up to date', missing.lastCheck.outcome === 'failed' && !(await aboutText(page)).includes('已是最新版本'), { lastCheck: missing.lastCheck })

  await app.evaluate(() => { globalThis.__fake.mode = 'normal' })
  await page.getByRole('button', { name: '检查更新' }).click()
  const found = await waitFor(page, (state) => !state.checking && state.release !== null, 'found next')
  await sleep(3000)
  const idle = await updateState(page)
  check('found the next version; automatic download is off by default', found.release.info.version === next && idle.release.download.status === 'none', { download: idle.release.download })
  const notes = await aboutText(page)
  check('release notes shown as text, script not run', notes.includes(`测试 ${next}`) && notes.includes('受控发布源') && (await page.title()) !== 'pwned')
  check('no Windows install action on macOS', (await page.getByRole('button', { name: '安装并重启' }).count()) === 0)

  await app.evaluate(() => { globalThis.__fake.mode = 'corrupt' })
  await page.getByRole('button', { name: '下载更新' }).click()
  const corrupt = await waitFor(page, (state) => state.release?.download.status === 'none' && state.release.download.failure !== null, 'integrity failure')
  check('a package that does not match its checksum is discarded', corrupt.release.download.failure === 'integrity' && (await page.getByRole('button', { name: '打开安装包' }).count()) === 0, { download: corrupt.release.download })

  await app.evaluate(() => { globalThis.__fake.mode = 'normal' })
  await page.getByRole('switch', { name: '自动下载更新' }).click()
  const ready = await waitFor(page, (state) => state.release?.download.status === 'ready', 'automatic download')
  check('turning on automatic download downloads and verifies the DMG', ready.installOnQuit === false)
  await page.screenshot({ path: join(RESULTS, 'mac-ready.png') })

  await page.getByRole('button', { name: '打开安装包' }).click()
  let opened = []
  for (let attempt = 0; attempt < 60 && opened.length === 0; attempt++) {
    await sleep(500)
    opened = mountedImages(`xidao-${next}-mac-arm64.dmg`)
  }
  const afterOpen = await updateState(page)
  check('opening the package mounts the verified DMG, still the old version', opened.length > 0 && afterOpen.currentVersion === version && (await aboutText(page)).includes(`版本 ${version}`), { opened })
  await page.screenshot({ path: join(RESULTS, 'mac-opened.png') })
  check('quit before replacing', (await quit(app, 'opened')) === 0)

  // What the user does: drag the new app over the old one.
  if (opened.length > 0) {
    rmSync(installed, { recursive: true, force: true })
    run('/usr/bin/ditto', [appIn(opened[0]), installed])
    for (const point of opened) detach(point)
  }
  ;({ app, page } = await launch(executableOf(installed)))
  await openAbout(page)
  const upgraded = await waitFor(page, (state) => !state.checking, 'start settled')
  const settings = await page.evaluate(() => window.xidao.settings.get())
  const status = await page.evaluate(() => window.xidao.app.getStatus())
  const pending = join(homedir(), 'Library/Caches/xidao-updater/pending')
  const leftovers = existsSync(pending) ? readdirSync(pending).filter((name) => name.endsWith('.dmg')) : []
  check('next start shows the version actually running, keeps data, drops the installed package', upgraded.currentVersion === next && upgraded.release === null &&
    settings.updateAutoDownload === true && status.storage.state === 'ready' && leftovers.length === 0, { version: upgraded.currentVersion, release: upgraded.release, storage: status.storage, leftovers })
  await page.screenshot({ path: join(RESULTS, 'mac-upgraded.png') })
  check('quit new version', (await quit(app, 'upgraded')) === 0)
}

const commands = { inspect, x64, update }
try {
  await commands[process.argv[2]]()
} catch (error) {
  check(`${process.argv[2]} completed`, false, { error: String(error?.stack ?? error) })
}
if (failures.length > 0) {
  console.error(`failed: ${failures.join('; ')}`)
  process.exit(1)
}
