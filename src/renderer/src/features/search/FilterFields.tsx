import { useId, useState, type ReactNode } from 'react'
import type { ForumId } from '../../../../shared/forum'
import type { ContentFilters } from '../../../../shared/search'
import { Icon } from '../../components/Icon'
import { listFilterCount, type FilteredList, type ListFilters, NO_LIST_FILTERS } from './listFilters'
import type { MetadataState } from './useThreadMetadata'
import '../identity/identity.css'
import './search.css'

const IMAGE_CHOICES: { value: ContentFilters['image']; label: string }[] = [
  { value: 'any', label: '不限' },
  { value: 'with', label: '有图' },
  { value: 'without', label: '无图' }
]

/** A `type=date` value, or null for an empty or incomplete one. */
function dateValue(value: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
}

/**
 * 版面／日期／图片 controls shared by the search sheet and the list filter bars. `forums` null hides
 * the forum choice (a single forum's own list). A forum that is filtered on but no longer in the
 * directory stays selectable by its ID.
 */
export function FilterFields({
  value,
  onChange,
  forums,
  disabled = false
}: {
  value: ContentFilters
  onChange: (next: ContentFilters) => void
  forums: ReadonlyMap<ForumId, string> | null
  disabled?: boolean
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
      <div className="filter-field">
        <span className="filter-label" id={`${id}-image`}>
          图片
        </span>
        <div className="segmented" role="group" aria-labelledby={`${id}-image`}>
          {IMAGE_CHOICES.map((choice) => (
            <button
              key={choice.value}
              type="button"
              className="segmented-item"
              aria-pressed={value.image === choice.value}
              disabled={disabled}
              onClick={() => onChange({ ...value, image: choice.value })}
            >
              {choice.label}
            </button>
          ))}
        </div>
      </div>
      {reversed && (
        <p className="field-warning filter-wide">
          <Icon name="alert" size={14} />
          <span>开始日期晚于结束日期，不会有内容符合</span>
        </p>
      )}
    </div>
  )
}

/**
 * Filter bar of a list view. Only threads already on screen are chosen from: no further page is
 * read to fill the list, and the thread being read stays open even when it is filtered out.
 */
export function ListFilterBar({
  filters,
  onChange,
  forums,
  noun,
  total,
  result,
  metadata,
  coverage
}: {
  filters: ListFilters
  onChange: (next: ListFilters) => void
  forums: ReadonlyMap<ForumId, string> | null
  noun: string
  total: number
  result: FilteredList<unknown>
  /** Local metadata the filters needed; null when the list carries its own main posts. */
  metadata: MetadataState | null
  /** What the list covers, e.g. “已加载的第 1–3 页”. */
  coverage: ReactNode
}) {
  const count = listFilterCount(filters)
  const [open, setOpen] = useState(count > 0)
  const panelId = useId()
  return (
    <div className="list-filters">
      <div className="list-filters-row">
        <button
          type="button"
          className={count > 0 ? 'btn btn-small filter-toggle is-active' : 'btn btn-small filter-toggle'}
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={count > 0 ? `筛选（已启用 ${count} 项）` : '筛选'}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name="filter" size={14} />
          筛选
          {count > 0 && <span className="btn-count">{count}</span>}
        </button>
        {count > 0 && (
          <p className="list-filters-summary" role="status">
            显示 {result.shown.length} / {total} 个{noun}
            {result.uncertain > 0 && `，其中 ${result.uncertain} 个字段未知`}
          </p>
        )}
        {count > 0 && (
          <button type="button" className="btn btn-small btn-quiet" onClick={() => onChange(NO_LIST_FILTERS)}>
            清除筛选
          </button>
        )}
      </div>
      <div className="list-filters-panel" id={panelId} hidden={!open}>
        <FilterFields value={filters.content} onChange={(content) => onChange({ ...filters, content })} forums={forums} />
      </div>
      {count > 0 && (
        <p className="list-filters-scope">
          <Icon name="info" size={13} />
          <span>
            只在{coverage}中筛选
            {metadata?.status === 'failed' && '；筛选信息读取失败，按字段未知显示'}
          </span>
        </p>
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
