import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import type { Account } from '@workbench/types';
import { workbenchHref } from './links';

const navigation = [
  ['/', '概览'],
  ['/articles', '内容'],
  ['/read', '阅读库'],
  ['/import', '导入'],
  ['/taxonomy', '分类管理'],
  ['/interfaces', '只读接口'],
  ['/connections/mcp', 'ChatGPT 连接'],
] as const;
export function CmsLayout({ account, children }: { account: Account; children: ReactNode }) {
  return (
    <div className="cms-site-shell">
      <header className="site-masthead">
        <div className="site-masthead-inner">
          <Link to="/" className="site-brand" aria-label="知声首页">
            <span className="site-brand-icon">文</span>
            <span>
              知声<small>ZHISHENG · CONTENT DESK</small>
            </span>
          </Link>
          <div className="site-user-links">
            <a
              href={workbenchHref()}
              target="_blank"
              rel="noopener noreferrer"
              className="site-workbench-link"
            >
              语音工作台 ↗
            </a>
            <Link to="/account" className="site-account">
              <span className="site-avatar">{[...account.displayName][0]}</span>
              <span>{account.displayName}</span>
            </Link>
          </div>
        </div>
        <nav className="site-navigation" aria-label="知声导航">
          {navigation.map(([url, label]) => (
            <NavLink
              key={url}
              to={url}
              end={url === '/'}
              id={url === '/read' ? 'cmsRead' : undefined}
            >
              {label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main id="mainContent" className="site-main" tabIndex={-1}>
        <div className="cms-page" id="cmsView">
          {children}
        </div>
      </main>
      <footer className="site-footer">
        <span>知声 · 记录、整理、发布</span>
        <span>日文原文 / 固定发布 / 私人阅读</span>
      </footer>
    </div>
  );
}
