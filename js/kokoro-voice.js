import { phonemize } from "./phonemizer.js";
import { configureVoiceWasm, fetchCached, withTimeout } from "./voice-fetch.js?v=2";
import { InferenceSession, Tensor, env } from "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/esm/ort.wasm.min.js";

// Kokoro English voices. Each name is a different 256-number style in a small voice file.
// The speech model downloads once. Heart and Michael were checked against each other: they are not the same recording.
const MODEL_URL = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_quantized.onnx";
const SAMPLE_RATE = 24000;

const KOKORO_VOCAB = {
  "$": 0, ";": 1, ":": 2, ",": 3, ".": 4, "!": 5, "?": 6, "\u2014": 9, "\u2026": 10, "\"": 11,
  "(": 12, ")": 13, "\u201c": 14, "\u201d": 15, " ": 16, "\u0303": 17, "\u02a3": 18, "\u02a5": 19,
  "\u02a6": 20, "\u02a8": 21, "\u1d5d": 22, "\uab67": 23, "A": 24, "I": 25, "O": 31, "Q": 33,
  "S": 35, "T": 36, "W": 39, "Y": 41, "\u1d4a": 42, "a": 43, "b": 44, "c": 45, "d": 46, "e": 47,
  "f": 48, "h": 50, "i": 51, "j": 52, "k": 53, "l": 54, "m": 55, "n": 56, "o": 57, "p": 58,
  "q": 59, "r": 60, "s": 61, "t": 62, "u": 63, "v": 64, "w": 65, "x": 66, "y": 67, "z": 68,
  "\u0251": 69, "\u0250": 70, "\u0252": 71, "\u00e6": 72, "\u03b2": 75, "\u0254": 76, "\u0255": 77,
  "\u00e7": 78, "\u0256": 80, "\u00f0": 81, "\u02a4": 82, "\u0259": 83, "\u025a": 85, "\u025b": 86,
  "\u025c": 87, "\u025f": 90, "\u0261": 92, "\u0265": 99, "\u0268": 101, "\u026a": 102, "\u029d": 103,
  "\u026f": 110, "\u0270": 111, "\u014b": 112, "\u0273": 113, "\u0272": 114, "\u0274": 115, "\u00f8": 116,
  "\u0278": 118, "\u03b8": 119, "\u0153": 120, "\u0279": 123, "\u027e": 125, "\u027b": 126, "\u0281": 128,
  "\u027d": 129, "\u0282": 130, "\u0283": 131, "\u0288": 132, "\u02a7": 133, "\u028a": 135, "\u028b": 136,
  "\u028c": 138, "\u0263": 139, "\u0264": 140, "\u03c7": 142, "\u028e": 143, "\u0292": 147, "\u0294": 148,
  "\u02c8": 156, "\u02cc": 157, "\u02d0": 158, "\u02b0": 162, "\u02b2": 164, "\u2193": 169, "\u2192": 171,
  "\u2197": 172, "\u2198": 173, "\u1d7b": 177,
};

const wasmUrl = configureVoiceWasm(env);

const progressFns = new Set();
const voiceBins = new Map();
let generation = 0;
let loading = null;
let session = null;

function reportProgress(ratio) {
  for (const fn of progressFns) {
    try { fn(ratio); } catch { /* a listener can fail without stopping the voice */ }
  }
}

export function releaseKokoro() {
  generation += 1;
  const current = session;
  session = null;
  loading = null;
  if (current && current.release) current.release().catch(() => {});
}

export async function kokoroSpeech(text, voice, onProgress) {
  if (onProgress) progressFns.add(onProgress);
  try {
    if (session) onProgress?.(1);
    const ready = await loadSession();
    if (!ready) throw new Error("Voice load stopped.");
    const samples = await speakWith(ready, text, voice, onProgress);
    return { samples, rate: SAMPLE_RATE };
  } finally {
    if (onProgress) progressFns.delete(onProgress);
  }
}

