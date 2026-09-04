/** CSS 模块/纯 CSS 的编辑器侧类型声明（构建由 tsdown 的 css 虚拟模块插件接管，照抄 dsh-terminal）。 */

declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css' {
  const classes: Record<string, string>
  export default classes
}