// 补齐主分支的批量音频、草稿幂等写入和自动 slug 契约。
const audioPaths = {
  '/v1/cms/audio-batches': {
    get: {
      operationId: 'listAudioBatches',
      summary: 'Restore owned audio batch progress',
      description:
        "Return at most five owned batches, active first and otherwise newest first. Read real persistent item states after navigation or refresh. No article body, provider credential or other account's batch is returned. CMS read-only bearer credentials do not authorize this endpoint.",
      security: [
        {
          sessionCookie: [],
        },
      ],
      responses: {
        200: {
          $ref: '#/components/responses/AudioBatchPageSuccess',
        },
        401: {
          $ref: '#/components/responses/AudioBatchError',
        },
        403: {
          $ref: '#/components/responses/AudioBatchError',
        },
        503: {
          $ref: '#/components/responses/AudioBatchError',
        },
      },
    },
    post: {
      operationId: 'createAudioBatch',
      summary: 'Queue audio for explicitly selected saved drafts',
      description:
        "Admit one to twenty distinct owned articles and at most one active batch per account. requestId is owner-scoped idempotency: an identical replay returns the same batch with 202, a different payload is 409 AUDIO_BATCH_REQUEST_CONFLICT, an active different batch is 409 AUDIO_BATCH_ACTIVE, and an archived key is 409 AUDIO_BATCH_EXPIRED; none of these responses silently starts paid work again. Reuse the existing article/Gateway synthesis path, server-side voice permissions and shared account billable admission budget. Execute with bounded serial work; queued items may wait for admission. Validate each saved revision, expected audio identifier and personal-rule version before synthesis. Use the immutable personal pronunciation snapshot actually admitted. Default skip policy leaves any existing audio, including stale audio, untouched. replace requires explicit user confirmation. A failed item retains old audio; version or audio changes produce a per-item conflict rather than replacing a different draft's audio. This operation never publishes or changes immutable CMS releases/media. A lost create response must be reconciled through list/get or the same requestId, never a new automatic synthesis.",
      security: [
        {
          sessionCookie: [],
          csrfHeader: [],
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/AudioBatchInput',
            },
          },
        },
      },
      responses: {
        202: {
          $ref: '#/components/responses/AudioBatchAccepted',
        },
        400: {
          $ref: '#/components/responses/AudioBatchError',
        },
        401: {
          $ref: '#/components/responses/AudioBatchError',
        },
        403: {
          $ref: '#/components/responses/AudioBatchError',
        },
        404: {
          $ref: '#/components/responses/AudioBatchError',
        },
        409: {
          $ref: '#/components/responses/AudioBatchError',
        },
        429: {
          $ref: '#/components/responses/AudioBatchError',
        },
        503: {
          $ref: '#/components/responses/AudioBatchError',
        },
      },
    },
  },
  '/v1/cms/audio-batches/{id}': {
    get: {
      operationId: 'getAudioBatch',
      summary: 'Read one owned persistent audio batch',
      security: [
        {
          sessionCookie: [],
        },
      ],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: {
            type: 'string',
            format: 'uuid',
          },
        },
      ],
      responses: {
        200: {
          $ref: '#/components/responses/AudioBatchSuccess',
        },
        400: {
          $ref: '#/components/responses/AudioBatchError',
        },
        401: {
          $ref: '#/components/responses/AudioBatchError',
        },
        403: {
          $ref: '#/components/responses/AudioBatchError',
        },
        404: {
          $ref: '#/components/responses/AudioBatchError',
        },
        503: {
          $ref: '#/components/responses/AudioBatchError',
        },
      },
    },
  },
  '/v1/cms/audio-batches/{id}/cancel': {
    post: {
      operationId: 'cancelAudioBatchQueue',
      summary: 'Cancel only batch items that have not started',
      description:
        'Mark still-queued items cancelled. An already running synthesis continues to its real result; cancellation cannot undo requests, generated audio or fees already incurred. Repeat cancellation does not start new work. Return the current owned batch; absent or unowned identifiers are 404. Send a strict empty JSON object.',
      security: [
        {
          sessionCookie: [],
          csrfHeader: [],
        },
      ],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: {
            type: 'string',
            format: 'uuid',
          },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/AudioBatchCancelInput',
            },
          },
        },
      },
      responses: {
        200: {
          $ref: '#/components/responses/AudioBatchSuccess',
        },
        400: {
          $ref: '#/components/responses/AudioBatchError',
        },
        401: {
          $ref: '#/components/responses/AudioBatchError',
        },
        403: {
          $ref: '#/components/responses/AudioBatchError',
        },
        404: {
          $ref: '#/components/responses/AudioBatchError',
        },
        429: {
          $ref: '#/components/responses/AudioBatchError',
        },
        503: {
          $ref: '#/components/responses/AudioBatchError',
        },
      },
    },
  },
};
const audioResponses = {
  AudioBatchAccepted: {
    description: 'Accepted persistent batch, including an identical idempotent replay',
    headers: {
      'X-Request-Id': {
        schema: {
          type: 'string',
          format: 'uuid',
        },
      },
      'Cache-Control': {
        schema: {
          type: 'string',
          enum: ['no-store'],
        },
      },
    },
    content: {
      'application/json': {
        schema: {
          $ref: '#/components/schemas/AudioBatch',
        },
      },
    },
  },
  AudioBatchSuccess: {
    description: 'Owned persistent audio batch and actual per-item states',
    headers: {
      'X-Request-Id': {
        schema: {
          type: 'string',
          format: 'uuid',
        },
      },
      'Cache-Control': {
        schema: {
          type: 'string',
          enum: ['no-store'],
        },
      },
    },
    content: {
      'application/json': {
        schema: {
          $ref: '#/components/schemas/AudioBatch',
        },
      },
    },
  },
  AudioBatchPageSuccess: {
    description: 'At most five owned batches, active first then newest first',
    headers: {
      'X-Request-Id': {
        schema: {
          type: 'string',
          format: 'uuid',
        },
      },
      'Cache-Control': {
        schema: {
          type: 'string',
          enum: ['no-store'],
        },
      },
    },
    content: {
      'application/json': {
        schema: {
          $ref: '#/components/schemas/AudioBatchPage',
        },
      },
    },
  },
  AudioBatchError: {
    description: 'Rejected request or unavailable dependency; inspect code and requestId',
    headers: {
      'X-Request-Id': {
        schema: {
          type: 'string',
          format: 'uuid',
        },
      },
      'Cache-Control': {
        schema: {
          type: 'string',
          enum: ['no-store'],
        },
      },
    },
    content: {
      'application/json': {
        schema: {
          $ref: '#/components/schemas/Error',
        },
      },
    },
  },
};
const audioSchemas = {
  AudioBatchItemInput: {
    type: 'object',
    additionalProperties: false,
    required: [
      'articleId',
      'expectedRevision',
      'expectedAudioId',
      'expectedRuleVersion',
      'voice',
      'speed',
    ],
    properties: {
      articleId: {
        type: 'string',
        format: 'uuid',
      },
      expectedRevision: {
        type: 'integer',
        minimum: 1,
        description: 'Selected saved draft revision; never supplied article body.',
      },
      expectedAudioId: {
        type: 'string',
        format: 'uuid',
        nullable: true,
        description: 'Confirmed current saved audio identifier, or null when no audio exists.',
      },
      expectedRuleVersion: {
        type: 'integer',
        minimum: 0,
        description: 'Confirmed personal pronunciation-rule version.',
      },
      voice: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'Existing permitted public voice alias, not a provider credential.',
      },
      speed: {
        type: 'number',
        minimum: 0.5,
        maximum: 2,
        multipleOf: 0.01,
      },
    },
  },
  AudioBatchInput: {
    type: 'object',
    additionalProperties: false,
    required: ['requestId', 'existingAudio', 'items'],
    properties: {
      requestId: {
        type: 'string',
        format: 'uuid',
        description: 'Stable owner-scoped idempotency identifier for one confirmed payload.',
      },
      existingAudio: {
        type: 'string',
        enum: ['skip', 'replace'],
        description:
          'UI defaults to skip every existing audio, including stale audio. Replace must be explicit.',
      },
      items: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        description:
          'Article identifiers must be distinct. No whole-collection or automatic all-article selection.',
        items: {
          $ref: '#/components/schemas/AudioBatchItemInput',
        },
      },
    },
  },
  AudioBatchCancelInput: {
    type: 'object',
    additionalProperties: false,
    description: 'Strict empty JSON object; cancellation affects only still-queued items.',
  },
  AudioBatchItem: {
    type: 'object',
    additionalProperties: false,
    required: [
      'articleId',
      'title',
      'expectedRevision',
      'expectedAudioId',
      'expectedRuleVersion',
      'voice',
      'speed',
      'status',
    ],
    properties: {
      articleId: {
        type: 'string',
        format: 'uuid',
      },
      title: {
        type: 'string',
      },
      expectedRevision: {
        type: 'integer',
        minimum: 1,
      },
      expectedAudioId: {
        type: 'string',
        format: 'uuid',
        nullable: true,
      },
      expectedRuleVersion: {
        type: 'integer',
        minimum: 0,
      },
      voice: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
      },
      speed: {
        type: 'number',
        minimum: 0.5,
        maximum: 2,
        multipleOf: 0.01,
      },
      status: {
        type: 'string',
        enum: ['queued', 'running', 'succeeded', 'failed', 'skipped', 'cancelled', 'uncertain'],
      },
      errorCode: {
        type: 'string',
        description: 'Safe failure or cancellation code, never a raw provider response or credential.',
      },
      audioId: {
        type: 'string',
        format: 'uuid',
        description: 'Successful saved audio identifier when persistence was confirmed.',
      },
    },
  },
  AudioBatch: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'requestId', 'status', 'createdAt', 'updatedAt', 'items'],
    properties: {
      id: {
        type: 'string',
        format: 'uuid',
      },
      requestId: {
        type: 'string',
        format: 'uuid',
      },
      status: {
        type: 'string',
        enum: ['queued', 'running', 'completed'],
      },
      createdAt: {
        type: 'string',
        format: 'date-time',
      },
      updatedAt: {
        type: 'string',
        format: 'date-time',
      },
      items: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        items: {
          $ref: '#/components/schemas/AudioBatchItem',
        },
      },
    },
  },
  AudioBatchPage: {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        maxItems: 5,
        items: {
          $ref: '#/components/schemas/AudioBatch',
        },
      },
    },
  },
};