function loadSession() {
  if (session) return Promise.resolve(session);
  if (!loading) {
    const gen = generation;
    loading = fetchCached(MODEL_URL, (ratio) => reportProgress(ratio * 0.8)).then(async (buffer) => {
      await fetchCached(wasmUrl, (ratio) => reportProgress(0.8 + ratio * 0.17));
      reportProgress(1);
      const created = await withTimeout(openSession(buffer), 40000, "The voice did not start.");
      if (gen !== generation) {
        created.release?.().catch(() => {});
        return null;
      }
      session = created;
      return created;
    }).catch((err) => {
      if (gen === generation) loading = null;
      throw err;
    });
  }
  return loading;
}

async function openSession(modelBuffer) {
  const bytes = modelBuffer instanceof Uint8Array ? modelBuffer : new Uint8Array(modelBuffer);
  return InferenceSession.create(bytes, {
    executionProviders: ["wasm"],
    executionMode: "sequential",
    graphOptimizationLevel: "disabled",
  });
}

async function voiceStyle(voice, onProgress) {
  let data = voiceBins.get(voice);
  if (!data) {
    const url = `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/${voice}.bin`;
    const buffer = await fetchCached(url, (ratio) => onProgress?.(0.98 + ratio * 0.02));
    data = new Float32Array(buffer);
    voiceBins.set(voice, data);
  } else {
    onProgress?.(1);
  }
  return data;
}

function tidyPhonemes(ipa, american) {
  let said = ipa
    .replace(/kəkˈoːɹoʊ/g, "kˈoʊkəɹoʊ")
    .replace(/kəkˈɔːɹəʊ/g, "kˈəʊkəɹəʊ")
    .replace(/ʲ/g, "j")
    .replace(/r/g, "ɹ")
    .replace(/x/g, "k")
    .replace(/ɬ/g, "l")
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, " ")
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, "z");
  if (american) said = said.replace(/(?<=nˈaɪn)ti(?!ː)/g, "di");
  return said.trim();
}

function tokenIds(phonemes) {
  const ids = [0];
  for (const ch of phonemes) {
    const id = KOKORO_VOCAB[ch];
    if (id !== undefined) ids.push(id);
    if (ids.length >= 510) break;
  }
  ids.push(0);
  return ids;
}

async function speakWith(ready, text, voice, onProgress) {
  const chunks = String(text || "").split(/[.!?]+/).map((part) => part.trim()).filter(Boolean);
  if (!chunks.length) throw new Error("Nothing to say.");
  const pieces = [];
  for (const chunk of chunks) {
    pieces.push(await speakChunk(ready, chunk, voice, onProgress));
  }
  const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
  const combined = new Float32Array(total);
  let offset = 0;
  for (const piece of pieces) {
    combined.set(piece, offset);
    offset += piece.length;
  }
  if (!combined.length) throw new Error("That voice made no sound.");
  return combined;
}

async function speakChunk(ready, chunk, voice, onProgress) {
  const american = !String(voice).startsWith("b");
  const lines = await withTimeout(phonemize(chunk, american ? "en-us" : "en"), 15000, "The voice did not start.");
  const phonemes = tidyPhonemes((Array.isArray(lines) ? lines : [String(lines || "")]).join(" "), american);
  const ids = tokenIds(phonemes);
  if (ids.length < 3) throw new Error("Could not pronounce that.");
  const packed = await voiceStyle(voice, onProgress);
  const index = Math.min(Math.max(ids.length - 2, 0), 509);
  const style = packed.slice(index * 256, index * 256 + 256);
  if (style.length !== 256) throw new Error("Voice data is the wrong size.");
  const feeds = {
    input_ids: new Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    style: new Tensor("float32", new Float32Array(style), [1, 256]),
    speed: new Tensor("float32", new Float32Array([1]), [1]),
  };
  const results = await ready.run(feeds);
  const audio = results.waveform?.data;
  if (!audio || !audio.length) throw new Error("That voice made no sound.");
  return new Float32Array(audio);
}
