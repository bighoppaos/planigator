import { phonemize as espeakng } from "../phonemizer.js";

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PUNCTUATION = ';:,.!?\u00A1\u00BF\u2014\u2026\u0022\u00AB\u00BB\u0022\u0022(){}[]';
const PUNCTUATION_PATTERN = new RegExp(`(\\s*[${escapeRegExp(PUNCTUATION)}]+\\s*)+`, "g");

function splitPreserve(text, regex) {
  const result = [];
  let prev = 0;
  for (const match of text.matchAll(regex)) {
    const fullMatch = match[0];
    if (prev < match.index) {
      result.push({ isPunct: false, text: text.slice(prev, match.index) });
    }
    if (fullMatch.length > 0) {
      result.push({ isPunct: true, text: fullMatch });
    }
    prev = match.index + fullMatch.length;
  }
  if (prev < text.length) {
    result.push({ isPunct: false, text: text.slice(prev) });
  }
  return result;
}

export async function phonemize(text) {
  const chunks = splitPreserve(text, PUNCTUATION_PATTERN);

  let processed = '';
  for (const chunk of chunks) {
    if (chunk.isPunct) {
      processed += chunk.text;
    } else {
      const result = await espeakng(chunk.text, 'en-us');
      const ipa = result ? result.join(' ') : '';
      processed += ipa.replace(/_/g, '').replace(/\n/g, ' ');
    }
  }

  return processed.trim();
}
