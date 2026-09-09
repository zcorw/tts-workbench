import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { credentialsSchema, registrationSchema, fieldErrors, passwordPolicy } from '../forms';
import { Link } from 'react-router-dom';
import type { Account, PublicConfig } from '../types';
import { Brand, ErrorNotice, useAction, useServices } from './shared';
export function AuthPage({
  mode,
  config,
  onLogin,
  onMode,
  notice,
  loading,
  loadError,
  onRetry,
}: {
  mode: 'login' | 'register';
  config: PublicConfig;
  onLogin: (u: Account) => Promise<void>;
  onMode: (m: 'login' | 'register') => void;
  notice: string;
  loading: boolean;
  loadError: string;
  onRetry: () => void;
}) {
  const { services, notify } = useServices();
  const task = useAction();
  const [show, setShow] = useState(false);
  const form = useForm({
    resolver: zodResolver(
      mode === 'register'
        ? registrationSchema
        : credentialsSchema.extend({ displayName: z.string(), confirm: z.string() }),
    ),
    defaultValues: { login: '', password: '', displayName: '', confirm: '' },
  });
  const register = mode === 'register',
    closed = register && !config.registrationOpen;
  useEffect(() => {
    task.setError();
    form.setValue('password', '');
    form.setValue('confirm', '');
    form.clearErrors();
  }, [mode]);
  return (
    <section id="authView" className="auth-page">
      <div className="auth-story">
        <Brand />
        <div>
          <span className="eyebrow">READ IT YOUR WAY</span>
          <h1>
            文字有原样。
            <br />
            声音，有你的偏好。
          </h1>
          <p lang="ja">ことばを、あなたの読み方で。</p>
          <div className="auth-paper" lang="ja">
            旅の途中で出会った
            <br />
            言葉を、ひとつずつ。
            <br />
            <ruby>
              日本橋<rt>にほんばし</rt>
            </ruby>
            から、次の景色へ。
          </div>
        </div>
        <small>每一次修正，都会留给下一篇文章。</small>
      </div>
      <div className="auth-content">
        <div className="auth-box">
          <span className="eyebrow">YOUR PERSONAL SPACE</span>
          <h1 id="authTitle">
            {closed ? '账户创建暂未开放' : register ? '创建你的空间' : '欢迎回来'}
          </h1>
          <p>
            {closed
              ? '请联系维护者开通账户。'
              : register
                ? '创建账户，保存自己的词汇读法。'
                : '登录账户，继续你的朗读。'}
          </p>
          <ErrorNotice id="sessionNotice" message={notice} />
          <ErrorNotice message={loadError} />
          {loadError && (
            <button className="text-button" onClick={onRetry}>
              重新连接
            </button>
          )}
          {!closed && (
            <form
              id="authForm"
              noValidate
              onSubmit={form.handleSubmit((data) =>
                task.run(async () => {
                  if (register) {
                    await services.register(data.login, data.password, data.displayName);
                    onMode('login');
                    notify('账户已创建，请登录。');
                  } else await onLogin(await services.login(data.login, data.password));
                }),
              )}
            >
              {register && (
                <>
                  <label className="field-label" htmlFor="registerName">
                    显示名称
                  </label>
                  <input
                    id="registerName"
                    required
                    maxLength={40}
                    {...form.register('displayName')}
                    aria-invalid={!!form.formState.errors.displayName}
                    aria-describedby="authError"
                    autoComplete="nickname"
                  />
                </>
              )}
              <label className="field-label" htmlFor="authName">
                账户名称
              </label>
              <input
                id="authName"
                required
                minLength={3}
                maxLength={120}
                {...form.register('login')}
                aria-invalid={!!form.formState.errors.login}
                aria-describedby="authError"
                autoComplete="username"
                placeholder="输入账户名称"
              />
              <label className="field-label" htmlFor="authPassword">
                密码
              </label>
              <div className="password-field">
                <input
                  id="authPassword"
                  required
                  minLength={passwordPolicy.minLength}
                  maxLength={passwordPolicy.maxLength}
                  type={show ? 'text' : 'password'}
                  {...form.register('password')}
                  aria-invalid={!!form.formState.errors.password}
                  aria-describedby="authError"
                  autoComplete={register ? 'new-password' : 'current-password'}
                  placeholder={`至少 ${passwordPolicy.minLength} 位字符`}
                />
                <button
                  type="button"
                  className="text-button"
                  aria-label={show ? '隐藏密码' : '显示密码'}
                  onClick={() => setShow(!show)}
                >
                  {show ? '隐藏' : '显示'}
                </button>
              </div>
              {register && (
                <>
                  <label className="field-label" htmlFor="confirmPassword">
                    确认密码
                  </label>
                  <input
                    id="confirmPassword"
                    required
                    type="password"
                    {...form.register('confirm')}
                    aria-invalid={!!form.formState.errors.confirm}
                    aria-describedby="authError"
                    autoComplete="new-password"
                  />
                </>
              )}
              <ErrorNotice
                id="authError"
                message={task.error || fieldErrors(form.formState.errors)}
              />
              <button
                id="authSubmit"
                className="button primary full"
                disabled={loading || task.busy || !!loadError}
              >
                {task.busy ? '处理中…' : loading ? '正在连接…' : register ? '创建账户' : '登录'}
              </button>
            </form>
          )}
          <p className="auth-switch">
            {register ? (
              <Link to="/login">已有账户？返回登录 →</Link>
            ) : config.registrationOpen ? (
              <Link to="/register">还没有账户？创建账户 →</Link>
            ) : (
              '暂未开放注册，请联系维护者开通账户。'
            )}
          </p>
          <p className="small-note">你的个人读法仅用于自己的文章朗读。</p>
        </div>
      </div>
    </section>
  );
}
