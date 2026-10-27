const defaultCmsSite = 'http://127.0.0.1:4384/';

export function cmsSiteHref(articleId?: string) {
  let base: URL;
  try {
    base = new URL(import.meta.env.VITE_CMS_SITE_URL || defaultCmsSite);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password)
      throw new Error('CMS site URL must be a public HTTP(S) address.');
  } catch {
    base = new URL(defaultCmsSite);
  }
  base.hash = '';
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  return articleId ? new URL(`articles/${encodeURIComponent(articleId)}`, base).href : base.href;
}
