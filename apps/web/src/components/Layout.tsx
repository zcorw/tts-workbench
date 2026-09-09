import type { ReactNode } from 'react';
import type { Account } from '../types';
import { Brand } from './shared';
export const pages = {
  articles: '我的文章',
  workbench: '语音工作台',
  rules: '个人读法规则',
  account: '账户与设置',
};
export type Page = keyof typeof pages;
export function Layout({
  account,
  count,
  page,
  onNavigate,
  onHelp,
  children,
}: {
  account: Account;
  count: number;
  page: Page;
  onNavigate: (p: Page) => void;
  onHelp: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <aside className="sidebar">
        <Brand />
        <div className="nav-caption">WORKSPACE</div>
        <nav aria-label="主导航">
          {(Object.keys(pages) as Page[]).map((p, i) => (
            <button
              key={p}
              className={`nav-item ${p === page ? 'active' : ''}`}
              data-view={p}
              aria-current={p === page ? 'page' : undefined}
              onClick={() => onNavigate(p)}
            >
              <span aria-hidden="true">{['▤', '♪', 'あ', '◎'][i]}</span>
              {pages[p]}
              {p === 'rules' && (
                <span className="nav-index" id="navRuleCount">
                  {count}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-guide">
          <span className="tiny-label">READ IT YOUR WAY</span>
          <p>
            保留原文。
            <br />
            让读法，符合你的心意。
          </p>
          <span className="guide-line" />
          <small>让每一次朗读，都更合心意</small>
        </div>
        <div className="sidebar-bottom">
          <button
            id="accountButton"
            className="account-button"
            onClick={() => onNavigate('account')}
          >
            <span className="avatar" id="avatar">
              {[...account.displayName][0]}
            </span>
            <span>
              <strong id="accountName">{account.displayName}</strong>
              <small>个人工作空间</small>
            </span>
            <span className="account-arrow">⌃</span>
          </button>
        </div>
      </aside>
      <div className="app-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            个人工作空间 <span>/</span>
            <strong>{pages[page]}</strong>
          </div>
          <div className="header-actions">
            <span className="language-tag">
              <span />
              日本語
            </span>
            <button
              className="icon-button"
              id="guideButton"
              onClick={onHelp}
              aria-label="打开使用指引"
            >
              ?
            </button>
          </div>
        </header>
        <main id="mainContent" tabIndex={-1}>
          {children}
          <footer className="page-footer">
            <span>
              YOMI <i>·</i> 让文字保留原样，让读法更合心意。
            </span>
          </footer>
        </main>
      </div>
    </>
  );
}
