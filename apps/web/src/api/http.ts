import type { components } from './schema';
import { ServiceError, type Services, type Rule, type MediaResult } from '../types';
type Schema = components['schemas'];
let csrf: Schema['Csrf'] | null = null;
let csrfPromise: Promise<string> | null = null;
const errors: Record<string, string> = {
  UNAUTHENTICATED: '登录已失效，请重新登录。',
  CSRF_INVALID: '安全验证已过期，请重试当前操作。',
  REGISTRATION_DISABLED: '暂未开放创建账户，请联系维护者开通。',
  ALREADY_EXISTS: '该账户名称或词汇已存在，请使用其他名称或编辑已有规则。',
  REVISION_CONFLICT: '规则已在另一窗口更新。本次未保存，请关闭后重新打开规则。',
  VOCABULARY_LIMIT: '个人读法已达到数量上限。',
  TTS_UNAVAILABLE: '语音服务暂不可用，请稍后重试或联系维护者。',
  DEPENDENCY_UNAVAILABLE: '服务暂不可用，请稍后重试。',
  TTS_PROVIDER_ERROR: '语音生成失败，请主动重试。',
  TTS_TIMEOUT: '语音生成超时，请主动重试。',
  FORBIDDEN: '没有权限执行此操作。',
  PAYLOAD_TOO_LARGE: '内容超过服务限制，请缩短后重试。',
  INVALID_REQUEST: '输入或参数不符合要求，请检查后重试。',
  NOT_FOUND: '该内容已不存在，请刷新列表。',
};
async function raw(path: string, init: RequestInit = {}, login = false): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: AbortSignal.timeout(120000),
    });
  } catch {
    throw new ServiceError('无法连接服务，请检查网络后重试。');
  }
  if (res.ok) return res;
  let body: Partial<Schema['Error']> = {};
  try {
    body = await res.json();
  } catch {}
  const code = body.code || `HTTP_${res.status}`;
  if (code === 'CSRF_INVALID') {
    csrf = null;
    csrfPromise = null;
  }
  const retryAfter = res.headers.get('Retry-After');
  const message =
    res.status === 401 && login
      ? '账户名称或密码不正确。'
      : res.status === 429
        ? `操作过于频繁，请${retryAfter ? `在 ${retryAfter} 秒后` : '稍后'}重试。`
        : errors[code] || '请求未能完成，请重试。';
  throw new ServiceError(
    message,
    res.status === 401 && !login ? 'SESSION' : code,
    body.requestId || res.headers.get('X-Request-Id') || undefined,
  );
}
async function json<T>(path: string): Promise<T> {
  const r = await raw(path);
  if (!r.headers.get('Content-Type')?.includes('application/json'))
    throw new ServiceError('服务返回格式不正确，请稍后重试。');
  return r.json();
}
async function csrfToken(): Promise<string> {
  if (csrf && Date.parse(csrf.expiresAt) > Date.now() + 5000) return csrf.csrfToken;
  if (!csrfPromise)
    csrfPromise = json<Schema['Csrf']>('/v1/auth/csrf')
      .then((v) => {
        csrf = v;
        return v.csrfToken;
      })
      .finally(() => {
        csrfPromise = null;
      });
  return csrfPromise;
}
async function mutation(path: string, method: string, body?: unknown, login = false) {
  const token = await csrfToken();
  return raw(
    path,
    {
      method,
      headers: {
        'X-CSRF-Token': token,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    login,
  );
}
async function rotated() {
  csrf = null;
  csrfPromise = null;
  await csrfToken().catch(() => {});
}
const rule = (r: Schema['Vocabulary']): Rule => ({
  id: r.id,
  word: r.text,
  reading: r.reading,
  revision: r.revision,
});
async function audio(
  path: string,
  body: Schema['Speech'] | Schema['Preview'],
): Promise<MediaResult> {
  const r = await mutation(path, 'POST', body),
    requestId = r.headers.get('X-Request-Id') || undefined;
  const length = Number(r.headers.get('Content-Length')),
    versionHeader = r.headers.get('X-Pronunciation-Version'),
    version = Number(versionHeader);
  const invalid = () =>
    new ServiceError('收到的音频不完整或格式不正确，请重新生成。', 'INVALID_AUDIO', requestId);
  if (
    r.headers.get('Content-Type')?.split(';')[0].trim() !== 'audio/mpeg' ||
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > 8388608 ||
    versionHeader === null ||
    !Number.isSafeInteger(version) ||
    version < 0
  )
    throw invalid();
  let blob: Blob;
  try {
    blob = await r.blob();
  } catch {
    throw invalid();
  }
  if (blob.size !== length) throw invalid();
  const head = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
  if (
    !(head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) &&
    !(head[0] === 0xff && (head[1] & 0xe0) === 0xe0)
  )
    throw invalid();
  const disposition = r.headers.get('Content-Disposition') || '';
  const filename =
    disposition
      .match(/filename="?([^";]+)"?/i)?.[1]
      ?.split(/[/\\]/)
      .at(-1)
      ?.replace(/[\u0000-\u001f]/g, '') || 'speech.mp3';
  return {
    blob,
    filename: filename.endsWith('.mp3') ? filename : 'speech.mp3',
    version,
    requestId,
  };
}
export const httpServices: Services = {
  async configuration() {
    const c = await json<Schema['Config']>('/v1/config');
    return {
      registrationOpen: c.registrationEnabled,
      maxText: c.maxInputCodePoints,
      maxBytes: c.maxInputBytes,
    };
  },
  async session() {
    try {
      return await json<Schema['Account']>('/v1/auth/me');
    } catch (e) {
      if (e instanceof ServiceError && e.code === 'SESSION') return null;
      throw e;
    }
  },
  async login(login, password) {
    const body = { login, password } satisfies Schema['Credentials'];
    const r = await mutation('/v1/auth/login', 'POST', body, true);
    const account: Schema['Account'] = await r.json();
    await rotated();
    return account;
  },
  async register(login, password, displayName) {
    await mutation('/v1/auth/register', 'POST', {
      login,
      password,
      displayName,
    } satisfies Schema['Register']);
  },
  async updateAccount(displayName) {
    return (
      await mutation('/v1/auth/me', 'PATCH', { displayName } satisfies Schema['AccountPatch'])
    ).json();
  },
  async logout() {
    await mutation('/v1/auth/logout', 'POST');
    await rotated();
  },
  async rules() {
    const p = await json<Schema['VocabularyPage']>('/v1/vocabulary?limit=500&offset=0');
    if (p.items.length !== p.total) throw new ServiceError('个人读法未完整载入，请重新加载。');
    return { items: p.items.map(rule), version: p.internalVersion, total: p.total };
  },
  async saveRule(input, existing) {
    const data = { text: input.word, reading: input.reading } satisfies Schema['VocabularyInput'];
    const r = existing
      ? await mutation(`/v1/vocabulary/${encodeURIComponent(existing.id)}`, 'PATCH', {
          ...data,
          expectedRevision: existing.revision,
        } satisfies Schema['VocabularyPatch'])
      : await mutation('/v1/vocabulary', 'POST', data);
    const body: Schema['VocabularyResult'] = await r.json();
    return { entry: rule(body.entry), version: body.internalVersion };
  },
  async deleteRule(input) {
    const r = await mutation(
      `/v1/vocabulary/${encodeURIComponent(input.id)}?expectedRevision=${input.revision}`,
      'DELETE',
    );
    const header = r.headers.get('X-Pronunciation-Version'),
      version = Number(header);
    if (header === null || !Number.isSafeInteger(version) || version < 0)
      throw new ServiceError('删除已提交，但版本信息缺失，请刷新个人读法。');
    return { version };
  },
  async voices() {
    return (await json<Schema['Voices']>('/v1/voices')).items
      .filter((v) => v.language === 'ja-JP')
      .map((v) => ({ id: v.id, name: v.name }));
  },
  synthesize(input) {
    return audio('/v1/audio/speech', {
      input: input.text,
      voice: input.voice,
      speed: input.speed,
      language: 'ja-JP',
      inputType: 'text',
      format: 'mp3',
    } satisfies Schema['Speech']);
  },
  preview(input) {
    return audio('/v1/audio/preview', {
      text: input.word,
      reading: input.reading,
      voice: input.voice,
      speed: input.speed,
    } satisfies Schema['Preview']);
  },
};
