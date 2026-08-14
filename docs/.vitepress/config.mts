import { defineConfig } from 'vitepress'

// DSH 学习资料：侧边栏按学习路线组织
const guide = {
  text: '导读',
  items: [
    { text: '为什么研究 DSH', link: '/guide/why-dsh' },
    { text: '核心概念速览', link: '/guide/concepts' },
    { text: '架构总览', link: '/guide/architecture' },
  ],
}

const deepDive = {
  text: '深度拆解',
  items: [
    { text: '01 · 核心循环：Agent Loop', link: '/deep-dive/agent-loop' },
    { text: '02 · 工具系统与执行管道', link: '/deep-dive/tools' },
    { text: '03 · 沙箱与权限', link: '/deep-dive/sandbox' },
    { text: '04 · 上下文工程', link: '/deep-dive/context' },
    { text: '05 · 多代理编排', link: '/deep-dive/orchestration' },
    { text: '06 · LLM 层与流式管道', link: '/deep-dive/llm' },
    { text: '07 · Web GUI 与 API 层', link: '/deep-dive/web' },
    { text: '08 · 持久化与工程化', link: '/deep-dive/engineering' },
    { text: '编排补遗 · fork/goal/workflow 细节', link: '/deep-dive/orchestration-supplement' },
    { text: '压缩与计量补遗 · 重入/口径/插值', link: '/deep-dive/compaction-meter-supplement' },
    { text: '12 · 终端与 PTY', link: '/deep-dive/terminal-pty' },
    { text: '09 · 会话持久化内核', link: '/deep-dive/persistence-kernel' },
    { text: '10 · 进程外子代理与 ACP', link: '/deep-dive/out-of-process' },
    { text: '11 · 作用域与事件内核', link: '/deep-dive/scope-events' },
  ],
}

const interview = {
  text: '面试冲刺',
  items: [
    { text: '设计模式手册', link: '/interview/patterns' },
    { text: '高频面试题', link: '/interview/qa' },
  ],
}

const practice = {
  text: '实战',
  items: [
    { text: '扩展 DSH：加一个工具', link: '/practice/extend' },
  ],
}

export default defineConfig({
  lang: 'zh-CN',
  title: 'DSH 深度拆解',
  description: 'DeepSeek Harness 源码级学习资料：从插件框架到 agent 循环的完整逻辑',
  base: '/dsh/',
  head: [
    ['meta', { name: 'theme-color', content: '#4d6bfe' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'DSH 深度拆解 · Deep Dive into DeepSeek Harness' }],
    ['meta', { property: 'og:description', content: '源码级中文学习资料：15 篇拆解、12 个设计模式、28 道面试题' }],
    ['meta', { property: 'og:image', content: 'https://bin-hy.github.io/dsh/banner.svg' }],
  ],
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    logo: '🚀',
    nav: [
      { text: '导读', link: '/guide/why-dsh', activeMatch: '/guide/' },
      { text: '深度拆解', link: '/deep-dive/agent-loop', activeMatch: '/deep-dive/' },
      { text: '面试冲刺', link: '/interview/patterns', activeMatch: '/interview/' },
      { text: '实战', link: '/practice/extend', activeMatch: '/practice/' },
    ],
    sidebar: {
      '/guide/': guide,
      '/deep-dive/': deepDive,
      '/interview/': interview,
      '/practice/': practice,
    },
    outline: { level: [2, 3], label: '本页目录' },
    docFooter: { prev: '上一篇', next: '下一篇' },
    lastUpdated: { text: '最后更新' },
    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '搜索文档' },
          modal: {
            noResultsText: '没有找到相关结果',
            resetButtonTitle: '清除查询',
            footer: { selectText: '选择', navigateText: '切换' },
          },
        },
      },
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/Bin-hy/dsh', ariaLabel: 'GitHub 仓库' },
    ],
    editLink: { pattern: '' },
    footer: {
      message: '基于 DeepSeek Harness 0.1.0-rc.5 源码研究整理 · 源码与笔记见 GitHub 仓库',
    },
  },
  markdown: {
    lineNumbers: true,
  },
})
