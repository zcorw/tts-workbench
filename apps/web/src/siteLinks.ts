import { siteAddress } from './siteConfig';

export function cmsSiteHref(articleId?: string) {
  const address = siteAddress('cms', import.meta.env.VITE_CMS_SITE_URL);
  if (!address) return undefined;
  const base = new URL(address);
  return articleId ? new URL(`articles/${encodeURIComponent(articleId)}`, base).href : base.href;
}
