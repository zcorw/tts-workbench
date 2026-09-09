import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { profileSchema, fieldErrors } from '../forms';
import type { Account } from '../types';
import { ErrorNotice, PageHeading, useAction, useServices } from './shared';
export function AccountPage({
  account,
  count,
  onUpdate,
  onLogout,
}: {
  account: Account;
  count: number;
  onUpdate: (u: Account) => void;
  onLogout: () => Promise<void>;
}) {
  const form = useForm({
    resolver: zodResolver(profileSchema),
    defaultValues: { displayName: account.displayName },
  });
  const task = useAction(),
    logout = useAction();
  const { services, notify } = useServices();
  useEffect(() => form.reset({ displayName: account.displayName }), [account.displayName]);
  return (
    <section id="accountView" className="view">
      <PageHeading kicker="YOUR SPACE" title="你的账户，你的读法">
        管理显示名称和个人朗读偏好。
      </PageHeading>
      <div className="account-grid">
        <section className="settings-card">
          <h2>账户资料</h2>
          <div className="current-account">
            <span className="avatar large">{[...account.displayName][0]}</span>
            <div>
              <strong id="profileName">{account.displayName}</strong>
              <small>{account.login}</small>
            </div>
          </div>
          <form
            id="profileForm"
            noValidate
            onSubmit={form.handleSubmit((data) =>
              task.run(async () => {
                onUpdate(await services.updateAccount(data.displayName));
                notify('资料已保存。');
              }),
            )}
          >
            <label className="field-label" htmlFor="displayName">
              显示名称
            </label>
            <input
              id="displayName"
              required
              maxLength={40}
              {...form.register('displayName')}
              aria-invalid={!!form.formState.errors.displayName}
              aria-describedby="profileError"
            />
            <ErrorNotice
              id="profileError"
              message={task.error || fieldErrors(form.formState.errors)}
            />
            <button id="profileSave" className="button primary" disabled={task.busy}>
              {task.busy ? '正在保存…' : '保存资料'}
            </button>
          </form>
        </section>
        <section className="settings-card">
          <h2>数据与登录</h2>
          <p className="dialog-description">个人读法随账户保存。当前文章只在此页面保留。</p>
          <dl className="account-details">
            <dt>个人读法</dt>
            <dd>{count} 条</dd>
            <dt>文章</dt>
            <dd>仅在当前页面保留</dd>
            <dt>朗读语言</dt>
            <dd>日本語</dd>
          </dl>
          <ErrorNotice message={logout.error} />
          <button
            className="button secondary"
            id="logoutButton"
            disabled={logout.busy}
            onClick={() => logout.run(onLogout)}
          >
            {logout.busy ? '正在退出…' : '退出登录'}
          </button>
        </section>
      </div>
    </section>
  );
}
