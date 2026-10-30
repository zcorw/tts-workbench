// Public runtime addresses only; private document data stays in the API/session.
type SiteConfig = { workbenchUrl: string; cmsUrl: string | null };
let configuration: SiteConfig | undefined;

function publicOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      return undefined;
    return url.origin + '/';
  } catch {
    return undefined;
  }
}

export async function loadSiteConfig() {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch('/site-config.json', {
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok || !response.headers.get('Content-Type')?.includes('application/json')) return;
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object') return;
    const data = value as Record<string, unknown>;
    const workbenchUrl = publicOrigin(data.workbenchUrl);
    const cmsUrl = data.cmsUrl === null ? null : publicOrigin(data.cmsUrl);
    if (workbenchUrl && cmsUrl !== undefined) configuration = { workbenchUrl, cmsUrl };
  } catch {
    // Legacy API and Vite previews have no runtime endpoint. Their explicit VITE
    // addresses remain supported; a container-supplied null never falls back.
  } finally {
    window.clearTimeout(timeout);
  }
}

export function siteAddress(site: 'workbench' | 'cms', configured?: string) {
  if (configuration)
    return (site === 'cms' ? configuration.cmsUrl : configuration.workbenchUrl) ?? undefined;
  if (configured) return publicOrigin(configured);
  if (['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname))
    return site === 'cms' ? 'http://127.0.0.1:4384/' : 'http://127.0.0.1:4382/';
  return undefined;
}
