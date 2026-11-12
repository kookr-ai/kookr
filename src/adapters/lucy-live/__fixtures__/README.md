# Lucy live test fixtures

`speech-16k.wav`: the sentence "Is anything stuck or failing?", synthesised with the Kokoro-82M
voice `af_sky` (Apache-2.0 model; the generated audio carries no third-party voice or recording),
resampled to 16 kHz mono PCM16. Used by `silero-vad.real.test.ts` to check that the real Silero
model scores real speech high. No person's voice was recorded.
