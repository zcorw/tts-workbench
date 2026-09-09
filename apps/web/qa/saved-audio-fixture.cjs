const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const bytes = fs.readFileSync(path.join(__dirname, 'tone.mp3'));
// Deterministic HTTP boundary fixture; never used by the application bundle.
async function savedAudio({
  route,
  state,
  article,
  body,
  method,
  url,
  send,
  error,
  version,
  filename = 'saved.mp3',
}) {
  if (!article) return error('NOT_FOUND', 404);
  if (method === 'POST') {
    assert.deepEqual(Object.keys(body).sort(), ['expectedRevision', 'speed', 'voice']);
    if (article.revision !== body.expectedRevision) return error('REVISION_CONFLICT', 409);
    const seq = (state.nextGeneration = (state.nextGeneration || 0) + 1);
    const revision = article.contentRevision;
    const plan = state.audioPlans?.shift();
    plan?.arrived?.resolve();
    if (plan?.gate) await plan.gate.promise;
    if (state.delayAudio) await new Promise((resolve) => setTimeout(resolve, state.delayAudio));
    if (plan?.fail || state.audioFail) return error('TTS_PROVIDER_ERROR', 502);
    if (revision !== article.contentRevision) return error('ARTICLE_CONTENT_CHANGED', 409);
    state.successful ||= new Map();
    if ((state.successful.get(article.id) || 0) > seq) return error('AUDIO_SUPERSEDED', 409);
    article.audio = {
      audioId: randomUUID(),
      contentRevision: revision,
      ruleVersion: version,
      voice: body.voice,
      speed: body.speed,
      language: 'ja-JP',
      format: 'mp3',
      mimeType: 'audio/mpeg',
      byteLength: bytes.length,
      characterCount: [...article.text].length,
      filename,
      createdAt: new Date().toISOString(),
    };
    state.successful.set(article.id, seq);
    article.currentRuleVersion = state.version ?? version;
    article.audioStale = version !== article.currentRuleVersion;
    if (plan?.lost) return error('DEPENDENCY_UNAVAILABLE', 503);
    return send({
      articleId: article.id,
      revision: article.revision,
      contentRevision: article.contentRevision,
      currentRuleVersion: article.currentRuleVersion,
      audio: article.audio,
      audioStale: article.audioStale,
    });
  }
  if (state.replaceOnGet > 0 && article.audio) {
    state.replaceOnGet--;
    article.audio = {
      ...article.audio,
      audioId: randomUUID(),
      speed: 1.23,
      voice: state.replacementVoice || article.audio.voice,
    };
  }
  const audio = article.audio;
  if (!audio || url.searchParams.get('audioId') !== audio.audioId) return error('NOT_FOUND', 404);
  if (state.audioGetPlan) {
    const plan = state.audioGetPlan;
    state.audioGetPlan = null;
    plan.arrived.resolve();
    await plan.gate.promise;
  }
  const headers = {
    'Content-Type': 'audio/mpeg',
    'Content-Length': String(bytes.length),
    'Content-Disposition': `inline; filename="${audio.filename}"`,
    'X-Audio-Id': audio.audioId,
    'X-Article-Content-Revision': String(audio.contentRevision),
    'X-Pronunciation-Version': String(audio.ruleVersion),
    'X-Request-Id': randomUUID(),
  };
  if (state.badAudio) headers['Content-Type'] = 'application/json';
  if (state.badId) headers['X-Audio-Id'] = randomUUID();
  if (state.badRevision) headers['X-Article-Content-Revision'] = String(audio.contentRevision + 1);
  if (state.badVersion) headers['X-Pronunciation-Version'] = String(audio.ruleVersion + 1);
  if (state.badLength) headers['Content-Length'] = String(bytes.length + 1);
  if (state.badFilename) headers['Content-Disposition'] = 'inline; filename="wrong.mp3"';
  return route.fulfill({ status: 200, headers, body: bytes });
}
module.exports = { savedAudio, bytes };
