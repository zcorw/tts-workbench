import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  ServiceError,
  messageOf,
  type Account,
  type Services,
  type RuleSet,
  type Rule,
} from './types';
import { ServiceContext, ErrorNotice } from './components/shared';
import { useArticleDocument } from './useArticleDocument';
import { ArticlesPage } from './components/ArticlesPage';
import { AuthPage } from './components/AuthPage';
import { Layout, pages, type Page } from './components/Layout';
import { Workspace } from './components/Workspace';
import { RulesPage } from './components/RulesPage';
import { AccountPage } from './components/AccountPage';
import { RuleDialog, DeleteRuleDialog, type RuleIntent } from './components/RuleDialogs';
import { HelpDialog } from './components/ArticleDialog';
import type { AudioResult } from './components/AudioPlayer';
const empty: RuleSet = { items: [], version: 0, total: 0 };
export function App({ services }: { services: Services }) {
  const client = useQueryClient(),
    location = useLocation(),
    navigateTo = useNavigate();
  const path = location.pathname.replace(/^\//, '') || 'articles';
  const configuration = useQuery({ queryKey: ['config'], queryFn: () => services.configuration() });
  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => services.session(),
    enabled: configuration.isSuccess,
    refetchInterval: 60000,
  });
  const account = session.data || null;
  const config = configuration.data || {
    registrationOpen: false,
    maxText: 10000,
    maxBytes: 49152,
    maxArticles: 100,
  };
  const booting = configuration.isPending || (configuration.isSuccess && session.isPending),
    bootError = configuration.error || session.error;
  const [notice, setNotice] = useState(''),
    [toast, setToast] = useState('');
  const ruleQuery = useQuery({
    queryKey: ['rules', account?.id],
    queryFn: () => services.rules(),
    enabled: !!account,
  });
  const voiceQuery = useQuery({
    queryKey: ['voices', account?.id],
    queryFn: () => services.voices(),
    enabled: !!account,
  });
  const set = ruleQuery.data || empty,
    rulesLoading = !!account && ruleQuery.isPending,
    rulesError = ruleQuery.error ? messageOf(ruleQuery.error) : '';
  const voices = voiceQuery.data || [],
    voiceLoading = !!account && voiceQuery.isPending,
    voiceError = voiceQuery.error ? messageOf(voiceQuery.error) : '';
  const [voice, setVoice] = useState(''),
    [speed, setSpeed] = useState(1);
  const [busy, setBusy] = useState(false),
    [generationError, setGenerationError] = useState(''),
    [result, setResult] = useState<AudioResult | null>(null);
  const [intent, setIntent] = useState<RuleIntent | null>(null),
    [deleting, setDeleting] = useState<Rule | null>(null),
    [help, setHelp] = useState(false);
  const owner = useRef<string | null>(null),
    previousOwner = useRef<string | null>(null),
    request = useRef(0),
    returnPage = useRef('articles'),
    lastArticlePage = useRef('articles'),
    documentNavigation = useRef(() => {}),
    previewAudio = useRef<HTMLAudioElement | null>(null),
    previewUrl = useRef<string | null>(null),
    busyLock = useRef(false);
  owner.current = account?.id || null;
  const navigate = useCallback(
    (p: string) => navigateTo('/' + (p === 'workbench' ? lastArticlePage.current : p)),
    [navigateTo],
  );
  const setAccount = (u: Account | null) => client.setQueryData(['session'], u);
  const hadAccount = useRef(false);
  const notify = useCallback((m: string) => setToast(m), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 5000);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(
    () => () => {
      if (result) URL.revokeObjectURL(result.url);
    },
    [result?.url],
  );
  const stopPreview = () => {
    previewAudio.current?.pause();
    previewAudio.current = null;
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = null;
  };
  const clearAudio = () => {
    request.current++;
    setBusy(false);
    busyLock.current = false;
    setResult(null);
    stopPreview();
  };
  const expire = useCallback(() => {
    request.current++;
    setBusy(false);
    busyLock.current = false;
    setResult(null);
    stopPreview();
    hadAccount.current = false;
    client.setQueryData(['session'], null);
    client.removeQueries({ queryKey: ['rules'] });
    client.removeQueries({ queryKey: ['voices'] });
    setIntent(null);
    setDeleting(null);
    setHelp(false);
    documentNavigation.current();
    setNotice('登录已失效，请重新登录。当前正文仍保留在此页面。');
    navigate('login');
  }, [client, navigate]);
  const failed = useCallback(
    (e: unknown) => {
      if (e instanceof ServiceError && e.code === 'SESSION') expire();
      if (e instanceof ServiceError && e.code === 'REVISION_CONFLICT')
        void client.invalidateQueries({ queryKey: ['rules'] });
    },
    [expire, client],
  );
  const doc = useArticleDocument(services, account?.id, failed);
  documentNavigation.current = doc.allowNavigation;
  const article = doc.draft;
  if (doc.active) lastArticlePage.current = path;
  const audioScope = useRef({ articleId: '', accountId: account?.id });
  useEffect(() => {
    const previous = audioScope.current;
    if (
      previous.accountId !== account?.id ||
      !(previous.articleId === 'new' && doc.saved?.id === doc.routeId)
    )
      clearAudio();
    audioScope.current = { articleId: doc.routeId, accountId: account?.id };
    setIntent(null);
  }, [doc.routeId, account?.id]);
  const refreshRules = async () => {
    await ruleQuery.refetch({ throwOnError: true });
  };
  const loadVoices = async () => {
    await voiceQuery.refetch();
  };
  const boot = async () => {
    await configuration.refetch();
    await session.refetch();
  };
  useLayoutEffect(() => {
    if (account) {
      if (previousOwner.current && previousOwner.current !== account.id) {
        clearAudio();
        setIntent(null);
        setDeleting(null);
      }
      hadAccount.current = true;
      previousOwner.current = account.id;
    } else if (session.isSuccess && hadAccount.current) expire();
  }, [account?.id, session.isSuccess, expire]);
  useEffect(() => {
    if (ruleQuery.error) failed(ruleQuery.error);
    if (voiceQuery.error) failed(voiceQuery.error);
  }, [ruleQuery.error, voiceQuery.error, failed]);
  useEffect(() => {
    setVoice((v) => (voices.some((x) => x.id === v) ? v : voices[0]?.id || ''));
  }, [voiceQuery.data]);
  const saveConfirmed = (result: { entry: Rule; version: number }) => {
    const id = owner.current;
    if (!id) return;
    client.setQueryData<RuleSet>(['rules', id], (old) => {
      if (old && old.version > result.version) return old;
      const items = old?.items || [];
      const exists = items.some((r) => r.id === result.entry.id);
      return {
        items: exists
          ? items.map((r) => (r.id === result.entry.id ? result.entry : r))
          : [...items, result.entry],
        version: result.version,
        total: exists ? items.length : items.length + 1,
      };
    });
    void client.invalidateQueries({ queryKey: ['rules', id] });
  };
  const deleteConfirmed = (version: number) => {
    if (!deleting || !owner.current) return;
    client.setQueryData<RuleSet>(['rules', owner.current], (old) => {
      if (old && old.version > version) return old;
      const items = (old?.items || []).filter((r) => r.id !== deleting.id);
      return { items, total: items.length, version };
    });
    setIntent(null);
    void client.invalidateQueries({ queryKey: ['rules', owner.current] });
  };
  const page: Page = doc.active ? 'workbench' : path in pages ? (path as Page) : 'articles';
  if (!account && (path in pages || doc.active)) returnPage.current = path;
  useEffect(() => {
    document.title = `${account ? pages[page] : path === 'register' ? '创建账户' : '登录'} · YOMI`;
  }, [account, page, path]);
  const signature = (version: number) =>
    JSON.stringify([article.text, voice, speed, account?.id, version]);
  async function loggedIn(u: Account) {
    if (previousOwner.current && previousOwner.current !== u.id) {
      clearAudio();
      returnPage.current = 'articles';
      lastArticlePage.current = 'articles';
    }
    previousOwner.current = u.id;
    owner.current = u.id;
    client.removeQueries({ queryKey: ['rules'] });
    client.removeQueries({ queryKey: ['voices'] });
    client.removeQueries({ queryKey: ['articles'] });
    client.removeQueries({ queryKey: ['article'] });
    setAccount(u);
    setNotice('');
    navigate(returnPage.current);
  }
  async function logout() {
    await services.logout();
    clearAudio();
    hadAccount.current = false;
    setAccount(null);
    client.removeQueries({ queryKey: ['rules'] });
    client.removeQueries({ queryKey: ['voices'] });
    client.removeQueries({ queryKey: ['articles'] });
    client.removeQueries({ queryKey: ['article'] });
    returnPage.current = 'articles';
    lastArticlePage.current = 'articles';
    navigate('login');
    notify('已退出登录。');
  }
  async function generate() {
    if (busyLock.current || !account) return;
    if (doc.saving) return;
    if (doc.dirty || !doc.saved) {
      if (!(await doc.save())) return;
    }
    busyLock.current = true;
    setBusy(true);
    setGenerationError('');
    const token = ++request.current,
      id = account.id,
      input = { text: article.text, voice, speed },
      time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    try {
      const media = await services.synthesize(input);
      if (request.current !== token || owner.current !== id) return;
      if (media.version !== set.version) void client.invalidateQueries({ queryKey: ['rules', id] });
      setResult({
        url: URL.createObjectURL(media.blob),
        filename: media.filename,
        version: media.version,
        signature: JSON.stringify([input.text, input.voice, input.speed, id, media.version]),
        count: [...input.text].length,
        speed: input.speed,
        time,
        requestId: media.requestId,
      });
    } catch (e) {
      if (request.current === token) {
        setGenerationError(messageOf(e));
        failed(e);
      }
    } finally {
      if (request.current === token) {
        setBusy(false);
        busyLock.current = false;
      }
    }
  }
  async function fetchPreview(word: string, reading: string, saved = false) {
    const id = owner.current;
    stopPreview();
    const media = saved
      ? await services.synthesize({ text: word, voice, speed })
      : await services.preview({ word, reading, voice, speed });
    if (owner.current !== id) return;
    previewUrl.current = URL.createObjectURL(media.blob);
    const audio = new Audio(previewUrl.current);
    previewAudio.current = audio;
    audio.onended = stopPreview;
    audio.onerror = () => {
      notify('试听未能播放，请重试。');
      stopPreview();
    };
    try {
      await audio.play();
      notify('正在试听读法。');
    } catch {
      stopPreview();
      throw Error('音频未能播放，请重试。');
    }
  }
  const previewMutation = useMutation({
    mutationFn: (input: { word: string; reading: string; saved: boolean }) =>
      fetchPreview(input.word, input.reading, input.saved),
    retry: false,
    onError: failed,
  });
  const preview = (word: string, reading: string, saved = false) =>
    previewMutation.mutateAsync({ word, reading, saved });
  const openReading = (word: string) => {
    if (rulesLoading || rulesError) {
      notify('请先加载个人读法，再进行修改。');
      return;
    }
    setIntent({ word, rule: set.items.find((r) => r.word === word), contextual: true });
  };
  return (
    <ServiceContext.Provider value={{ services, notify, failed }}>
      <a
        className="skip-link"
        href="#mainContent"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById(account ? 'mainContent' : 'authName')?.focus();
        }}
      >
        跳到主要内容
      </a>
      {!account ? (
        <AuthPage
          mode={path === 'register' ? 'register' : 'login'}
          config={config}
          onLogin={loggedIn}
          onMode={navigate}
          notice={notice}
          loading={booting}
          loadError={bootError ? messageOf(bootError) : ''}
          onRetry={() => void boot()}
        />
      ) : (
        <Layout
          account={account}
          count={set.total}
          page={page}
          onNavigate={navigate}
          onHelp={() => setHelp(true)}
        >
          {(page === 'articles' || (page === 'workbench' && !doc.active)) && (
            <ArticlesPage
              key={account.id}
              accountId={account.id}
              maxArticles={config.maxArticles}
            />
          )}
          {page === 'workbench' && doc.active && !doc.ready && (
            <section className="view">
              <p role="status">{doc.loading ? '正在加载文章…' : ''}</p>
              <ErrorNotice message={doc.loadError} />
              <button className="button secondary" onClick={doc.retry}>
                重新加载文章
              </button>
              <button className="text-button" onClick={() => navigate('articles')}>
                返回我的文章
              </button>
            </section>
          )}
          {page === 'workbench' && doc.active && doc.ready && (
            <Workspace
              {...article}
              onTitle={(title) => doc.edit({ ...article, title })}
              isNew={doc.routeId === 'new'}
              onSave={() => void doc.save()}
              saving={doc.saving}
              saveStatus={
                doc.saving
                  ? '正在保存…'
                  : doc.dirty
                    ? '有未保存修改'
                    : doc.saved
                      ? '已保存到我的文章'
                      : '尚未创建'
              }
              saveError={doc.error}
              onReload={doc.conflict ? doc.confirmReload : undefined}
              set={set}
              voices={voices}
              voice={voice}
              speed={speed}
              onText={(text) => doc.edit({ ...article, text })}
              onSelect={openReading}
              onCopy={() => {
                navigator.clipboard
                  .writeText(article.text)
                  .then(() => notify('原文已复制。'))
                  .catch(() => notify('复制失败，请选中正文后使用复制快捷键。'));
              }}
              onNew={() => navigate('articles/new')}
              onVoice={setVoice}
              onSpeed={setSpeed}
              voiceLoading={voiceLoading}
              voiceError={voiceError}
              rulesLoading={rulesLoading}
              rulesError={rulesError}
              maxText={config.maxText}
              maxBytes={config.maxBytes}
              onRefreshVoices={() => void loadVoices()}
              onRefreshRules={() => void refreshRules().catch(() => {})}
              onGenerate={() => void generate()}
              busy={busy}
              result={result}
              stale={!!result && result.signature !== signature(set.version)}
              error={generationError}
            />
          )}
          {page === 'rules' && (
            <RulesPage
              set={set}
              text={article.text}
              onAdd={() => setIntent({ contextual: false })}
              onEdit={(rule) => setIntent({ rule, contextual: false })}
              onDelete={setDeleting}
              onPreview={(r) => {
                preview(r.word, r.reading, true).catch((e) => {
                  notify(messageOf(e));
                  failed(e);
                });
              }}
              canPreview={!!voice && !previewMutation.isPending}
              loading={rulesLoading}
              error={rulesError}
              onRetry={() => void refreshRules().catch(() => {})}
            />
          )}
          {page === 'account' && (
            <AccountPage
              account={account}
              count={set.total}
              onUpdate={setAccount}
              onLogout={logout}
            />
          )}
        </Layout>
      )}
      {intent && account && (
        <RuleDialog
          intent={intent}
          count={article.text.split(intent.rule?.word || intent.word || '\0').length - 1}
          voices={voices}
          voice={voice}
          onClose={() => setIntent(null)}
          onSaved={saveConfirmed}
          onDelete={setDeleting}
          onPreview={preview}
        />
      )}
      {deleting && account && (
        <DeleteRuleDialog
          rule={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={deleteConfirmed}
        />
      )}
      {doc.dialogs}
      {help && account && <HelpDialog onClose={() => setHelp(false)} />}
      {toast && (
        <div id="toast" className="toast" role="status">
          {toast}
        </div>
      )}
    </ServiceContext.Provider>
  );
}
