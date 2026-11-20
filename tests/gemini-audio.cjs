'use strict';

// This test intentionally runs without a Gemini key. It verifies the media
// metadata contract and the safe no-key behavior; it never calls Meta or
// Gemini and never contains a credential.
process.env.GEMINI_API_KEY = '';
const {
  extractInboundMedia,
  extractGeminiGeneratedText,
  normalizeGeminiAudioMimeType,
  transcribeWhatsAppAudioWithGemini
} = require('../index.js');

async function main() {
  const audio = extractInboundMedia({
    type: 'audio',
    audio: { id: 'media-test-1', mime_type: 'audio/ogg; codecs=opus' }
  });
  if (!audio || audio.media_id !== 'media-test-1' || audio.media_type !== 'audio') {
    throw new Error('Inbound audio metadata was not extracted');
  }
  if (normalizeGeminiAudioMimeType(audio.media_mime_type) !== 'audio/ogg') {
    throw new Error('Audio MIME type was not normalized');
  }
  const transcript = extractGeminiGeneratedText({
    candidates: [{ content: { parts: [{ text: 'Maza ' }, { text: 'Corolla 2022' }] } }]
  });
  if (transcript !== 'Maza Corolla 2022') throw new Error('Gemini text extraction failed');

  const disabled = await transcribeWhatsAppAudioWithGemini({
    mediaId: 'media-test-1',
    accessToken: 'never-used-in-no-key-test',
    mimeType: 'audio/ogg'
  });
  if (disabled.status !== 'not_configured' || disabled.text !== '') {
    throw new Error('Audio transcription must fail safe when no key is configured');
  }
  console.log('Gemini audio contract checks passed.');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
