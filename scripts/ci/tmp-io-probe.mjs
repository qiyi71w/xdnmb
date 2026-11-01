// Temporary diagnosis: fsync latency of each folder given on the command line.
import { closeSync, fsyncSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'

console.log({ cpus: availableParallelism() })
for (const base of process.argv.slice(2)) {
  const folder = mkdtempSync(join(base, 'io-probe-'))
  const block = Buffer.alloc(4096, 1)
  const samples = []
  for (let file = 0; file < 20; file++) {
    const handle = openSync(join(folder, `f${file}`), 'w')
    for (let write = 0; write < 10; write++) {
      writeSync(handle, block)
      const start = performance.now()
      fsyncSync(handle)
      samples.push(performance.now() - start)
    }
    closeSync(handle)
  }
  rmSync(folder, { recursive: true, force: true })
  samples.sort((a, b) => a - b)
  const at = (q) => samples[Math.floor(q * (samples.length - 1))].toFixed(2)
  console.log({ base, fsyncs: samples.length, p50ms: at(0.5), p90ms: at(0.9), max: at(1) })
}
