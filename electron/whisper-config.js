'use strict';

// Shared by the packager and desktop process so downloads and bundled models
// always use the same filenames, sizes and upstream LFS SHA-256 digests.
const MODELS = require('./whisper-models.json');
const LANGUAGES = require('./whisper-languages.json');
const DEFAULT_MODEL = 'large-v3-q5_0';
const RUNTIME_REVISION = 'b4938-portable-3';

function getModel(id) {
  const key = Object.hasOwn(MODELS, id) ? id : DEFAULT_MODEL;
  const family = key.replace(/\.en/g, '').replace(/-q\d_\d$/, '');
  const familyName = family.replace(/^./, value => value.toUpperCase()).replace(/-/g, ' ').replace('turbo', 'Turbo');
  return {
    ...MODELS[key], id: key, family,
    name: `Whisper ${familyName}${key.includes('.en') ? ' English' : ''}`,
    englishOnly: key.includes('.en'),
    precision: /-q(\d)_\d$/.test(key) ? `Q${key.match(/-q(\d)_\d$/)[1]}` : 'Original',
    url: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODELS[key].file}`,
  };
}

module.exports = { MODELS, LANGUAGES, DEFAULT_MODEL, RUNTIME_REVISION, getModel };
