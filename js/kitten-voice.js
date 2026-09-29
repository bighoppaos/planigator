let loading = null;
let engine = null;

export function loadKitten() {
  if (engine) return Promise.resolve(engine);
  if (!loading) {
    loading = import("https://esm.sh/kitten-tts-js@0.1.2").then((mod) => (
      mod.KittenTTS.from_pretrained("KittenML/kitten-tts-nano-0.8")
    )).then((tts) => {
      engine = tts;
      return tts;
    });
  }
  return loading;
}

export async function kittenSpeech(text, voice) {
  const tts = await loadKitten();
  const audio = await tts.generate(text, { voice, speed: 1 });
  return {
    samples: audio.data,
    rate: audio.sampling_rate || 24000,
  };
}
