/**
 * 状态色集中常量（SPEC J 节颜色硬约束）。
 *
 * 已核查 ui-theme design-platform.css：success/danger 语义令牌存在
 * （--dsw-alias-state-success-primary / --dsw-alias-state-error-primary /
 * --dsw-alias-state-warn-primary），一律复用，不新造色值；offline 灰点
 * 用 label 次级令牌（SPEC 指定）。异常时才回落 tokens 文件内注释的来源值。
 */

export const statusColors = {
  /** 在线绿点：design-platform.css 的 success 语义令牌（--dsw-static-green-500）。 */
  online: 'var(--dsw-alias-state-success-primary)',
  /** 探测中（checking/连接中）：warn 语义令牌。 */
  checking: 'var(--dsw-alias-state-warn-primary)',
  /** 离线/未知灰点：label 次级（SPEC 指定 var(--dsw-alias-label-secondary)）。 */
  offline: 'var(--dsw-alias-label-secondary)',
  /** ERROR 日志/错误提示：danger 语义令牌。 */
  error: 'var(--dsw-alias-state-error-primary)',
  /** 品牌强调（选中卡提亮、主按钮等）。 */
  brand: 'var(--dsw-alias-brand-primary)',
} as const

/** 向导面板断言尺寸（SPEC J：居中 ~1100px）。 */
export const WIZARD_WIDTH = 'min(1100px, calc(100vw - 48px))'