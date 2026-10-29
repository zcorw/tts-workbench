const configuredWorkbench = import.meta.env.VITE_WORKBENCH_SITE_URL || 'http://127.0.0.1:4382/';

export function workbenchHref(articleId?: string) {
  const url = new URL(configuredWorkbench, window.location.origin);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('工作台地址必须使用 HTTP 或 HTTPS。');
  }
  url.hash = articleId ? `/articles/${encodeURIComponent(articleId)}` : '/articles';
  return url.href;
}
