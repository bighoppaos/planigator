/**
 * TextPreprocessor: normalizes raw text before phonemization.
 * Direct 1:1 port of KittenTTS Python preprocess.py
 */

const _ONES = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen"];
const _TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const _SCALE = ["", "thousand", "million", "billion", "trillion"];

const _ORDINAL_EXCEPTIONS = {
  "one": "first", "two": "second", "three": "third", "four": "fourth",
  "five": "fifth", "six": "sixth", "seven": "seventh", "eight": "eighth",
  "nine": "ninth", "twelve": "twelfth",
};

const _CURRENCY_SYMBOLS = {
  "$": "dollar", "€": "euro", "£": "pound", "¥": "yen",
  "₹": "rupee", "₩": "won", "₿": "bitcoin",
};

const _ROMAN = [
  [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"],
  [100, "C"], [90, "XC"], [50, "L"], [40, "XL"],
  [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]
];

const _RE_ROMAN = /\b(M{0,4})(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})\b/g;

function _three_digits_to_words(n) {
  if (n === 0) return "";
  const parts = [];
  const hundreds = Math.floor(n / 100);
  const remainder = n % 100;
  if (hundreds) parts.push(`${_ONES[hundreds]} hundred`);

  if (remainder < 20) {
    if (remainder) parts.push(_ONES[remainder]);
  } else {
    const tens_word = _TENS[Math.floor(remainder / 10)];
    const ones_word = _ONES[remainder % 10];
    parts.push(ones_word ? `${tens_word}-${ones_word}` : tens_word);
  }
  return parts.join(" ");
}

export function number_to_words(n) {
  if (typeof n !== 'number') n = parseInt(n, 10);
  if (isNaN(n)) return "";
  if (n === 0) return "zero";
  if (n < 0) return `negative ${number_to_words(-n)}`;

  if (n >= 100 && n <= 9999 && n % 100 === 0 && n % 1000 !== 0) {
    const hundreds = Math.floor(n / 100);
    if (hundreds < 20) return `${_ONES[hundreds]} hundred`;
  }

  const parts = [];
  let tempN = n;
  for (let i = 0; i < _SCALE.length; i++) {
    const scale = _SCALE[i];
    const chunk = tempN % 1000;
    if (chunk) {
      const chunk_words = _three_digits_to_words(chunk);
      parts.push(scale ? `${chunk_words} ${scale}`.trim() : chunk_words);
    }
    tempN = Math.floor(tempN / 1000);
    if (tempN === 0) break;
  }
  return parts.reverse().join(" ");
}

export function float_to_words(value, decimal_sep = "point") {
  const text = String(value);
  const negative = text.startsWith("-");
  let val_str = negative ? text.substring(1) : text;

  let result;
  if (val_str.includes(".")) {
    const [int_part, dec_part] = val_str.split(".", 2);
    const int_words = int_part ? number_to_words(parseInt(int_part, 10)) : "zero";
    const digit_map = ["zero", ..._ONES.slice(1, 10)];
    const dec_words = dec_part.split("").map(d => digit_map[parseInt(d, 10)]).join(" ");
    result = `${int_words} ${decimal_sep} ${dec_words}`;
  } else {
    result = number_to_words(parseInt(val_str, 10));
  }
  return negative ? `negative ${result}` : result;
}

export function roman_to_int(s) {
  const val = { "I": 1, "V": 5, "X": 10, "L": 50, "C": 100, "D": 500, "M": 1000 };
  let result = 0;
  let prev = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    const curr = val[s[i].toUpperCase()];
    result += curr >= prev ? curr : -curr;
    prev = curr;
  }
  return result;
}

