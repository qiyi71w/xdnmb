import { useId, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { ForumId } from '../../../../shared/forum'
import type { ContentFilters, PostKind, SearchFilters } from '../../../../shared/search'
import { Icon } from '../../components/Icon'
import { contentFilterCount, type FilteredList } from './listFilters'
import { NO_CONTENT_FILTERS } from './searchState'
import type { MetadataState } from './useThreadMetadata'
import '../identity/identity.css'
import './search.css'

const IMAGE_CHOICES: { value: ContentFilters['image']; label: string }[] = [
  { value: 'any', label: '不限' },
  { value: 'with', label: '有图' },
  { value: 'without', label: '无图' }
]

const POST_KIND_CHOICES: { value: PostKind; label: string }[] = [
  { value: 'any', label: '不限' },
  { value: 'head', label: '主帖' },
  { value: 'reply', label: '回复' }
]

/** A `type=date` value, or null for an empty or incomplete one. */
function dateValue(value: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
}

/** One exclusive filter choice as pressed buttons (`.segmented`) under a visible label. */
function ChoiceField<T extends string>({
  label,
  choices,
  value,
  onChange,
  disabled
}: {
  label: string
  choices: readonly { value: T; label: string }[]
  value: T
  onChange: (next: T) => void
  disabled: boolean
}) {
  const labelId = useId()
  return (
    <div className="filter-field">
      <span className="filter-label" id={labelId}>
        {label}
      </span>
      <div className="segmented" role="group" aria-labelledby={labelId}>
        {choices.map((choice) => (
          <button
            key={choice.value}
            type="button"
            className="segmented-item"
            aria-pressed={value === choice.value}
            disabled={disabled}
            onClick={() => onChange(choice.value)}
          >
            {choice.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * 版面／日期／图片 controls shared by the search page and the list filter bars. `forums` null hides
 * the forum choice (a single forum's own list). A forum that is filtered on but no longer in the
 * directory stays selectable by its ID. `children` are further fields of one surface, laid out
 * with these.
 */
function FilterFields({
  value,
  onChange,
  forums,
  disabled = false,
  children
}: {
  value: ContentFilters
  onChange: (next: ContentFilters) => void
  forums: ReadonlyMap<ForumId, string> | null
  disabled?: boolean
  children?: ReactNode
}) {
  const id = useId()
  const reversed = value.fromDate !== null && value.toDate !== null && value.fromDate > value.toDate
  const forumKnown = value.forumId === null || forums?.has(value.forumId) === true
  return (
    <div className="filter-fields">
      {forums !== null && (
        <div className="filter-field">
          <label className="filter-label" htmlFor={`${id}-forum`}>
            版面
          </label>
          <select
            id={`${id}-forum`}
            className="select-input"
            value={value.forumId ?? ''}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, forumId: event.target.value === '' ? null : event.target.value })}
          >
            <option value="">全部版面</option>
            {!forumKnown && value.forumId !== null && <option value={value.forumId}>版面 {value.forumId}</option>}
            {[...forums].map(([forumId, name]) => (
              <option key={forumId} value={forumId}>
                {name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="filter-field">
        <span className="filter-label" id={`${id}-date`}>
          发言日期
        </span>
        <div className="filter-dates" role="group" aria-labelledby={`${id}-date`}>
          <input
            type="date"
            className="text-input"
            aria-label="开始日期（含）"
            value={value.fromDate ?? ''}
            disabled={disabled}
            aria-invalid={reversed ? true : undefined}
            onChange={(event) => onChange({ ...value, fromDate: dateValue(event.target.value) })}
          />
          <span className="filter-dash" aria-hidden="true">
            –
          </span>
          <input
            type="date"
            className="text-input"
            aria-label="结束日期（含）"
            value={value.toDate ?? ''}
            disabled={disabled}
            aria-invalid={reversed ? true : undefined}
            onChange={(event) => onChange({ ...value, toDate: dateValue(event.target.value) })}
          />
        </div>
      </div>
      <ChoiceField
        label="图片"
        choices={IMAGE_CHOICES}
        value={value.image}
        disabled={disabled}
        onChange={(image) => onChange({ ...value, image })}
      />
      {children}
      {reversed && (
        <p className="field-warning filter-wide">
          <Icon name="alert" size={14} />
          <span>开始日期晚于结束日期，不会有内容符合</span>
        </p>
      )}
    </div>
  )
}

/** A list view's filters: its toggle sits in the list head's actions, its panel right under the head. */
export interface ListFilter {
  filters: ContentFilters
  onChange: (next: ContentFilters) => void
  count: number
  open: boolean
  setOpen: (open: boolean) => void
  panelId: string
  toggleRef: RefObject<HTMLButtonElement | null>
}

/** Opens with the list when filters are already in use. */
export function useListFilter(filters: ContentFilters, onChange: (next: ContentFilters) => void): ListFilter {
  const count = contentFilterCount(filters)
  const [open, setOpen] = useState(count > 0)
  const panelId = useId()
  const toggleRef = useRef<HTMLButtonElement>(null)
  return { filters, onChange, count, open, setOpen, panelId, toggleRef }
}

/** 筛选 among the list head's icon buttons, before 刷新; the count of filters in use on its corner. */
export function ListFilterToggle({ filter }: { filter: ListFilter }) {
  const { count, open, setOpen, panelId, toggleRef } = filter
  const name = count > 0 ? `筛选（已启用 ${count} 项）` : '筛选'
  return (
    <button
      ref={toggleRef}
      type="button"
      className={count > 0 ? 'icon-btn filter-toggle is-active' : 'icon-btn filter-toggle'}
      aria-expanded={open}
      aria-controls={panelId}
      aria-label={name}
      title={name}
      onClick={() => setOpen(!open)}
    >
      <Icon name="filter" />
      {count > 0 && (
        <span className="filter-badge" aria-hidden="true">
          {count}
        </span>
      )}
    </button>
  )
}

/**
 * Filters of a search. The 搜索 page's local search adds 发言 (main post or reply); the in-thread
 * search keeps its 发言类型 at 不限 and does not offer it.
 */
export function SearchFilterFields({
  value,
  onChange,
  forums,
  postKind
}: {
  value: SearchFilters
  onChange: (next: SearchFilters) => void
  forums: ReadonlyMap<ForumId, string>
  /** Whether 发言 is offered. */
  postKind: boolean
}) {
  return (
    <FilterFields value={value} onChange={(next) => onChange({ ...next, postKind: value.postKind })} forums={forums}>
      {postKind && (
        <ChoiceField
          label="发言"
          choices={POST_KIND_CHOICES}
          value={value.postKind}
          disabled={false}
          onChange={(kind) => onChange({ ...value, postKind: kind })}
        />
      )}
    </FilterFields>
  )
}

/**
 * The list's first block, under its head: the fields while open, and while filters are in use one
 * line saying what is shown, with 清除筛选. Only threads already on screen are chosen from: no
 * further page is read to fill the list, and the thread being read stays open even when it is
 * filtered out.
 */
export function ListFilterPanel({
  filter,
  forums,
  noun,
  total,
  result,
  metadata,
  coverage
}: {
  filter: ListFilter
  forums: ReadonlyMap<ForumId, string> | null
  noun: string
  total: number
  result: FilteredList<unknown>
  /** Local metadata the filters needed; null when the list carries its own main posts. */
  metadata: MetadataState | null
  /** What the list covers, e.g. “已加载的第 1–3 页”. */
  coverage: ReactNode
}) {
  const { filters, onChange, count, open, panelId, toggleRef } = filter
  return (
    <div className="list-filters" hidden={!open && count === 0}>
      <div className="list-filters-panel" id={panelId} hidden={!open}>
        <FilterFields value={filters} onChange={onChange} forums={forums} />
      </div>
      {count > 0 && (
        <div className="list-filters-status">
          <p className="list-filters-summary" role="status">
            显示 {result.shown.length} / {total} 个{noun}，只在{coverage}中筛选
            {result.uncertain > 0 && `，其中 ${result.uncertain} 个字段未知`}
            {metadata?.status === 'failed' && '；筛选信息读取失败，按字段未知显示'}
          </p>
          <button
            type="button"
            className="btn btn-small btn-quiet"
            onClick={() => {
              onChange(NO_CONTENT_FILTERS)
              // This button goes away with the filters: focus stays with 筛选.
              toggleRef.current?.focus()
            }}
          >
            清除筛选
          </button>
        </div>
      )}
    </div>
  )
}

/** Tag on an item kept by filters only because a field it was judged by is unknown. */
export function UncertainTag() {
  return (
    <span className="tag tag-uncertain">
      字段未知
    </span>
  )
}