export function addCmsAudioBatchContract(api) {
  const { schemas, ...components } = api.components;
  api.components = { ...components, responses: audioResponses, schemas };
  api.paths = Object.fromEntries(
    Object.entries(api.paths).flatMap(([path, item]) =>
      path === '/v1/cms/articles' ? [...Object.entries(audioPaths), [path, item]] : [[path, item]],
    ),
  );
  Object.assign(schemas, audioSchemas);

  const generateAudio = api.paths['/v1/articles/{id}/audio'].post;
  generateAudio.description = generateAudio.description.replace(
    'blank saved text is400 INVALID_REQUEST. Check',
    'blank saved text is400 INVALID_REQUEST. Optional expectedAudioId and expectedRuleVersion add audio and pronunciation guards without changing legacy callers. Check',
  );
  const { expectedRevision, ...synthesisFields } = schemas.ArticleSynthesis.properties;
  schemas.ArticleSynthesis.properties = {
    expectedRevision,
    expectedAudioId: {
      type: 'string',
      format: 'uuid',
      nullable: true,
      description:
        'Optional current-audio guard; mismatch before synthesis or persistence is409 AUDIO_CHANGED.',
    },
    expectedRuleVersion: {
      type: 'integer',
      minimum: 0,
      description:
        'Optional admitted pronunciation-version guard; mismatch before provider call is409 PRONUNCIATION_CHANGED.',
    },
    ...synthesisFields,
  };

  const createArticle = api.paths['/v1/cms/articles'].post;
  createArticle.description =
    "cms.slug may be omitted or blank. Allocate a stable article-<first 12 article UUID hex> slug, with bounded collision suffixes; changing a title never regenerates that slug. A nonblank custom slug is trimmed and must satisfy the existing lowercase ASCII rule. Optional requestId is the article UUID and owner-scoped create idempotency identity. Under the owner lock, an identical normalized replay returns the original detail with201 only while both article.revision and cms.revision are1, the initial created state. In that state, omitted or blank slug means the article's already saved slug, not a new allocation. Any later version evolution, including edits, publishing or changed-then-restored fields, is409 CREATE_REQUEST_CONFLICT even when the current writable fields match. A different payload or an identity owned by another account is also409, never an update or another article. Reconcile the same owned article ID through GET and explicit comparison; do not bypass a create conflict with an automatic save. Omit requestId for legacy create behavior. Invalid custom slugs are400 INVALID_REQUEST, duplicates are409 SLUG_CONFLICT, and exhausted bounded automatic candidates are409 SLUG_ALLOCATION_FAILED with the transaction rolled back. Creating a draft does not publish or alter existing release snapshots or links.";
  createArticle.responses['409'] = {
    ...createArticle.responses['409'],
    description: 'CREATE_REQUEST_CONFLICT / SLUG_CONFLICT / SLUG_ALLOCATION_FAILED / CMS_REFERENCE_CONFLICT',
  };
  api.paths['/v1/cms/articles/{id}'].patch.description =
    'Both expectedRevision and cms.expectedRevision must match in one transaction. Any conflict rolls back both changes. Taxonomy-only saves do not change contentRevision or stale audio. Keep draft on 409; never automatically fetch a new revision and retry a write. Omitted or blank cms.slug preserves the existing article slug; only a workbench article without CMS metadata receives a stable automatic slug on its first CMS save. Title edits never regenerate links. An explicit valid custom slug may change the draft slug; duplicates are409 SLUG_CONFLICT and exhausted automatic candidates are409 SLUG_ALLOCATION_FAILED. Existing published snapshots, RSS entries and fixed release links are unchanged.';
  delete schemas.CmsMetadataInput.required;
  schemas.CmsMetadataInput.properties.slug = {
    type: 'string',
    maxLength: 120,
    pattern: '^\\s*(?:[a-z0-9]+(?:-[a-z0-9]+)*)?\\s*$',
    description:
      'Optional article-write slug. Original input is limited to120 characters, then trimmed. Omitted, empty or whitespace-only input allocates a stable automatic slug on create; nonblank custom input uses the existing lowercase ASCII hyphen rule. This does not relax required slugs for structured imports or taxonomy.',
  };
  schemas.CmsArticleInput.properties = {
    requestId: {
      type: 'string',
      format: 'uuid',
      description:
        'Optional create idempotency identity, used as article.id. Same owner, identity and normalized input return the original detail only while article.revision and cms.revision are both1. Any version evolution, including publishing or edits restored to equal fields, conflicts with409 CREATE_REQUEST_CONFLICT, as do different inputs or another owner. Recovery requires GET of the same owned ID and explicit comparison; never automatic update. In the initial state, omitted or blank slug means the saved slug. Legacy callers may omit requestId.',
    },
    ...schemas.CmsArticleInput.properties,
  };
  const patchMetadata = schemas.CmsArticlePatch.properties.cms;
  patchMetadata.required = patchMetadata.required.filter((field) => field !== 'slug');
  patchMetadata.properties.slug = {
    type: 'string',
    maxLength: 120,
    pattern: '^\\s*(?:[a-z0-9]+(?:-[a-z0-9]+)*)?\\s*$',
    description:
      'Omit or send blank to preserve an existing article slug. If this saved workbench article has no CMS metadata, allocate its stable automatic slug on this first CMS save. Original input is limited to120 characters before trimming. Nonblank custom values retain the lowercase ASCII hyphen rule; changing the title never regenerates the slug.',
  };
}
