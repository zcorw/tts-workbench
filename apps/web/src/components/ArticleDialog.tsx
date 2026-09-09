import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { articleSchema, fieldErrors } from '../forms';
import { samples } from '../domain';
import { Modal, ErrorNotice } from './shared';
export function ArticleDialog({
  onClose,
  onApply,
}: {
  onClose: () => void;
  onApply: (a: { title: string; text: string }) => void;
}) {
  const form = useForm({
    resolver: zodResolver(articleSchema),
    defaultValues: { title: '', text: '' },
  });
  const fill = (i: number) => form.reset(samples[i]);
  return (
    <Modal id="articleDialog" title="开始一篇新文章" onClose={onClose} kicker="NEW ARTICLE">
      <p className="dialog-description">替换后，当前文章将不再保留；个人读法不受影响。</p>
      <div className="sample-actions">
        <button id="loadSampleOne" className="button secondary compact" onClick={() => fill(0)}>
          京都的早晨
        </button>
        <button id="loadSampleTwo" className="button secondary compact" onClick={() => fill(1)}>
          旅途的记忆
        </button>
        <button
          id="loadBlank"
          className="text-button"
          onClick={() => form.reset({ title: '', text: '' })}
        >
          清空
        </button>
      </div>
      <form
        noValidate
        onSubmit={form.handleSubmit((data) =>
          onApply({ title: data.title.trim() || '新文章', text: data.text }),
        )}
      >
        <label className="field-label" htmlFor="newArticleTitle">
          文章标题
        </label>
        <input id="newArticleTitle" maxLength={120} {...form.register('title')} />
        <label className="field-label" htmlFor="newArticleText">
          日文正文
        </label>
        <textarea id="newArticleText" rows={7} lang="ja" {...form.register('text')} />
        <ErrorNotice message={fieldErrors(form.formState.errors)} />
        <div className="dialog-footer">
          <button type="button" id="cancelArticle" className="button secondary" onClick={onClose}>
            取消
          </button>
          <button id="applyArticle" className="button primary">
            使用这篇文章
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function HelpDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal id="guideDialog" title="让朗读更合心意" onClose={onClose}>
      <ol className="guide-list">
        <li>
          <b>输入文章，生成并聆听</b>
          <p>选择日文音色，调整适合自己的语速。</p>
        </li>
        <li>
          <b>直接在正文选中词汇</b>
          <p>用鼠标、触屏或 Shift + 方向键选择文字，再点击“修改读法”。</p>
        </li>
        <li>
          <b>保存读法，再次朗读</b>
          <p>同词共用一个个人读法，当前和以后文章都会采用。修改后需要重新生成。</p>
        </li>
      </ol>
    </Modal>
  );
}
