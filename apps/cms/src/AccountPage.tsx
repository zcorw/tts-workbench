import { useEffect, useRef, useState, type FormEvent } from 'react';
import { profileSchema } from '@workbench/forms';
import { ErrorNotice, useServices } from '@workbench/components/shared';
import { messageOf, type Account } from '@workbench/types';

interface AccountPageProps {
  account: Account;
  onUpdate: (account: Account) => void;
  onLogout: () => Promise<void>;
}

export function AccountPage({ account, onUpdate, onLogout }: AccountPageProps) {
  const { services, notify, failed } = useServices();
  const [displayName, setDisplayName] = useState(account.displayName);
  const [busy, setBusy] = useState<'save' | 'logout' | null>(null);
  const [error, setError] = useState('');
  const mounted = useRef(false);
  const generation = useRef(0);
  const pending = useRef(false);
  const currentAccountId = useRef(account.id);
  currentAccountId.current = account.id;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      pending.current = false;
    };
  }, []);

  useEffect(() => {
    generation.current += 1;
    pending.current = false;
    setDisplayName(account.displayName);
    setError('');
    setBusy(null);
  }, [account.id, account.displayName]);

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;

    const parsed = profileSchema.safeParse({ displayName });
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join(' '));
      return;
    }

    const request = ++generation.current;
    const accountId = account.id;
    const isCurrent = () =>
      mounted.current && generation.current === request && currentAccountId.current === accountId;
    pending.current = true;
    setBusy('save');
    setError('');

    try {
      const updated = await services.updateAccount(parsed.data.displayName);
      if (!isCurrent()) return;
      setDisplayName(updated.displayName);
      onUpdate(updated);
      notify('账户资料已保存。');
    } catch (cause) {
      if (!isCurrent()) return;
      setError(messageOf(cause));
      failed(cause);
    } finally {
      if (isCurrent()) {
        pending.current = false;
        setBusy(null);
      }
    }
  }

  async function logout() {
    if (pending.current) return;
    const request = ++generation.current;
    const accountId = account.id;
    const isCurrent = () =>
      mounted.current && generation.current === request && currentAccountId.current === accountId;
    pending.current = true;
    setBusy('logout');
    setError('');

    try {
      await onLogout();
    } catch (cause) {
      if (!isCurrent()) return;
      setError(messageOf(cause));
    } finally {
      if (isCurrent()) {
        pending.current = false;
        setBusy(null);
      }
    }
  }

  return (
    <section id="accountView" className="site-card" aria-labelledby="accountTitle">
      <header>
        <p className="eyebrow">CONTENT DESK</p>
        <h1 id="accountTitle">账户设置</h1>
        <p>管理内容库中的个人资料。</p>
      </header>

      <div className="site-field">
        <span>登录账户</span>
        <p>{account.login}</p>
      </div>

      <form onSubmit={saveProfile} noValidate aria-busy={busy === 'save'}>
        <div className="site-field">
          <label htmlFor="displayName">显示名称</label>
          <input
            id="displayName"
            name="displayName"
            autoComplete="nickname"
            value={displayName}
            onChange={(event) => {
              setDisplayName(event.target.value);
              setError('');
            }}
            maxLength={40}
            required
            disabled={busy !== null}
            aria-describedby="displayNameHelp accountError"
          />
          <small id="displayNameHelp">用于内容库中的账户展示，最多 40 个字符。</small>
        </div>

        <ErrorNotice id="accountError" message={error} />
        <button
          id="profileSave"
          className="button primary"
          type="submit"
          disabled={busy !== null || displayName.trim() === account.displayName}
        >
          {busy === 'save' ? '保存中…' : '保存资料'}
        </button>
      </form>

      <p>内容、发布记录和账户资料由平台保存。</p>
      <button
        id="logoutButton"
        className="button secondary"
        type="button"
        disabled={busy !== null}
        onClick={() => void logout()}
      >
        {busy === 'logout' ? '正在退出…' : '退出登录'}
      </button>
    </section>
  );
}
