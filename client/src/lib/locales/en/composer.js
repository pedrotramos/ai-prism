// English UI catalog — composer: message composer and voice overlay.
// Namespaces owned by this file: composer.*, voice.*.
// Same keys in pt/, en/ and es/; merged by ../index.js (see ../catalogs.test.js).
export default {
  // composer
  'composer.listening': 'Listening… speak now',
  'composer.placeholder': 'Ask something, or attach a document…',
  'composer.attach': 'Attach documents',
  'composer.attachMedia': 'Attach documents, images, audio or video',
  'composer.segmenting': 'Preparing audio ({name}) — part {done} of {total}…',
  'composer.dictate': 'Dictate (speech to text)',
  'composer.voiceMode': 'Voice mode — talk with the AI',
  'composer.stop': 'Stop',
  'composer.send': 'Send',
  'composer.disclaimer': "AI can make mistakes. Attachment content is sent in the model's context.",

  // voice overlay
  'voice.listening': 'Listening…',
  'voice.thinking': 'Thinking…',
  'voice.speaking': 'Speaking…',
  'voice.idle': 'Tap to speak',
  'voice.unsupported': 'Speech recognition is not supported in this browser. Use Chrome or Edge.',
  'voice.speakAgain': 'Speak again',
  'voice.end': 'End',
  'voice.footer': 'Voice mode · Powered by Databricks AI Gateway',
}
