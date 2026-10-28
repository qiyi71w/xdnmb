// Plain-Chinese descriptions of appearance issues (theme editor, theme import, refused settings).
import { THEME_LIMITS, type AppearanceIssue } from '../../../shared/theme'

const FIELD_LABELS: Record<string, string> = {
  name: '主题名称',
  base: '基调',
  colors: '颜色',
  'colors.background': '窗口底色',
  'colors.surface': '正文底色',
  'colors.text': '正文文字颜色',
  'colors.secondaryText': '次要文字颜色',
  'colors.accent': '强调色',
  opacity: '透明度',
  radius: '圆角',
  font: '字体',
  fontSize: '字号',
  readingWidth: '阅读宽度',
  colorScheme: '配色',
  customTheme: '自定义主题',
  customThemeEnabled: '自定义主题',
  reading: '阅读参数',
  density: '密度',
  motion: '动态效果',
  newTabSplitDefault: '新标签默认开启分栏',
  closeAction: '关闭窗口时的操作',
  rail: '图标栏设置',
  'rail.order': '图标栏顺序',
  'rail.hidden': '隐藏的功能',
  boards: '版块管理',
  'boards.favorites': '收藏的版块',
  'boards.hidden': '隐藏的版块',
  'boards.order': '版块顺序',
  'boards.collapsed': '收起的分组',
  listWidth: '列表宽度',
  customKaomoji: '自定义颜文字',
  recentKaomoji: '最近使用的颜文字'
}

/** Field path relative to the theme / reading object (`customTheme.colors.text` → `colors.text`). */
function relativeField(field: string): string {
  return field.replace(/^(customTheme|reading)\./, '')
}

function rangeText(field: string): string {
  if (field.startsWith('colors.')) return '须为 #rrggbb 格式的颜色，例如 #1f2933'
  switch (field) {
    case 'name':
      return `须为 ${THEME_LIMITS.nameLength.min}–${THEME_LIMITS.nameLength.max} 个字符，且不含控制字符`
    case 'base':
      return '须为浅色基调或深色基调'
    case 'opacity':
      return `须在 ${THEME_LIMITS.opacity.min}–${THEME_LIMITS.opacity.max} 之间`
    case 'radius':
      return `须为 ${THEME_LIMITS.radius.min}–${THEME_LIMITS.radius.max} 的整数`
    case 'font':
      return '请选择内置或本机字体'
    case 'fontSize':
      return `须为 ${THEME_LIMITS.fontSize.min}–${THEME_LIMITS.fontSize.max} 的整数`
    case 'readingWidth':
      return `须为 ${THEME_LIMITS.readingWidth.min}–${THEME_LIMITS.readingWidth.max} 的整数`
    default:
      return '超出允许范围'
  }
}

export function describeIssue(issue: AppearanceIssue): string {
  switch (issue.kind) {
    case 'syntax':
      return '文件不是有效的 JSON'
    case 'format':
      return '文件不是汐岛主题文件'
    case 'version':
      return issue.found === null ? '主题文件缺少版本号' : `不支持主题文件版本 ${issue.found}`
    case 'field': {
      const field = relativeField(issue.field)
      const label = FIELD_LABELS[field] ?? FIELD_LABELS[field.replace(/^colors\.(light|dark)\./, 'colors.')] ?? `字段“${issue.field}”`
      switch (issue.problem) {
        case 'missing':
          return `缺少${label}`
        case 'type':
          return `${label}的类型不正确`
        case 'range':
          return `${label}${rangeText(field)}`
        case 'unknown':
          return `不认识的字段“${issue.field}”`
        case 'unavailable':
          return field === 'customThemeEnabled' ? '请先创建或导入主题' : `${label}当前不可用`
      }
    }
  }
}

/** Distinct descriptions in order (a color malformed in both schemes reads the same twice). */
export function describeIssues(issues: readonly AppearanceIssue[]): string[] {
  return [...new Set(issues.map(describeIssue))]
}

/** Draft fields that have their own issue (for aria-invalid on the matching input). */
export function invalidFields(issues: readonly AppearanceIssue[]): Set<string> {
  const fields = new Set<string>()
  for (const issue of issues) if (issue.kind === 'field') fields.add(relativeField(issue.field))
  return fields
}
