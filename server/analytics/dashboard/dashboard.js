'use strict'

// Renders /admin/api/summary. A count is shown only when the service reported it:
// days without a service record stay "无数据", and a failed refresh never turns into zeros.

const PLATFORM_NAMES = { windows: 'Windows', macos: 'macOS' }
const timeFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
})
const numberFormat = new Intl.NumberFormat('zh-CN')

const elements = {
  status: document.getElementById('status'),
  refresh: document.getElementById('refresh'),
  problem: document.getElementById('problem'),
  problemText: document.getElementById('problem-text'),
  retry: document.getElementById('retry'),
  content: document.getElementById('content'),
  todayActive: document.getElementById('today-active'),
  todayNote: document.getElementById('today-note'),
  windowActive: document.getElementById('window-active'),
  windowNote: document.getElementById('window-note'),
  versions: document.querySelector('#versions tbody'),
  platforms: document.querySelector('#platforms tbody'),
  range: document.getElementById('range'),
  trend: document.querySelector('#trend tbody')
}

let latest = null
let busy = false

class LoadError extends Error {}

function cell(tag, text, className) {
  const element = document.createElement(tag)
  element.textContent = text
  if (className) element.className = className
  return element
}

function share(count, total) {
  if (total === 0) return numberFormat.format(count)
  return `${numberFormat.format(count)}（${Math.round(count / total * 100)}%）`
}

function renderDistribution(body, todayEntries, windowEntries, todayTotal, windowTotal, label) {
  const values = new Map()
  for (const entry of windowEntries) values.set(entry.value, { today: 0, window: entry.count })
  for (const entry of todayEntries) {
    const row = values.get(entry.value) ?? { today: 0, window: 0 }
    row.today = entry.count
    values.set(entry.value, row)
  }
  const rows = [...values].sort((a, b) => b[1].window - a[1].window || a[0].localeCompare(b[0]))
  if (rows.length === 0) {
    const row = document.createElement('tr')
    const empty = cell('td', '近 30 天没有上报', 'empty')
    empty.colSpan = 3
    row.append(empty)
    body.replaceChildren(row)
    return
  }
  body.replaceChildren(...rows.map(([value, counts]) => {
    const row = document.createElement('tr')
    row.append(
      cell('th', label(value)),
      cell('td', share(counts.today, todayTotal), 'number'),
      cell('td', share(counts.window, windowTotal), 'number')
    )
    row.firstChild.scope = 'row'
    return row
  }))
}

function renderTrend() {
  if (!latest) return
  const all = latest.trend.days
  const limit = elements.range.value === 'all' ? all.length : Number(elements.range.value)
  const days = all.slice(-limit).reverse()
  const max = Math.max(1, ...days.map((day) => day.active ?? 0))
  elements.trend.replaceChildren(...days.map((day) => {
    const row = document.createElement('tr')
    const date = cell('th', day.day)
    date.scope = 'row'
    const active = document.createElement('td')
    if (day.active === null) {
      active.textContent = '—'
    } else {
      const bar = document.createElement('span')
      bar.className = 'bar'
      bar.style.inlineSize = `${day.active / max * 100}%`
      bar.setAttribute('aria-hidden', 'true')
      const value = cell('span', numberFormat.format(day.active), 'bar-value')
      active.append(value, bar)
    }
    let state = ''
    if (day.day === latest.today) state = '进行中，今天尚未结束'
    else if (day.source === 'missing') state = '无数据（服务未记录这一天）'
    else if (day.source === 'summary') state = '日汇总'
    row.append(date, active, cell('td', state, 'state'))
    return row
  }))
}

function render(data) {
  latest = data
  elements.todayActive.textContent = numberFormat.format(data.todayActive)
  elements.todayNote.textContent = `${data.today}，今天尚未结束`
  elements.windowActive.textContent = numberFormat.format(data.window.active)
  const gaps = []
  if (data.window.missingDays > 0) gaps.push(`${data.window.missingDays} 天无数据`)
  if (data.window.summaryOnlyDays > 0) gaps.push(`${data.window.summaryOnlyDays} 天只有日汇总、未计入去重`)
  elements.windowNote.textContent = `${data.window.from} 至 ${data.window.to}${gaps.length ? `；其中 ${gaps.join('，')}` : ''}`
  renderDistribution(elements.versions, data.distributions.today.versions, data.distributions.window.versions,
    data.todayActive, data.window.active, (value) => value)
  renderDistribution(elements.platforms, data.distributions.today.platforms, data.distributions.window.platforms,
    data.todayActive, data.window.active, (value) => PLATFORM_NAMES[value] ?? value)
  renderTrend()
  elements.content.hidden = false
}

async function load() {
  if (busy) return
  busy = true
  elements.refresh.setAttribute('aria-disabled', 'true')
  elements.retry.setAttribute('aria-disabled', 'true')
  elements.status.textContent = latest ? '正在刷新…' : '正在读取统计…'
  try {
    let response
    try {
      response = await fetch('/admin/api/summary', { cache: 'no-store', credentials: 'same-origin' })
    } catch {
      throw new LoadError('无法连接统计服务。')
    }
    if (response.status === 401) throw new LoadError('登录已失效，重新载入页面后登录。')
    if (!response.ok) throw new LoadError(`统计读取失败（HTTP ${response.status}）。`)
    render(await response.json())
    elements.problem.hidden = true
    elements.status.textContent = `更新于 ${timeFormat.format(new Date(latest.generatedAt))}（北京时间）`
  } catch (error) {
    const message = error instanceof LoadError ? error.message : '统计数据无法解析。'
    elements.problemText.textContent = latest
      ? `${message}下面仍是 ${timeFormat.format(new Date(latest.generatedAt))} 读取的数据。`
      : message
    elements.problem.hidden = false
    elements.status.textContent = latest ? '刷新失败' : '读取失败'
  } finally {
    busy = false
    elements.refresh.removeAttribute('aria-disabled')
    elements.retry.removeAttribute('aria-disabled')
  }
}

elements.refresh.addEventListener('click', load)
elements.retry.addEventListener('click', load)
elements.range.addEventListener('change', renderTrend)
load()