// Regexes
const _RE_URL = /https?:\/\/\S+|www\.\S+/g;
const _RE_EMAIL = /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/gi;
const _RE_HASHTAG = /#\w+/g;
const _RE_MENTION = /@\w+/g;
const _RE_HTML = /<[^>]+>/g;
const _RE_PUNCT = /[^\p{L}\p{M}\p{N}\s.,?!;:\-\u2014\u2013\u2026]/gu;
const _RE_SPACES = /\s+/g;
const _RE_NUMBER = /(?<![a-zA-Z])-?[\d,]+(?:\.\d+)?/g;
const _RE_ORDINAL = /\b(\d+)(st|nd|rd|th)\b/gi;
const _RE_PERCENT = /(-?[\d,]+(?:\.\d+)?)\s*%/g;
const _RE_CURRENCY = /([$€£¥₹₩₿])\s*([\d,]+(?:\.\d+)?)\s*([KMBT])?(?![a-zA-Z\d])/g;
const _RE_TIME = /\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?\b/gi;
const _RE_RANGE = /(?<!\w)(\d+)-(\d+)(?!\w)/g;
const _RE_MODEL_VER = /\b([a-zA-Z][a-zA-Z0-9]*)-(\d[\d.]*)(?=[^\d.]|$)/g;
const _RE_UNIT = /(\d+(?:\.\d+)?)\s*(km|kg|mg|ml|gb|mb|kb|tb|hz|khz|mhz|ghz|mph|kph|°[cCfF]|[cCfF]°|ms|ns|µs)\b/gi;
const _RE_SCALE = /(?<![a-zA-Z])(\d+(?:\.\d+)?)\s*([KMBT])(?![a-zA-Z\d])/g;
const _RE_SCI = /(?<![a-zA-Z\d])(-?\d+(?:\.\d+)?)[eE]([+-]?\d+)(?![a-zA-Z\d])/g;
const _RE_FRACTION = /\b(\d+)\s*\/\s*(\d+)\b/g;
const _RE_DECADE = /\b(\d{1,3})0s\b/gi;
const _RE_LEAD_DEC = /(?<!\d)\.([\d])/g;

// Helpers
function _ordinal_suffix(n) {
  const word = number_to_words(n);
  let prefix = "", last = word, joiner = "";
  if (word.includes("-")) {
    const idx = word.lastIndexOf("-");
    prefix = word.substring(0, idx);
    last = word.substring(idx + 1);
    joiner = "-";
  } else if (word.includes(" ")) {
    const idx = word.lastIndexOf(" ");
    prefix = word.substring(0, idx);
    last = word.substring(idx + 1);
    joiner = " ";
  }

  let last_ord;
  if (_ORDINAL_EXCEPTIONS[last]) {
    last_ord = _ORDINAL_EXCEPTIONS[last];
  } else if (last.endsWith("t")) {
    last_ord = last + "h";
  } else if (last.endsWith("e")) {
    last_ord = last.slice(0, -1) + "th";
  } else {
    last_ord = last + "th";
  }
  return prefix ? `${prefix}${joiner}${last_ord}` : last_ord;
}

export class TextPreprocessor {
  constructor(options = {}) {
    this.config = {
      lowercase: true,
      replace_numbers: true,
      replace_floats: true,
      expand_contractions: true,
      expand_model_names: true,
      expand_ordinals: true,
      expand_percentages: true,
      expand_currency: true,
      expand_time: true,
      expand_ranges: true,
      expand_units: true,
      expand_scale_suffixes: true,
      expand_scientific_notation: true,
      expand_fractions: true,
      expand_decades: true,
      expand_phone_numbers: true,
      expand_ip_addresses: true,
      normalize_leading_decimals: true,
      expand_roman_numerals: false,
      remove_urls: true,
      remove_emails: true,
      remove_html: true,
      remove_hashtags: false,
      remove_mentions: false,
      remove_punctuation: true,
      remove_stopwords: false,
      normalize_unicode: true,
      remove_accents: false,
      remove_extra_whitespace: true,
      ...options
    };
  }

