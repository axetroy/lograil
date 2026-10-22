import { defineConfig } from 'vitepress';
import { withMermaid } from 'vitepress-plugin-mermaid';

const REPO = 'axetroy/lograil';

function themeConfig(locale: 'en' | 'zh') {
  const p = locale === 'zh' ? '/zh' : '';
  return {
    nav: [
      { text: locale === 'zh' ? '指南' : 'Guide', link: `${p}/guide/introduction` },
      { text: locale === 'zh' ? 'Playground' : 'Playground', link: `${p}/playground` },
      { text: 'API', link: `${p}/api/` },
      { text: 'GitHub', link: `https://github.com/${REPO}` },
    ],
    sidebar: {
      [`${p}/guide/`]: [
        {
          text: locale === 'zh' ? '指南' : 'Guide',
          items: [
            {
              text: locale === 'zh' ? '简介' : 'Introduction',
              link: `${p}/guide/introduction`,
            },
            {
              text: locale === 'zh' ? '快速开始' : 'Getting Started',
              link: `${p}/guide/getting-started`,
            },
            { text: locale === 'zh' ? '配置' : 'Configuration', link: `${p}/guide/configuration` },
            { text: locale === 'zh' ? '传输器' : 'Transports', link: `${p}/guide/transports` },
            { text: locale === 'zh' ? '插件' : 'Plugins', link: `${p}/guide/plugins` },
            {
              text: locale === 'zh' ? '运行时' : 'Runtimes',
              items: [
                { text: locale === 'zh' ? 'Web' : 'Web', link: `${p}/guide/runtime-web` },
                { text: locale === 'zh' ? 'Node' : 'Node', link: `${p}/guide/runtime-node` },
                { text: 'Electron', link: `${p}/guide/runtime-electron` },
              ],
            },
            { text: locale === 'zh' ? '架构' : 'Architecture', link: `${p}/guide/architecture` },
            {
              text: locale === 'zh' ? '上下文与元数据' : 'Context & Metadata',
              link: `${p}/guide/context`,
            },
            { text: locale === 'zh' ? '术语表' : 'Glossary', link: `${p}/guide/glossary` },
            { text: locale === 'zh' ? '基准测试' : 'Benchmarks', link: `${p}/guide/benchmarks` },
            { text: locale === 'zh' ? '迁移指南' : 'Migrating', link: `${p}/guide/migrating` },
            { text: locale === 'zh' ? '发布流程' : 'Releasing', link: `${p}/guide/releasing` },
            {
              text: locale === 'zh' ? '故障排查' : 'Troubleshooting',
              link: `${p}/guide/troubleshooting`,
            },
          ],
        },
      ],
      [`${p}/api/`]: [
        {
          text: locale === 'zh' ? 'API 参考' : 'API Reference',
          items: [
            { text: locale === 'zh' ? '概览' : 'Overview', link: `${p}/api/` },
            { text: 'Logger', link: `${p}/api/logger` },
            { text: 'Transports', link: `${p}/api/transports` },
            { text: 'Pipeline', link: `${p}/api/pipeline` },
            { text: 'Context', link: `${p}/api/context` },
            { text: 'Plugins', link: `${p}/api/plugins` },
            { text: 'Runtime', link: `${p}/api/runtime` },
          ],
        },
      ],
    },
    socialLinks: [{ icon: 'github', link: `https://github.com/${REPO}` }],
    search: { provider: 'local' },
    editLink: {
      pattern: `https://github.com/${REPO}/edit/main/docs/:path`,
      text: locale === 'zh' ? '在 GitHub 上编辑此页' : 'Edit this page on GitHub',
    },
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 Axetroy',
    },
    docFooter: { prev: true, next: true },
  };
}

// Redirect a first visit to the preferred supported locale, preserving the page path.
function localeRedirectScript(base: string): string {
  return `(function(){
  try {
    var key = 'lograil-docs-locale-redirected:' + ${JSON.stringify(base)};
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, '1');
    var languages = navigator.languages || [navigator.language || ''];
    var preferred = languages.find(function(l){ return /^(zh|en)(-|$)/i.test(l || ''); }) || '';
    var locale = /^zh(-|$)/i.test(preferred) ? 'zh' : 'en';
    var b = ${JSON.stringify(base)};
    var path = location.pathname;
    if (path.indexOf(b) !== 0) return;
    var rest = path.slice(b.length);
    var isZh = /^zh(?:\\/|$)/.test(rest);
    if ((locale === 'zh' && isZh) || (locale === 'en' && !isZh)) return;
    if (locale === 'zh') {
      location.replace(b + 'zh/' + rest + location.search + location.hash);
    } else {
      location.replace(b + rest.replace(/^zh\\/?/, '') + location.search + location.hash);
    }
  } catch (e) {}
})();`;
}

export default withMermaid(
  defineConfig({
    title: 'lograil',
    description: 'High-performance, secure logging library for Electron and Web runtimes',
    logo: '/logo.svg',
    // Favicon for the browser tab. Note: VitePress does NOT rewrite `head` hrefs
    // with `base`, so the path must be base-prefixed explicitly. `/lograil/logo.svg`
    // is where public/logo.svg is served.
    head: [['link', { rel: 'icon', href: '/lograil/logo.svg', type: 'image/svg+xml' }]],
    lastUpdated: true,
    cleanUrls: true,
    locales: {
      root: { label: 'English', lang: 'en', themeConfig: themeConfig('en') },
      zh: {
        label: '简体中文',
        lang: 'zh-CN',
        link: '/zh/',
        themeConfig: themeConfig('zh'),
      },
    },
    themeConfig: themeConfig('en'),
    transformHead: (ctx: { site?: { base?: string }; head: unknown[] }) => {
      const base = ctx.site?.base || '/';
      (ctx.head as unknown[]).push(['script', { innerHTML: localeRedirectScript(base) }]);
      return ctx.head;
    },
  }),
);
