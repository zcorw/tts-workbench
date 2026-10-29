import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ErrorNotice, Modal } from '@workbench/components/shared';
import { messageOf } from '@workbench/types';
import { cmsHttp } from './http';
import type { ImportInput, ImportResult } from './types';

const sample = JSON.stringify(
  {
    source: 'manual-json',
    items: [
      {
        externalId: 'example-001',
        title: '日文文章',
        text: '今日は、新しい一日です。',
        slug: 'example-001',
        summary: '',
        categoryId: null,
        tagIds: [],
      },
    ],
  },
  null,
  2,
);
export function CmsImport({
  accountId,
  failed,
}: {
  accountId: string;
  failed: (e: unknown) => void;
}) {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const client = useQueryClient();
  const [input, setInput] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{
    raw: string;
    input: ImportInput;
    result: ImportResult;
  } | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null),
    [confirm, setConfirm] = useState(false);
  const change = (value: string) => {
    setInput(value);
    setPreview(null);
    setResult(null);
    setError('');
    setConfirm(false);
  };
  const inspect = async () => {
    setError('');
    setBusy(true);
    setResult(null);
    setPreview(null);
    try {
      if (new TextEncoder().encode(input).length > 1048576) throw Error('JSON 不能超过 1 MiB。');
      const parsed = JSON.parse(input) as ImportInput;
      if (
        !parsed ||
        typeof parsed.source !== 'string' ||
        !Array.isArray(parsed.items) ||
        !parsed.items.length ||
        parsed.items.length > 20
      )
        throw Error('请提供 source 和 1–20 条 items。');
      const value = await cmsHttp.preview(parsed);
      if (!alive.current) return;
      setPreview({ raw: input, input: parsed, result: value });
    } catch (e) {
      if (!alive.current) return;
      setError(messageOf(e));
      failed(e);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const commit = async () => {
    if (!preview || preview.raw !== input) return;
    setBusy(true);
    setError('');
    try {
      const value = await cmsHttp.import(preview.input, preview.result.items);
      if (!alive.current) return;
      setResult(value);
      setPreview(null);
      setConfirm(false);
      void client.invalidateQueries({ queryKey: ['cms', accountId] });
      void client.invalidateQueries({ queryKey: ['articles', accountId] });
    } catch (e) {
      if (!alive.current) return;
      setError(messageOf(e));
      failed(e);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const shown = result ?? preview?.result;
  return (
    <section>
      <h2>JSON 结构化导入</h2>
      <p>
        手工新建仍可使用。导入只保存草稿，不生成音频或发布；同一 source + externalId
        用于重复导入识别。每次最多 20 条，JSON 最大 1 MiB。
      </p>
      <details>
        <summary>查看格式示例</summary>
        <pre className="cms-json">{sample}</pre>
        <p>categoryId 和 tagIds 使用栏目标签管理中的 ID；未知值会在预览中报错。</p>
      </details>
      <label className="cms-field">
        选择 JSON 文件
        <input
          type="file"
          accept=".json,application/json"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            if (file.size > 1048576) {
              setError('JSON 不能超过 1 MiB。');
              return;
            }
            void file
              .text()
              .then(change)
              .catch((e) => setError(messageOf(e)));
          }}
        />
      </label>
      <label className="cms-field">
        或粘贴 JSON
        <textarea
          id="cmsImportInput"
          rows={14}
          value={input}
          disabled={busy}
          onChange={(e) => change(e.target.value)}
          spellCheck={false}
        />
      </label>
      <ErrorNotice message={error} />
      <div className="cms-actions">
        <button
          id="cmsImportPreview"
          className="button secondary"
          disabled={busy || !input.trim()}
          onClick={() => void inspect()}
        >
          {busy ? '处理中…' : '校验并预览'}
        </button>
        {preview && (
          <button
            id="cmsImportCommit"
            className="button primary"
            disabled={
              busy ||
              preview.raw !== input ||
              preview.result.items.some((i) => i.status === 'error')
            }
            onClick={() => setConfirm(true)}
          >
            确认导入草稿…
          </button>
        )}
      </div>
      {shown && (
        <div className="cms-table-wrap">
          <table className="cms-table">
            <caption>
              {result ? '导入结果；失败项可修正后重新预览' : '预览结果；修改 JSON 后必须重新预览'}
            </caption>
            <thead>
              <tr>
                <th>外部 ID</th>
                <th>状态</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {shown.items.map((i, n) => (
                <tr key={`${i.externalId}/${n}`}>
                  <td>{i.externalId}</td>
                  <td>
                    {(
                      {
                        create: '拟新建',
                        update: '拟更新',
                        created: '已新建',
                        updated: '已更新',
                        unchanged: '无变化',
                        error: '错误',
                      } as Record<string, string>
                    )[i.status] ?? i.status}
                  </td>
                  <td>
                    {i.errors
                      ?.map((e) => (typeof e === 'string' ? e : JSON.stringify(e)))
                      .join('；') || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {confirm && preview && (
        <Modal
          id="cmsImportConfirm"
          title="导入这些草稿？"
          busy={busy}
          onClose={() => setConfirm(false)}
        >
          <p>
            将按预览版本处理 {preview.result.items.length}{' '}
            条记录。并发修改会返回逐条冲突，不会自动覆盖，也不会付费生成或发布。
          </p>
          <div className="dialog-footer">
            <button className="button secondary" disabled={busy} onClick={() => setConfirm(false)}>
              继续检查
            </button>
            <button
              id="cmsImportConfirmSubmit"
              className="button primary"
              disabled={busy}
              onClick={() => void commit()}
            >
              确认导入
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
