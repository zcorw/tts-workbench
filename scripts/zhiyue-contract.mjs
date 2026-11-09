// 知阅设备凭据、浏览器会话和媒体票各有独立授权边界。
export function addZhiyueContract(api) {
  api.info.version = '1.6.0';
  api.info.description += ' 知阅 device APIs are opt-in on the HTTPS CMS origin. Device requests use a dedicated binding token or a release-scoped media ticket, and bypass browser Session/Origin/CSRF. Browser pairing approval and binding management retain Session/Origin/CSRF.';

  const str = (extra = {}) => ({ type: 'string', ...extra });
  const integer = (extra = {}) => ({ type: 'integer', ...extra });
  const obj = (properties) => ({
    type: 'object', additionalProperties: false, properties,
    ...(Object.keys(properties).length ? { required: Object.keys(properties) } : {}),
  });
  const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
  const uuid = str({ format: 'uuid' });
  const time = str({ format: 'date-time' });
  const uri = str({ format: 'uri' });
  const secret = str({ pattern: '^[A-Za-z0-9_-]{43}$' });
  const opaqueInput = str({ pattern: '^[A-Za-z0-9_-]{32,128}$' });
  const article = {
    id: { ...uuid, description: 'Article ID, stable across replacement of the current publication.' },
    title: str({ maxLength: 120 }),
    publishedAt: time,
    hasAudio: { type: 'boolean' },
  };
  const schema = api.components.schemas;
  schema.ZhiyueDeviceAuthorization = obj({
    device_code: { ...secret, description: 'Secret polling code. Keep private.' },
    user_code: str({ pattern: '^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$' }),
    verification_uri: { ...uri, description: 'HTTPS browser approval page on the configured CMS origin.' },
    expires_in: integer({ enum: [300], description: 'Device request lifetime in seconds.' }),
    interval: integer({ enum: [5], description: 'Minimum polling interval in seconds.' }),
  });
  schema.ZhiyueDeviceClaim = obj({ device_code: opaqueInput });
  schema.ZhiyueDeviceBinding = obj({
    access_token: { ...secret, description: 'Revocable device credential returned only on successful claim. Never log or include it in URLs.' },
    expires_in: integer({ enum: [86400], description: 'Binding lifetime in seconds (24 hours). No refresh credential.' }),
    account: obj({ id: uuid, displayName: str() }),
    binding_id: uuid,
  });
  schema.ZhiyueDeviceApproval = obj({
    user_code: str({ maxLength: 24, description: 'Eight alphanumeric characters after removing whitespace and hyphens. Case insensitive.' }),
    expected_account_id: { ...uuid, description: 'Must equal the current signed-in account, otherwise 409 ACCOUNT_CHANGED.' },
  });
  schema.ZhiyueBindings = obj({
    items: {
      type: 'array', maxItems: 8,
      items: obj({ id: uuid, createdAt: time, expiresAt: time }),
    },
  });
  schema.ZhiyueArticleItem = obj(article);
  schema.ZhiyueArticlePage = obj({
    items: { type: 'array', maxItems: 20, items: ref('ZhiyueArticleItem') },
    total: integer({ minimum: 0 }),
    limit: integer({ minimum: 1, maximum: 20 }),
    offset: integer({ minimum: 0 }),
  });
  schema.ZhiyueArticle = obj({
    ...article,
    releaseId: { ...uuid, description: 'Current publication ID, used for the audio-ticket request.' },
    text: str({ maxLength: 10000, description: 'Exact published text, at most 49152 UTF-8 bytes.' }),
  });
  schema.ZhiyueAudioTicket = obj({
    url: { ...uri, description: 'Private, short-lived URL for this publication only. Never persist or log it.' },
    expires_in: integer({ minimum: 1, maximum: 150, description: 'Seconds remaining, capped by the binding expiration.' }),
  });
  schema.ZhiyueGrantError = obj({
    error: str({ enum: ['invalid_grant', 'expired_token', 'authorization_pending', 'slow_down', 'invalid_token', 'invalid_request', 'temporarily_unavailable'] }),
  });
  schema.ZhiyueRateLimitError = obj({
    error: str({ enum: ['slow_down'] }),
    code: str({ enum: ['RATE_LIMITED'] }),
    message: str({ enum: ['RATE_LIMITED'] }),
  });
  api.components.securitySchemes.zhiyueDeviceBearer = {
    type: 'http', scheme: 'bearer',
    description: '知阅 opaque 24-hour binding credential. Grants only current published reads for its account, release-scoped media tickets and self-revocation.',
  };

  const json = (value, description = 'Success') => ({
    description, content: { 'application/json': { schema: typeof value === 'string' ? ref(value) : value } },
  });
  const errors = (...names) => ({ oneOf: names.map(ref) });
  const body = (value) => ({
    required: true, content: { 'application/json': { schema: typeof value === 'string' ? ref(value) : value } },
  });
  const empty = (description) => ({ description });
  const path = (name, value = uuid) => ({ name, in: 'path', required: true, schema: value });
  const query = (name, value, required = false) => ({ name, in: 'query', required, schema: value });
  const expectedAccount = query('expected_account_id', schema.ZhiyueDeviceApproval.properties.expected_account_id, true);
  const rateLimit = {
    ...json(errors('ZhiyueRateLimitError', 'ZhiyueGrantError'), 'Request rate or capacity exceeded.'),
    headers: { 'Retry-After': { schema: integer({ enum: [60] }), description: 'Sent for IP rate limiting.' } },
  };
  const common = {
    '404': json('Error', 'Feature disabled, wrong listener, or resource unavailable in the authorized scope.'),
    '429': rateLimit,
    '503': json('Error', 'Dependency unavailable.'),
  };
  const validation = { '400': json('Error', 'Invalid request shape, input or identifier.') };
  const jsonErrors = {
    '413': json('Error', 'JSON request exceeds the route payload limit.'),
    '415': json('Error', 'Expected application/json.'),
  };
  const deviceAuth = [{ zhiyueDeviceBearer: [] }];
  const deviceAuthError = {
    '401': json(errors('Error', 'ZhiyueGrantError'), 'Missing, revoked, expired or inactive binding.'),
  };
  const accountErrors = {
    ...common, ...validation,
    '401': json('Error', 'Browser session missing or expired.'),
    '403': json('Error', 'Origin, CSRF or browser-session authorization rejected.'),
    '409': json('Error', 'ACCOUNT_CHANGED: expected account differs from current session.'),
  };
  const enabled = 'Requires CMS_ZHIYUE_ENABLED=true (default false), the CMS listener and a configured HTTPS CMS origin.';
  const session = 'Uses the current browser session; mutations require the matching Origin and X-CSRF-Token.';
  const route = (suffix, method, operationId, summary, detail, security, responses, extra = {}) => {
    const pathName = `/v1/zhiyue${suffix}`;
    api.paths[pathName] ??= {};
    api.paths[pathName][method] = { operationId, summary, description: `${enabled} ${detail}`, security, ...extra, responses };
  };

  route('/device/authorize', 'post', 'zhiyueDeviceAuthorize', 'Start 知阅 device pairing',
    'An empty JSON object starts a five-minute request. Show only user_code and verification_uri to the user. This route does not use the browser session.', [],
    { '201': json('ZhiyueDeviceAuthorization', 'Pairing request created.'), ...common, ...validation, ...jsonErrors },
    { requestBody: body(obj({})) });
  route('/device/token', 'post', 'zhiyueDeviceClaim', 'Claim an approved 知阅 device binding',
    'Poll with the private device_code no faster than the advertised interval. Approval is required. Successful exchange consumes the request once and returns a 24-hour device binding.', [],
    { '200': json('ZhiyueDeviceBinding'), ...common, ...jsonErrors,
      '400': json(errors('Error', 'ZhiyueGrantError'), 'Invalid request, pending approval, poll too fast, expired request, or consumed code.') },
    { requestBody: body('ZhiyueDeviceClaim') });
  route('/device/binding', 'delete', 'zhiyueDeviceUnbind', 'Revoke the calling 知阅 binding',
    'Revokes the binding and its media tickets. A revoked device must pair again.', deviceAuth,
    { '204': empty('Current binding revoked.'), ...common, ...deviceAuthError });

  route('/read/articles', 'get', 'zhiyueReadArticles', 'List the current published articles of the binding owner',
    'Paged newest-first summaries. Only the account associated with the device binding is read. Article bodies, drafts and audio bytes are omitted from the list.', deviceAuth,
    { '200': json('ZhiyueArticlePage'), ...common, ...validation, ...deviceAuthError },
    { parameters: [query('limit', integer({ minimum: 1, maximum: 20, default: 12 })), query('offset', integer({ minimum: 0, maximum: 9999999, default: 0 }))] });
  route('/read/articles/{id}', 'get', 'zhiyueReadArticle', 'Read the current publication of an owned article',
    'The path id is the article ID. The response contains the frozen publication text and its releaseId.', deviceAuth,
    { '200': json('ZhiyueArticle'), ...common, ...validation, ...deviceAuthError },
    { parameters: [path('id')] });
  route('/read/releases/{id}/audio-ticket', 'post', 'zhiyueIssueAudioTicket', 'Issue a short-lived ticket for published audio',
    'The path id is the release ID. Requires an empty JSON object. The selected release must still be current and have owned audio. The ticket expires after at most 150 seconds.', deviceAuth,
    { '200': json('ZhiyueAudioTicket'), ...common, ...validation, ...deviceAuthError, ...jsonErrors },
    { parameters: [path('id')], requestBody: body(obj({})) });

  const range = { schema: str({ enum: ['bytes'] }) };
  const contentRange = { schema: str(), description: 'HTTP Content-Range for this single range or the unsatisfied byte range.' };
  const mp3 = { 'audio/mpeg': { schema: str({ format: 'binary' }) } };
  route('/media/{ticket}', 'get', 'zhiyueReadAudio', 'Play current published MP3 with a scoped media ticket',
    'The private ticket in the path grants only this release audio and requires a live device binding and an active owner. A withdrawn or replaced publication is unavailable. Supports one byte range, including open-ended and suffix ranges. No device bearer or browser cookie is needed. Response is no-store. Do not log the ticket or the full request path.', [],
    {
      '200': { description: 'Complete MP3.', headers: { 'Accept-Ranges': range }, content: mp3 },
      '206': { description: 'Requested MP3 byte range.', headers: { 'Accept-Ranges': range, 'Content-Range': contentRange }, content: mp3 },
      '416': { description: 'Unsatisfiable, malformed or multiple byte ranges. No body.', headers: { 'Accept-Ranges': range, 'Content-Range': contentRange } },
      ...common, ...validation,
      '401': json('ZhiyueGrantError', 'Ticket invalid, expired, or tied to an inactive or revoked binding.'),
    },
    { parameters: [path('ticket', opaqueInput), { name: 'Range', in: 'header', schema: str({ example: 'bytes=0-1023' }) }] });

  route('/account/bindings', 'get', 'zhiyueListBindings', 'List the signed-in account’s active 知阅 bindings',
    `${session} Lists only live bindings, newest first, with no credential plaintext.`, [{ sessionCookie: [] }],
    { '200': json('ZhiyueBindings'), ...accountErrors }, { parameters: [expectedAccount] });
  route('/account/approve', 'post', 'zhiyueApproveDevice', 'Approve 知阅 device pairing from the signed-in browser',
    `${session} The current account must match expected_account_id. A code already approved by another account, expired, consumed or unknown is rejected.`, [{ sessionCookie: [], csrfHeader: [] }],
    { '204': empty('Code approved for the signed-in account.'), ...accountErrors, ...jsonErrors,
      '400': json('Error', 'Invalid input or INVALID_OR_EXPIRED_CODE.') }, { requestBody: body('ZhiyueDeviceApproval') });
  route('/account/bindings/{id}', 'delete', 'zhiyueRevokeBinding', 'Revoke one 知阅 binding for the signed-in account',
    `${session} Revocation and ticket invalidation take effect immediately. A missing or unrelated binding is ignored.`, [{ sessionCookie: [], csrfHeader: [] }],
    { '204': empty('Owned binding revoked or no matching binding.'), ...accountErrors }, { parameters: [path('id'), expectedAccount] });
}
