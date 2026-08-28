import { defineConfig } from 'vitepress';

const REPO = 'axetroy/lograil';

function themeConfig(locale: 'en' | 'zh') {
  const p = locale === 'zh' ? '/zh' : '';
  return {
    nav: [
      { text: locale === 'zh' ? '指南' : 'Guide', link: `${p}/guide/getting-started` },
      { text: 'API', link: `${p}/api/` },
      { text: 'GitHub', link: `https://github.com/${REPO}` },
    ],
    sidebar: {
      [`${p}/guide/`]: [
        {
          text: locale === 'zh' ? '指南' : 'Guide',
          items: [
            { text: locale === 'zh' ? '快速开始' : 'Getting Started', link: `${p}/guide/getting-started` },
            { text: locale === 'zh' ? '配置' : 'Configuration', link: `${p}/guide/configuration` },
            { text: locale === 'zh' ? '传输器' : 'Transports', link: `${p}/guide/transports` },
            { text: locale === 'zh' ? '插件' : 'Plugins', link: `${p}/guide/plugins` },
            { text: locale === 'zh' ? '示例' : 'Examples', link: `${p}/guide/examples` },
            { text: 'Electron', link: `${p}/guide/electron` },
            { text: locale === 'zh' ? '架构' : 'Architecture', link: `${p}/guide/architecture` },
            { text: locale === 'zh' ? '基准测试' : 'Benchmarks', link: `${p}/guide/benchmarks` },
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

// Inject a tiny redirect: zh-preferring browsers landing on the default (en) locale
// are sent to the /zh/ locale, preserving the current page path. This implements
// "default to browser language" for the first visit.
function localeRedirectScript(base: string): string {
  return `(function(){
  try {
    var prefersZh = (navigator.languages || [navigator.language || '']).some(function(l){ return (l||'').toLowerCase().indexOf('zh') === 0; });
    if (!prefersZh) return;
    var b = ${JSON.stringify(base)};
    if (location.pathname.indexOf(b + 'zh') === 0) return;
    var rest = location.pathname.slice(b.length);
    location.replace(b + 'zh/' + rest + location.search + location.hash);
  } catch (e) {}
})();`;
}

export default defineConfig({
  title: 'lograil',
  description: 'High-performance, secure logging library for Electron and Web runtimes',
  logo: '/logo.svg',
  // Favicon for the browser tab. Note: VitePress does NOT rewrite `head` hrefs
  // with `base`, so the path must be base-prefixed explicitly. `/lograil/logo.svg`
  // is where public/logo.svg is served, and it exists in both the latest and the
  // versioned (/<repo>/<tag>/) doc deployments.
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
    (ctx.head as unknown[]).push([
      'script',
      { innerHTML: localeRedirectScript(base) },
    ]);
    return ctx.head;
  },
});
