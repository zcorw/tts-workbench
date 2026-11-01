import { json, mutation } from '@workbench/api/http';
import type { AudioBatch, AudioBatchInput } from './audioBatch';

const root = '/v1/cms/audio-batches';
export const audioBatchHttp = {
  list: () => json<{ items: AudioBatch[] }>(root),
  get: (id: string) => json<AudioBatch>(`${root}/${encodeURIComponent(id)}`),
  create: async (input: AudioBatchInput) =>
    (await mutation(root, 'POST', input)).json() as Promise<AudioBatch>,
  cancel: async (id: string) =>
    (
      await mutation(`${root}/${encodeURIComponent(id)}/cancel`, 'POST', {})
    ).json() as Promise<AudioBatch>,
};
