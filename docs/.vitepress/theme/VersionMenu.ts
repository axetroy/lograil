import { defineComponent, onMounted, ref, h } from 'vue';
import { useData } from 'vitepress';

/**
 * Version switcher for historical docs.
 *
 * Each tagged release is published to `/<repo>/<tag>/` (see the `docs.yml`
 * GitHub Actions workflow). `versions.json` is generated at build time from
 * `git tag` and lists every available version, so readers can jump between
 * them. The current version is derived from `import.meta.env.BASE_URL`, and the
 * current locale (e.g. `zh`) is preserved when navigating.
 */
export default defineComponent({
  name: 'VersionMenu',
  setup() {
    const versions = ref<string[]>([]);
    const current = ref('');

    const base: string = import.meta.env.BASE_URL || '/';

    onMounted(async () => {
      const parts = base.split('/').filter(Boolean);
      current.value = parts[parts.length - 1] || 'latest';
      try {
        const res = await fetch(`${base}versions.json`);
        if (res.ok) {
          const data = (await res.json()) as string[];
          versions.value = data;
        }
      } catch {
        /* versions.json unavailable (e.g. local dev) — ignore */
      }
    });

    function onChange(event: Event): void {
      const value = (event.target as HTMLSelectElement).value;
      if (!value) return;
      const repo = base.split('/').filter(Boolean)[0] ?? '';

      // Preserve the active locale (`zh`) if present in the current path.
      const rest = window.location.pathname.slice(base.length);
      const localeSeg = rest.split('/').filter(Boolean)[0];
      const locale = localeSeg === 'zh' ? 'zh/' : '';

      window.location.href = `/${repo}/${value}/${locale}`;
    }

    return () =>
      h(
        'select',
        {
          class: 'vp-version-menu',
          title: 'Documentation version',
          onChange,
          style:
            'margin-left: 0.75rem; background: transparent; border: 1px solid var(--vp-c-divider); border-radius: 8px; padding: 2px 6px; color: var(--vp-c-text-1);',
        },
        [
          h('option', { value: '', disabled: true }, current.value || 'version'),
          ...versions.value.map((v) => h('option', { value: v, selected: v === current.value }, v)),
        ],
      );
  },
});
