// eSpeak voices that ship with the page. They talk through the same mixer as the rest of the site.
const VOICE_FILES = ["en-us.json", "en-rp.json", "en-sc.json", "en-n.json"];

let ready = null;

export function warmPageVoices() {
  if (!ready) ready = boot();
  return ready;
}

async function boot() {
  const meMod = await import("./mespeak/index.js");
  const me = meMod.default;
  const base = new URL("./mespeak/", import.meta.url);
  const config = await (await fetch(new URL("mespeak_config.json", base))).json();
  me.loadConfig(config);
  for (const name of VOICE_FILES) {
    const voice = await (await fetch(new URL(name, base))).json();
    me.loadVoice(voice);
  }
  return me;
}

export async function pageSpeech(text, options) {
  const me = await warmPageVoices();
  const bytes = me.speak(String(text || ""), {
    rawdata: "array",
    voice: options.voice,
    variant: options.variant,
    speed: options.speed,
    pitch: options.pitch,
  });
  if (!bytes || !bytes.length) throw new Error("No sound");
  const wav = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  return wavToSamples(wav);
}

function wavToSamples(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rate = view.getUint32(24, true) || 22050;
  let offset = 12;
  while (offset + 8 < bytes.length) {
    const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    const size = view.getUint32(offset + 4, true);
    if (id === "data") {
      const start = offset + 8;
      const count = Math.floor(size / 2);
      const samples = new Float32Array(count);
      for (let i = 0; i < count; i++) samples[i] = view.getInt16(start + i * 2, true) / 32768;
      return { samples, rate };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("No sound");
}
