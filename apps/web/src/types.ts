export interface Account {
  id: string;
  login: string;
  displayName: string;
}
export interface Rule {
  id: string;
  word: string;
  reading: string;
  revision: number;
}
export interface RuleSet {
  items: Rule[];
  version: number;
  total: number;
}
export interface Voice {
  id: string;
  name: string;
}
export interface PublicConfig {
  registrationOpen: boolean;
  maxText: number;
  maxBytes: number;
}
export interface SpeechInput {
  text: string;
  voice: string;
  speed: number;
}
export interface MediaResult {
  blob: Blob;
  filename: string;
  version: number;
  requestId?: string;
}
export interface Services {
  configuration(): Promise<PublicConfig>;
  session(): Promise<Account | null>;
  login(login: string, password: string): Promise<Account>;
  register(login: string, password: string, displayName: string): Promise<void>;
  updateAccount(displayName: string): Promise<Account>;
  logout(): Promise<void>;
  rules(): Promise<RuleSet>;
  saveRule(
    rule: Pick<Rule, 'word' | 'reading'>,
    existing?: Rule,
  ): Promise<{ entry: Rule; version: number }>;
  deleteRule(rule: Rule): Promise<{ version: number }>;
  voices(): Promise<Voice[]>;
  synthesize(input: SpeechInput): Promise<MediaResult>;
  preview(input: {
    word: string;
    reading: string;
    voice: string;
    speed: number;
  }): Promise<MediaResult>;
}
export class ServiceError extends Error {
  constructor(
    message: string,
    public code = '',
    public requestId?: string,
  ) {
    super(message);
  }
}
export const messageOf = (error: unknown) =>
  error instanceof ServiceError
    ? error.message + (error.requestId ? ` 请求编号：${error.requestId}` : '')
    : error instanceof Error
      ? error.message
      : '操作未能完成，请重试。';
