/**
 * AdvancedSection — 高级设置占位空壳。
 *
 * 原有的「最大对话轮数」控件已移除：该参数在引入上下文压缩机制后不再被运行时
 * 读取。目前整个 tab 没有可调项，已在导航与路由处注释停用
 * （见 components/settings/SectionNav.tsx 与
 * entrypoints/sidepanel/pages/settings/index.tsx）。
 *
 * TODO: 待接入新的高级设置项（如上下文压缩参数）后，填充本组件并恢复导航/路由入口。
 */
export function AdvancedSection() {
  return null;
}

