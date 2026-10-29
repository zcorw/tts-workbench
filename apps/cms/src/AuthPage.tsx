import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { credentialsSchema, passwordPolicy, registrationSchema } from '@workbench/forms';
import { ErrorNotice, useServices } from '@workbench/components/shared';
import { messageOf, type Account, type PublicConfig } from '@workbench/types';

interface AuthPageProps {
  mode: 'login' | 'register';
  config: PublicConfig;
  loading: boolean;
  notice: string;
  loadError: string;
  onRetry: () => void;
  onLogin: (account: Account) => Promise<void>;
}

interface AuthFields {
  login: string;
  password: string;
  displayName: string;
  confirm: string;
}

export function AuthPage({
  mode,
  config,
  loading,
  notice,
  loadError,
  onRetry,
  onLogin,
}: AuthPageProps) {
  const { services, notify, failed } = useServices();
  const navigate = useNavigate();
  const [fields, setFields] = useState<AuthFields>({
    login: '',
    password: '',
    displayName: '',
    confirm: '',
  });
  const [error, setError] = useState('');
  const [invalidFields, setInvalidFields] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const request = useRef(0);
  const pending = useRef(false);
  const register = mode === 'register';
  const closed = register && !loading && !loadError && !config.registrationOpen;
  const disabled = loading || !!loadError || busy;

  useEffect(() => {
    mounted.current = true;
    pending.current = false;
    setBusy(false);
    setError('');
    setInvalidFields([]);
    setFields((current) => ({ ...current, password: '', confirm: '' }));
    return () => {
      mounted.current = false;
      request.current += 1;
      pending.current = false;
    };
  }, [mode]);

  function changeField(field: keyof AuthFields, value: string) {
    setFields((current) => ({ ...current, [field]: value }));
    setError('');
    setInvalidFields([]);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || closed || pending.current) return;

    const parsed = register
      ? registrationSchema.safeParse(fields)
      : credentialsSchema.safeParse(fields);
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join(' '));
      setInvalidFields(parsed.error.issues.map((issue) => String(issue.path[0])));
      return;
    }

    const token = ++request.current;
    const isCurrent = () => mounted.current && request.current === token;
    pending.current = true;
    setBusy(true);
    setError('');
    setInvalidFields([]);
    try {
      const data = parsed.data;
      if (register && 'displayName' in data && typeof data.displayName === 'string') {
        await services.register(data.login, data.password, data.displayName);
        if (!isCurrent()) return;
        setFields((current) => ({ ...current, password: '', confirm: '' }));
        notify('账户已创建，请登录内容库。');
        navigate('/login', { replace: true });
      } else {
        const account = await services.login(data.login, data.password);
        if (!isCurrent()) return;
        setFields((current) => ({ ...current, password: '', confirm: '' }));
        await onLogin(account);
      }
    } catch (cause) {
      if (!isCurrent()) return;
      setError(messageOf(cause));
      failed(cause);
    } finally {
      if (isCurrent()) {
        pending.current = false;
        setBusy(false);
      }
    }
  }

  return (
    <main id="authView" className="site-auth">
      <section className="site-card" aria-labelledby="authTitle">
        <Link to="/login" className="site-brand" aria-label="内容库登录">
          <strong>内容库</strong>
          <span>CONTENT DESK</span>
        </Link>
        <h1 id="authTitle">{closed ? '账户注册暂未开放' : register ? '创建账户' : '登录内容库'}</h1>
        <p>{closed ? '请联系维护者开通账户。' : '管理文章、整理内容，准备下一次发布。'}</p>
        {notice && (
          <p id="sessionNotice" role="status">
            {notice}
          </p>
        )}
        {loading && <p role="status">正在连接内容平台…</p>}
        <ErrorNotice id="authConfigError" message={loadError} />
        {loadError && (
          <button type="button" className="text-button" onClick={onRetry} disabled={loading}>
            重新连接
          </button>
        )}
        {!closed && (
          <form id="authForm" noValidate onSubmit={submit} aria-busy={busy}>
            {register && (
              <div className="site-field">
                <label htmlFor="registerName">显示名称</label>
                <input
                  id="registerName"
                  name="displayName"
                  value={fields.displayName}
                  onChange={(event) => changeField('displayName', event.target.value)}
                  autoComplete="nickname"
                  maxLength={40}
                  required
                  disabled={disabled}
                  aria-invalid={invalidFields.includes('displayName')}
                  aria-describedby="authError"
                />
              </div>
            )}
            <div className="site-field">
              <label htmlFor="authName">账户名称</label>
              <input
                id="authName"
                name="login"
                value={fields.login}
                onChange={(event) => changeField('login', event.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                minLength={3}
                maxLength={120}
                required
                disabled={disabled}
                aria-invalid={invalidFields.includes('login')}
                aria-describedby="authError"
              />
            </div>
            <div className="site-field">
              <label htmlFor="authPassword">密码</label>
              <input
                id="authPassword"
                name="password"
                type="password"
                value={fields.password}
                onChange={(event) => changeField('password', event.target.value)}
                autoComplete={register ? 'new-password' : 'current-password'}
                minLength={passwordPolicy.minLength}
                maxLength={passwordPolicy.maxLength}
                required
                disabled={disabled}
                aria-invalid={invalidFields.includes('password')}
                aria-describedby="authPasswordHint authError"
              />
              <small id="authPasswordHint">
                {passwordPolicy.minLength}–{passwordPolicy.maxLength} 个字符
              </small>
            </div>
            {register && (
              <div className="site-field">
                <label htmlFor="confirmPassword">确认密码</label>
                <input
                  id="confirmPassword"
                  name="confirm"
                  type="password"
                  value={fields.confirm}
                  onChange={(event) => changeField('confirm', event.target.value)}
                  autoComplete="new-password"
                  maxLength={passwordPolicy.maxLength}
                  required
                  disabled={disabled}
                  aria-invalid={invalidFields.includes('confirm')}
                  aria-describedby="authError"
                />
              </div>
            )}
            <ErrorNotice id="authError" message={error} />
            <button id="authSubmit" type="submit" className="button primary" disabled={disabled}>
              {busy ? '正在提交…' : loading ? '正在连接…' : register ? '创建账户' : '登录'}
            </button>
          </form>
        )}
        <p>
          {register ? (
            <Link to="/login">已有账户，返回登录</Link>
          ) : config.registrationOpen ? (
            <Link to="/register">创建账户</Link>
          ) : !loading && !loadError ? (
            '注册暂未开放，请联系维护者开通账户。'
          ) : null}
        </p>
      </section>
    </main>
  );
}
