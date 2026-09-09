import { z } from 'zod';
export const displayNameSchema = z
  .string()
  .trim()
  .min(1, '请填写显示名称。')
  .max(40, '显示名称最多 40 个字符。');
const login = z
  .string()
  .trim()
  .min(3, '账户名称至少 3 个字符。')
  .max(120, '账户名称最多 120 个字符。')
  .regex(/^[A-Za-z0-9@._+-]+$/, '账户名称仅支持字母、数字及 @ . _ + -。');
export const passwordPolicy = { minLength: 8, maxLength: 128 } as const;
const password = z
  .string()
  .min(passwordPolicy.minLength, `密码至少 ${passwordPolicy.minLength} 位。`)
  .max(passwordPolicy.maxLength, `密码最多 ${passwordPolicy.maxLength} 位。`);
export const credentialsSchema = z.object({ login, password });
export const registrationSchema = credentialsSchema
  .extend({ displayName: displayNameSchema, confirm: z.string() })
  .refine((v) => v.password === v.confirm, {
    path: ['confirm'],
    message: '两次输入的密码不一致。',
  });
const readingText = z
  .string()
  .refine((v) => !!v.trim(), '词汇和读法都不能为空。')
  .refine((v) => [...v].length <= 100, '词汇和读法各限 100 个字符。')
  .refine(
    (v) => !/[<>\u0000-\u001f\u007f-\u009f]/u.test(v),
    '请使用单行纯文本，不含控制字符或尖括号。',
  );
export const readingSchema = z.object({ word: readingText, reading: readingText });
export const profileSchema = z.object({ displayName: displayNameSchema });
export const articleSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, '请填写文章标题。')
    .refine((v) => [...v].length <= 120, '标题最多 120 个字符。'),
  text: z
    .string()
    .refine((v) => [...v].length <= 10000, '正文最多 10000 个字符。')
    .refine((v) => new TextEncoder().encode(v).length <= 49152, '正文数据过大，请缩短后保存。')
    .refine(
      (v) => !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(v),
      '正文含有不支持的控制字符。',
    ),
});
export const fieldErrors = (errors: Record<string, unknown>): string =>
  Object.values(errors)
    .map((e) => (e as { message?: string })?.message || '')
    .filter(Boolean)
    .join(' ');
