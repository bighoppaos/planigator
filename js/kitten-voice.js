import { phonemize } from "./kitten/speak.js";
import { TextCleaner } from "./kitten/text-cleaner.js";
import { TextPreprocessor } from "./kitten/preprocess.js";
import { loadNpz } from "./kitten/npz-loader.js";
import { fetchCached } from "./voice-fetch.js";
import { InferenceSession, Tensor, env } from "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/esm/ort.wasm.min.js";

// The phone plays this through the page audio mixer, so a song keeps going.
// Each name is a different row in voices.npz. Robot is separate and is not handled here.
const MODEL_URL = "https://huggingface.co/KittenML/kitten-tts-nano-0.8-int8/resolve/main/kitten_tts_nano_v0_8.onnx";
const VOICES_URL = "https://huggingface.co/KittenML/kitten-tts-nano-0.8-int8/resolve/main/voices.npz";
const WASM_ROOT = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/";
const SAMPLE_RATE = 24000;
const AUDIO_TRIM = 5000;
const MAX_CHUNK_CHARS = 400;

const VOICE_ALIASES = {
  Bella: "expr-voice-2-f",
  Jasper: "expr-voice-2-m",
  Luna: "expr-voice-3-f",
  Bruno: "expr-voice-3-m",
  Rosie: "expr-voice-4-f",
  Hugo: "expr-voice-4-m",
  Kiki: "expr-voice-5-f",
  Leo: "expr-voice-5-m",
};

const SPEED_PRIORS = {
  "expr-voice-2-f": 0.8,
  "expr-voice-2-m": 0.8,
  "expr-voice-3-m": 0.8,
  "expr-voice-3-f": 0.8,
  "expr-voice-4-m": 0.9,
  "expr-voice-4-f": 0.8,
  "expr-voice-5-m": 0.8,
  "expr-voice-5-f": 0.8,
};

const cleaner = new TextCleaner();
const preprocessor = new TextPreprocessor({ remove_punctuation: false });

const progressFns = new Set();
let generation = 0;
let loading = null;
let engine = null;

env.wasm.wasmPaths = WASM_ROOT;
env.wasm.numThreads = 1;
env.wasm.simd = true;
env.wasm.proxy = false;

function reportProgress(ratio) {
  for (const fn of progressFns) {
    try { fn(ratio); } catch { /* a listener can fail without stopping the voice */ }
  }
}

export function releaseKitten() {
  generation += 1;
  const current = engine;
  engine = null;
  loading = null;
  if (current && current.release) current.release().catch(() => {});
}

export function loadKitten() {
  if (engine) return Promise.resolve(engine);
  if (!loading) {
    const gen = generation;
    loading = buildEngine().then((ready) => {
      if (gen !== generation) {
        ready?.release?.().catch(() => {});
        return null;
      }
      engine = ready;
      return ready;
    }).catch((err) => {
      if (gen === generation) loading = null;
      throw err;
    });
  }
  return loading;
}

export async function kittenSpeech(text, voice, onProgress) {
  if (onProgress) progressFns.add(onProgress);
  try {
    if (engine) onProgress?.(1);
    const ready = await loadKitten();
    if (!ready) throw new Error("Voice load stopped.");
    const samples = await ready.speak(text, voice);
    return { samples, rate: SAMPLE_RATE };
  } finally {
    if (onProgress) progressFns.delete(onProgress);
  }
}

async function buildEngine() {
  const modelBuffer = await fetchCached(MODEL_URL, (ratio) => reportProgress(ratio * 0.9));
  const voicesBuffer = await fetchCached(VOICES_URL, (ratio) => reportProgress(0.9 + ratio * 0.1));
  const voices = await loadNpz(voicesBuffer);
  const session = await openSession(modelBuffer);
  reportProgress(1);
  return {
    speak(text, voice) {
      return speakWith(session, voices, text, voice);
    },
    release() {
      return Promise.resolve(session.release?.());
    },
  };
}

async function openSession(modelBuffer) {
  try {
    env.wasm.simd = true;
    return await InferenceSession.create(modelBuffer, { executionProviders: ["wasm"] });
  } catch (err) {
    env.wasm.simd = false;
    try {
      return await InferenceSession.create(modelBuffer, { executionProviders: ["wasm"] });
    } catch {
      throw err;
    }
  }
}

function ensurePunctuation(text) {
  let t = text.trim();
  if (!t) return t;
  const last = t[t.length - 1];
  if (![".", "!", "?", ",", ";", ":"].includes(last)) t += ",";
  return t;
}

function chunkText(text) {
  const chunks = [];
  for (const part of String(text || "").split(/[.!?]+/)) {
    const sentence = part.trim();
    if (!sentence) continue;
    if (sentence.length <= MAX_CHUNK_CHARS) {
      chunks.push(ensurePunctuation(sentence));
      continue;
    }
    const words = sentence.split(/\s+/);
    let temp = "";
    for (const word of words) {
      if (temp.length + word.length + 1 <= MAX_CHUNK_CHARS) {
        temp += temp ? ` ${word}` : word;
      } else {
        if (temp) chunks.push(ensurePunctuation(temp.trim()));
        temp = word;
      }
    }
    if (temp) chunks.push(ensurePunctuation(temp.trim()));
  }
  return chunks;
}

function voiceKey(name) {
  const key = VOICE_ALIASES[name] || name;
  return key;
}

async function speakWith(session, voices, text, voiceName) {
  const key = voiceKey(voiceName);
  const voiceEntry = voices[key];
  if (!voiceEntry) {
    throw new Error(`${voiceName || "That voice"} is not in the voice file.`);
  }
  const chunks = chunkText(text);
  if (!chunks.length) throw new Error("Nothing to say.");
  const pieces = [];
  for (const chunk of chunks) {
    pieces.push(await speakChunk(session, voiceEntry, key, chunk));
  }
  const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
  const combined = new Float32Array(total);
  let offset = 0;
  for (const piece of pieces) {
    combined.set(piece, offset);
    offset += piece.length;
  }
  if (!combined.length) throw new Error(`${voiceName} made no sound.`);
  return combined;
}

async function speakChunk(session, voiceEntry, key, chunk) {
  const processed = preprocessor.process(chunk);
  const phonemes = await phonemize(processed);
  const tokenIds = cleaner.clean(phonemes);
  if (tokenIds.length < 3) throw new Error("Could not pronounce that.");
  const [numStyles, styleDim] = voiceEntry.shape;
  const refId = Math.min(tokenIds.length, numStyles - 1);
  const style = voiceEntry.data.slice(refId * styleDim, (refId + 1) * styleDim);
  if (style.length !== styleDim) throw new Error("Voice data is the wrong size.");
  const speed = SPEED_PRIORS[key] || 1;
  const feeds = {
    input_ids: new Tensor("int64", BigInt64Array.from(tokenIds.map(BigInt)), [1, tokenIds.length]),
    style: new Tensor("float32", new Float32Array(style), [1, styleDim]),
    speed: new Tensor("float32", new Float32Array([speed]), [1]),
  };
  const results = await session.run(feeds);
  const audio = results.waveform?.data;
  if (!audio || !audio.length) throw new Error("That voice made no sound.");
  return new Float32Array(audio.slice(0, Math.max(0, audio.length - AUDIO_TRIM)));
}
