import { chmodSync, closeSync, constants, copyFileSync, fsyncSync, lstatSync, openSync } from 'node:fs'

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
 * Copies `from` to the new file `to` (never replacing one) and flushes the copy. The copy keeps the
 * source's permissions, which may be read-only (a draft attachment copied from a read-only image);
 * it is made writable for its owner (on Windows: the read-only attribute cleared) so it can be
 * flushed. Only the new copy changes; `from` is only read.
 */
export function copyFileDurably(from: string, to: string): void {
  copyFileSync(from, to, constants.COPYFILE_EXCL)
  const mode = lstatSync(to).mode & 0o777
  if ((mode & 0o200) === 0) chmodSync(to, mode | 0o200)
  syncFile(to)
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