  process(text) {
    let t = text;
    const cfg = this.config;

    if (cfg.normalize_unicode) t = t.normalize("NFC");
    if (cfg.remove_html) t = t.replace(_RE_HTML, " ");
    if (cfg.remove_urls) t = t.replace(_RE_URL, "").trim();
    if (cfg.remove_emails) t = t.replace(_RE_EMAIL, "").trim();
    if (cfg.remove_hashtags) t = t.replace(_RE_HASHTAG, "");
    if (cfg.remove_mentions) t = t.replace(_RE_MENTION, "");

    if (cfg.expand_contractions) {
      const contractions = [
        [/\bcan't\b/gi, "cannot"], [/\bwon't\b/gi, "will not"], [/\bshan't\b/gi, "shall not"],
        [/\bain't\b/gi, "is not"], [/\blet's\b/gi, "let us"], [/\b(\w+)n't\b/gi, "$1 not"],
        [/\b(\w+)'re\b/gi, "$1 are"], [/\b(\w+)'ve\b/gi, "$1 have"], [/\b(\w+)'ll\b/gi, "$1 will"],
        [/\b(\w+)'d\b/gi, "$1 would"], [/\b(\w+)'m\b/gi, "$1 am"], [/\bit's\b/gi, "it is"]
      ];
      for (const [p, r] of contractions) {
        t = t.replace(p, r);
      }
    }

    if (cfg.expand_ip_addresses) {
      t = t.replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, (_, a, b, c, d) => {
        const dmap = { "0": "zero", "1": "one", "2": "two", "3": "three", "4": "four", "5": "five", "6": "six", "7": "seven", "8": "eight", "9": "nine" };
        const octet = (s) => s.split("").map(x => dmap[x]).join(" ");
        return [a, b, c, d].map(octet).join(" dot ");
      });
    }

    if (cfg.normalize_leading_decimals) {
      t = t.replace(/(?<!\d)(-)\.([\d])/g, "$10.$2");
      t = t.replace(_RE_LEAD_DEC, "0.$1");
    }

    if (cfg.expand_currency) {
      const smap = { "K": "thousand", "M": "million", "B": "billion", "T": "trillion" };
      t = t.replace(_RE_CURRENCY, (_, sym, raw, suffix) => {
        raw = raw.replace(/,/g, "");
        const unit = _CURRENCY_SYMBOLS[sym] || "dollar";
        if (suffix) {
          const num = raw.includes(".") ? float_to_words(raw) : number_to_words(parseInt(raw, 10));
          return `${num} ${smap[suffix]} ${unit}${unit ? 's' : ''}`.trim();
        }
        if (raw.includes(".")) {
          const [int_p, dec_p] = raw.split(".", 2);
          const dec_val = parseInt(dec_p.substring(0, 2).padEnd(2, "0"), 10);
          const int_words = number_to_words(parseInt(int_p, 10));
          let res = unit ? `${int_words} ${unit}s` : int_words;
          if (dec_val) res += ` and ${number_to_words(dec_val)} cent${dec_val !== 1 ? 's' : ''}`;
          return res;
        } else {
          const val = parseInt(raw, 10);
          return val === 1 ? `${number_to_words(val)} ${unit}` : `${number_to_words(val)} ${unit}s`;
        }
      });
    }

    if (cfg.expand_percentages) {
      t = t.replace(_RE_PERCENT, (_, raw) => {
        raw = raw.replace(/,/g, "");
        return (raw.includes(".") ? float_to_words(parseFloat(raw)) : number_to_words(parseInt(raw, 10))) + " percent";
      });
    }

    if (cfg.expand_time) {
      t = t.replace(_RE_TIME, (_, h, m, _s, ampm) => {
        const hh = number_to_words(parseInt(h, 10));
        const mm = parseInt(m, 10);
        const suf = ampm ? ` ${ampm.toLowerCase()}` : "";
        if (mm === 0) return !ampm ? `${hh} hundred` : `${hh}${suf}`;
        if (mm < 10) return `${hh} oh ${number_to_words(mm)}${suf}`;
        return `${hh} ${number_to_words(mm)}${suf}`;
      });
    }

    if (cfg.expand_ranges) {
      t = t.replace(_RE_RANGE, (_, lo, hi) => `${number_to_words(parseInt(lo, 10))} to ${number_to_words(parseInt(hi, 10))}`);
    }

    if (cfg.expand_model_names) {
      t = t.replace(_RE_MODEL_VER, "$1 $2");
    }

    if (cfg.expand_units) {
      const umap = { "km": "kilometers", "kg": "kilograms", "mg": "milligrams", "ml": "milliliters", "gb": "gigabytes", "mb": "megabytes", "kb": "kilobytes", "tb": "terabytes", "hz": "hertz", "khz": "kilohertz", "mhz": "megahertz", "ghz": "gigahertz", "mph": "miles per hour", "kph": "kilometers per hour", "ms": "milliseconds", "ns": "nanoseconds", "µs": "microseconds", "°c": "degrees Celsius", "c°": "degrees Celsius", "°f": "degrees Fahrenheit", "f°": "degrees Fahrenheit" };
      t = t.replace(_RE_UNIT, (_, raw, unit) => {
        const exp = umap[unit.toLowerCase()] || unit;
        const num = raw.includes(".") ? float_to_words(parseFloat(raw)) : number_to_words(parseInt(raw, 10));
        return `${num} ${exp}`;
      });
    }

    if (cfg.expand_scientific_notation) {
      t = t.replace(_RE_SCI, (_, coeff, exp) => {
        const cw = coeff.includes(".") ? float_to_words(coeff) : number_to_words(parseInt(coeff, 10));
        const ew = number_to_words(Math.abs(parseInt(exp, 10)));
        const sign = parseInt(exp, 10) < 0 ? "negative " : "";
        return `${cw} times ten to the ${sign}${ew}`;
      });
    }

    if (cfg.expand_scale_suffixes) {
      const smap = { "K": "thousand", "M": "million", "B": "billion", "T": "trillion" };
      t = t.replace(_RE_SCALE, (_, raw, suf) => {
        const num = raw.includes(".") ? float_to_words(raw) : number_to_words(parseInt(raw, 10));
        return `${num} ${smap[suf] || suf}`;
      });
    }

    if (cfg.expand_fractions) {
      t = t.replace(_RE_FRACTION, (m, nm, dn) => {
        const n = parseInt(nm, 10), d = parseInt(dn, 10);
        if (d === 0) return m;
        const nw = number_to_words(n);
        let dw;
        if (d === 2) dw = n === 1 ? "half" : "halves";
        else if (d === 4) dw = n === 1 ? "quarter" : "quarters";
        else dw = _ordinal_suffix(d) + (n !== 1 ? "s" : "");
        return `${nw} ${dw}`;
      });
    }

    if (cfg.expand_ordinals) {
      t = t.replace(_RE_ORDINAL, (_, n) => _ordinal_suffix(parseInt(n, 10)));
    }

    if (cfg.expand_decades) {
      const dmap = ["hundreds", "tens", "twenties", "thirties", "forties", "fifties", "sixties", "seventies", "eighties", "nineties"];
      t = t.replace(_RE_DECADE, (_, yr) => {
        const base = parseInt(yr, 10);
        const dec = dmap[base % 10] || "";
        if (base < 10) return dec;
        return `${number_to_words(Math.floor(base / 10))} ${dec}`;
      });
    }

    if (cfg.expand_phone_numbers) {
      const dmap = { "0": "zero", "1": "one", "2": "two", "3": "three", "4": "four", "5": "five", "6": "six", "7": "seven", "8": "eight", "9": "nine" };
      const _d = (s) => s.split("").map(c => dmap[c]).join(" ");
      t = t.replace(/(?<!\d-)(?<!\d)\b(\d{1,2})-(\d{3})-(\d{3})-(\d{4})\b(?!-\d)/g, (_, a, b, c, d) => [_d(a), _d(b), _d(c), _d(d)].join(" "));
      t = t.replace(/(?<!\d-)(?<!\d)\b(\d{3})-(\d{3})-(\d{4})\b(?!-\d)/g, (_, a, b, c) => [_d(a), _d(b), _d(c)].join(" "));
      t = t.replace(/(?<!\d-)\b(\d{3})-(\d{4})\b(?!-\d)/g, (_, a, b) => [_d(a), _d(b)].join(" "));
    }

    if (cfg.replace_numbers) {
      t = t.replace(_RE_NUMBER, (m) => {
        const raw = m.replace(/,/g, "");
        if (raw.includes(".") && cfg.replace_floats) return float_to_words(raw);
        return number_to_words(parseInt(raw, 10));
      });
    }

    if (cfg.remove_punctuation) t = t.replace(_RE_PUNCT, " ");
    if (cfg.lowercase) t = t.toLowerCase();
    if (cfg.remove_extra_whitespace) t = t.replace(_RE_SPACES, " ").trim();

    return t;
  }
}
