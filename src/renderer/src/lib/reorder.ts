// Pure list reordering behind the sort handles (components/SortHandle.tsx) and the stores they write.

/**
 * `list` with the item at `from` moved to index `to` (the others keep their order); `null` when
 * nothing moves: the same index, or either index outside the list.
 */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] | null {
  const inList = (index: number) => Number.isInteger(index) && index >= 0 && index < list.length
  if (from === to || !inList(from) || !inList(to)) return null
  const result = [...list]
  const [item] = result.splice(from, 1)
  result.splice(to, 0, item as T)
  return result
}

/** `list` with `key` moved into `target`'s place; `null` when either is missing or both are the same. */
export function moveKey<T>(list: readonly T[], key: T, target: T): T[] | null {
  return moveItem(list, list.indexOf(key), list.indexOf(target))
}

/**
 * The drop slot under `y`, given each item's vertical middle from top to bottom: slot `i` is the gap
 * before item `i`, `middles.length` the end of the list.
 */
export function slotAt(middles: readonly number[], y: number): number {
  const index = middles.findIndex((middle) => y < middle)
  return index < 0 ? middles.length : index
}

/** Where a drop into `slot` puts item `from` of `length` items; `null` when it stays where it is. */
export function slotIndex(from: number, slot: number, length: number): number | null {
  if (!Number.isInteger(from) || !Number.isInteger(slot) || from < 0 || from >= length || slot < 0 || slot > length) return null
  if (slot === from || slot === from + 1) return null
  return slot > from ? slot - 1 : slot
}
