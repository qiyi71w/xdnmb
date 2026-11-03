import { closeSync, fsyncSync, openSync } from 'node:fs'

function flush(path: string, flags: 'r' | 'r+'): void {
  const fd = openSync(path, flags)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Flushes a file's content to disk. Opened for writing: Windows only flushes a writable handle. */
export function syncFile(path: string): void {
  flush(path, 'r+')
}

/**
 * Best effort: flushes a directory's entries where the platform allows opening a directory
 * (read-only, as directories cannot be opened for writing); elsewhere the renames stand as they are.
 */
export function syncDirectory(path: string): void {
  try {
    flush(path, 'r')
  } catch {
    // The files themselves were flushed.
  }
}
