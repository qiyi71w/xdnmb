import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { build } from 'vite'
import { expect, it } from 'vitest'
import { openReadingStore } from '../src/main/storage/store'
import type { AppStore } from '../src/main/storage/contract'

it('runs the production database worker with real trigram search, batched rebuild and durable eviction', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'xidao-search-worker-'))
  const require = createRequire(import.meta.url)
  let store: AppStore | null = null
  let worker: Worker | null = null
  try {
    // Bundle the actual worker entry, not a test imitation of its dispatch or SQL implementation.
    await build({
      configFile: false, logLevel: 'silent',
      build: {
        outDir: join(folder, 'worker'), emptyOutDir: false, target: 'node24',
        lib: { entry: fileURLToPath(new URL('../src/main/storage/worker.ts', import.meta.url)), formats: ['es'], fileName: () => 'database.mjs' },
        rollupOptions: {
          external: (id) => id === 'better-sqlite3' || id.startsWith('node:'),
          output: { paths: { 'better-sqlite3': pathToFileURL(require.resolve('better-sqlite3')).href } }
        }
      }
    })
    const databasePath = join(folder, 'app.sqlite')
    store = await openReadingStore({ databasePath, createWorker(options) {
      worker = new Worker(pathToFileURL(join(folder, 'worker/database.mjs')), options)
      return worker
    } })
    expect(store.status.state).toBe('ready')
    await store.beginSearchRebuild()
    for (let step = 0; step < 100; step++) if (await store.rebuildSearchBatch()) break
    await store.savePost({ id: '100', title: 'Trigram 中文标题', forumId: null, createdAt: null, userHash: null, name: null,
      isAdmin: null, isSage: null, image: null, imageKnown: true, content: [{ type: 'text', text: 'worker content' }], plainText: 'worker content' }, '2026-10-24T00:00:00Z')
    const upper = await store.searchBoundary()
    const input = { query: '中文标', scope: { kind: 'local' as const }, filters: { forumId: null, fromDate: null, toDate: null, image: 'any' as const }, after: 0, upper }
    expect(await store.searchBatch(input)).toMatchObject({ batch: { hits: [{ postId: '100', retention: 'cache', hasImage: false }] } })
    expect((await store.getReadingState('100')).readPostIds).toEqual([])
    for (let step = 0; step < 100; step++) if (!(await store.evictContentBatch(true)).more) break
    expect(await store.searchBatch({ ...input, query: 'worker' })).toMatchObject({ batch: { hits: [], done: true } })
    expect((await store.getContentUsage()).cacheTextBytes).toBe(0)
  } finally {
    await store?.close()
    if (worker !== null) await (worker as Worker).terminate()
    rmSync(folder, { force: true, recursive: true })
  }
}, 30_000)
