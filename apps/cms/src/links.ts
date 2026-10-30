import { siteAddress } from '@workbench/siteConfig';

export function workbenchHref(articleId?: string) {
  const address = siteAddress('workbench', import.meta.env.VITE_WORKBENCH_SITE_URL);
  if (!address) return undefined;
  const url = new URL(address);
  url.hash = articleId ? `/articles/${encodeURIComponent(articleId)}` : '/articles';
  return url.href;
}
