// Shared parts of the package checks in scripts/ci: the JSON-lines record, starting and quitting
// the packaged app under Playwright, and the update metadata electron-builder writes.
import { _electron as electron } from 'playwright-core'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export const sha512 = (path) => createHash('sha512').update(readFileSync(path)).digest('base64')
export const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
/** `files` entries of an electron-builder update file: url, sha512, and size when listed (macOS lists it, Windows does not). */
export function metadataFiles(path) {
  const text = readFileSync(path, 'utf8')
  return [...text.matchAll(/- url: (\S+)\r?\n\s+sha512: (\S+)(?:\r?\n\s+size: (\d+))?/g)]
    .map(([, url, hash, size]) => ({ url, sha512: hash, size: size === undefined ? undefined : Number(size) }))
}
export const metadataVersion = (path) => /^version: (\S+)$/m.exec(readFileSync(path, 'utf8'))?.[1]

/**
 * Animation frames in one second. Playwright's visibility waits poll on them, and the x64 app under
 * Rosetta on the runner draws as few as one to twenty frames a second, so UI waits allow a minute.
 */
export const UI_WAIT_MS = 60_000

/**
 * Node prints this once the main process has finished and is exiting while the test driver's
 * inspector session (`--inspect`) is still attached; that session can keep the process alive.
 */
const EXIT_HELD_BY_DEBUGGER = 'Waiting for the debugger to disconnect'

/**
 * One check run writing to `results`: `log.jsonl`, each launch's console output and whatever the
 * caller saves there. `diagnose(pid, label)` records platform details when a quit is stuck.
 */
export function createSmoke(results, { diagnose = () => undefined } = {}) {
  mkdirSync(results, { recursive: true })
  const failures = []
  const finishedOf = new WeakMap()
  let launches = 0

  function log(step, data = {}) {
    const line = JSON.stringify({ at: new Date().toISOString(), step, ...data })
    appendFileSync(join(results, 'log.jsonl'), `${line}\n`)
    console.log(line)
  }
  function check(name, ok, detail = {}) {
    log(name, { ok, ...detail })
    if (!ok) failures.push(name)
  }

  async function launch(executablePath, args = [], timeout = 90_000) {
    const app = await electron.launch({ executablePath, args, timeout })
    // The app's own console output, kept as evidence.
    const output = join(results, `app-${++launches}.log`)
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
    await settleStartupPrompts(app, page)
    return { app, page }
  }

  /**
   * The dialogs a real profile raises by itself at startup, answered the way a user does before the
   * checks begin: the first-run statistics question (release builds name a statistics origin), and
   * the cold-start announcement from the live source. Both are modal and would cover the settings
   * the checks open. The current announcement is marked 不再提示 first, so it is never granted later
   * in the run (also not on later starts of the same profile); Esc keeps statistics off, so the app
   * never contacts the statistics service.
   */
  async function settleStartupPrompts(app, page) {
    await app.evaluate(({ app, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.show()
      window.focus()
      app.focus({ steal: true })
    })
    const notice = await page.evaluate(() => window.xidao.announcements.getState())
    const suppressed = notice.source === 'current' && notice.latest?.enable === true
      ? await page.evaluate(({ date, content }) => window.xidao.announcements.suppress({ date, content }), notice.latest)
      : null
    const start = Date.now()
    for (;;) {
      if (await page.locator('dialog.modal[open]').count() > 0) await page.keyboard.press('Escape')
      else {
        const statistics = await page.evaluate(() => window.xidao.analytics.getState())
        if (statistics.availability !== 'available' || statistics.saved !== 'unset') {
          log('startup prompts settled', { announcement: notice.outcome, suppressed, statistics })
          return
        }
      }
      if (Date.now() - start > 2 * UI_WAIT_MS) throw new Error('startup prompts did not settle')
      await sleep(500)
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
    const windows = await Promise.race([
      app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), destroyed: window.isDestroyed() }))),
      sleep(5000).then(() => 'no answer')
    ]).catch((error) => String(error))
    log(`quit stuck: ${label}`, { windows, ...diagnose(String(child.pid), label) })
    child.kill('SIGKILL')
    await exited
    return result
  }

  /** Runs `commands[name]`, records an exception as a failed check, and exits 1 on any failure. */
  async function main(commands, name) {
    try {
      await commands[name]()
    } catch (error) {
      check(`${name} completed`, false, { error: String(error?.stack ?? error) })
    }
    if (failures.length > 0) {
      console.error(`failed: ${failures.join('; ')}`)
      process.exit(1)
    }
  }

  return { log, check, launch, quit, main }
}
