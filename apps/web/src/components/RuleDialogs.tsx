import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { readingSchema, fieldErrors } from '../forms';
import type { Rule, Voice } from '../types';
import { ErrorNotice, Modal, useAction, useServices } from './shared';
export interface RuleIntent {
  rule?: Rule;
  word?: string;
  contextual: boolean;
}
export function RuleDialog({
  intent,
  count,
  voices,
  voice,
  onSaved,
  onClose,
  onDelete,
  onPreview,
}: {
  intent: RuleIntent;
  count: number;
  voices: Voice[];
  voice: string;
  onSaved: (result: { entry: Rule; version: number }) => void;
  onClose: () => void;
  onDelete: (r: Rule) => void;
  onPreview: (word: string, reading: string) => Promise<void>;
}) {
  const form = useForm({
    resolver: zodResolver(readingSchema),
    defaultValues: {
      word: intent.rule?.word || intent.word || '',
      reading: intent.rule?.reading || '',
    },
  });
  const reading = form.watch('reading');
  const task = useAction(),
    preview = useAction();
  const { services, notify } = useServices();
  const context = intent.contextual;
  const busy = task.busy || preview.busy;
  return (
    <Modal
      id={context ? 'readingDialog' : 'ruleDialog'}
      title={context ? '修改词汇读法' : intent.rule ? '编辑个人规则' : '添加个人规则'}
      onClose={onClose}
      busy={busy}
      kicker="PERSONAL READING"
    >
      <form
        id={context ? 'readingForm' : 'modalRuleForm'}
        noValidate
        onSubmit={form.handleSubmit((data) =>
          task.run(async () => {
            const result = await services.saveRule(data, intent.rule);
            onSaved(result);
            onClose();
            notify('个人读法已保存，将用于当前及以后的文章。');
          }),
        )}
      >
        <label className="field-label" htmlFor={context ? 'selectedWord' : 'modalWord'}>
          {context ? '原词' : '日文词汇'}
        </label>
        <input
          id={context ? 'selectedWord' : 'modalWord'}
          required
          readOnly={context}
          lang="ja"
          {...form.register('word')}
          aria-invalid={!!form.formState.errors.word}
          aria-describedby={context ? 'saveError' : 'modalRuleError'}
          autoComplete="off"
        />
        <label className="field-label" htmlFor={context ? 'readingInput' : 'modalReading'}>
          指定读法
        </label>
        <input
          id={context ? 'readingInput' : 'modalReading'}
          required
          lang="ja"
          {...form.register('reading')}
          aria-invalid={!!form.formState.errors.reading}
          aria-describedby={context ? 'saveError' : 'modalRuleError'}
          placeholder="例如：にほんばし"
          autoComplete="off"
          autoFocus={context}
        />
        <div className="scope-callout">
          <strong>当前及以后文章都会使用</strong>
          <p>
            {context && (
              <>
                当前正文有 <b id="occurrenceCount">{count}</b> 处匹配。
              </>
            )}
            原文保持不变。
          </p>
        </div>
        {intent.rule && (
          <p className="small-note">
            已有读法：{intent.rule.reading}。保存后将替换这个词的个人默认读法。
          </p>
        )}
        <ErrorNotice
          id={context ? 'saveError' : 'modalRuleError'}
          message={task.error || preview.error || fieldErrors(form.formState.errors)}
        />
        <div className="form-actions">
          <button
            id="previewReading"
            type="button"
            className="text-button"
            disabled={!voices.length || !voice || busy || !reading.trim()}
            onClick={form.handleSubmit((data) =>
              preview.run(() => onPreview(data.word, data.reading)),
            )}
          >
            {preview.busy ? '正在准备试听…' : '试听读法'}
          </button>
          {intent.rule && (
            <button
              id="deleteRuleButton"
              type="button"
              className="text-button danger"
              disabled={busy}
              onClick={() => onDelete(intent.rule!)}
            >
              删除个人规则
            </button>
          )}
        </div>
        <div className="dialog-footer">
          <button
            type="button"
            className="button secondary"
            id={context ? 'cancelRuleButton' : 'cancelModalRule'}
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="button primary"
            id={context ? 'saveRuleButton' : 'modalSave'}
            disabled={busy}
          >
            {task.busy ? '正在保存…' : '保存个人规则'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function DeleteRuleDialog({
  rule,
  onClose,
  onDeleted,
}: {
  rule: Rule;
  onClose: () => void;
  onDeleted: (version: number) => void;
}) {
  const task = useAction();
  const { services, notify } = useServices();
  return (
    <Modal
      id="confirmDialog"
      title="删除这条个人规则？"
      onClose={onClose}
      busy={task.busy}
      kicker="DELETE PERSONAL RULE"
    >
      <p className="dialog-description">
        删除「{rule.word} → {rule.reading}」后，当前及以后文章将恢复音色的默认读法。
      </p>
      <p className="small-note">原文不会删除。已生成的音频保持旧结果。</p>
      <ErrorNotice id="deleteError" message={task.error} />
      <div className="dialog-footer">
        <button
          id="cancelDelete"
          className="button secondary"
          disabled={task.busy}
          onClick={onClose}
        >
          保留规则
        </button>
        <button
          id="confirmDelete"
          className="button danger-button"
          disabled={task.busy}
          onClick={() =>
            task.run(async () => {
              const result = await services.deleteRule(rule);
              onDeleted(result.version);
              onClose();
              notify('个人读法已删除。');
            })
          }
        >
          {task.busy ? '正在删除…' : '删除个人规则'}
        </button>
      </div>
    </Modal>
  );
}
