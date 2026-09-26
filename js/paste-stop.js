const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function cleanPaste(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitSections(src) {
  const lines = src.split("\n");
  const header = /^(?:stop\s*\d+\s*[-–:]?\s*)?(?:pick(?:\s*up)?|pickup|shipper|delivery|deliver(?:y)?(?:\s+to)?|consignee|receiver|drop(?:\s*-?\s*off)?)\b/i;
  const at = [];
  lines.forEach((line, index) => {
    if (header.test(line.trim())) at.push(index);
  });
  if (at.length < 2) return { text: src, usedFirst: false };
  return { text: lines.slice(0, at[1]).join("\n").trim(), usedFirst: true };
}

function hasAnytime(src) {
  return /\b(?:fcfs|first\s+come(?:\s*,?\s*first\s+served)?|anytime|24\s*\/\s*7|24\s*hours?)\b/i.test(src);
}

function ignoredSpans(src) {
  const spans = [];
  const patterns = [
    /\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g,
    /\b\d{3}[-.\s]\d{4}\b/g,
    /\S+@\S+/g,
  ];
  for (const pattern of patterns) {
    for (const match of src.matchAll(pattern)) {
      spans.push({ index: match.index, length: match[0].length });
    }
  }
  return spans;
}

function overlaps(spans, index, length) {
  const end = index + length;
  return spans.some((span) => index < span.index + span.length && end > span.index);
}

function lineAt(src, index) {
  const start = src.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  const next = src.indexOf("\n", index);
  const end = next === -1 ? src.length : next;
  return src.slice(start, end);
}

function sameLine(src, a, b) {
  const left = src.lastIndexOf("\n", Math.max(0, a - 1));
  const right = src.indexOf("\n", a);
  const end = right === -1 ? src.length : right;
  return b >= left && b <= end;
}

function validDay(year, monthIndex, day) {
  if (monthIndex < 0 || monthIndex > 11 || day < 1 || day > 31) return false;
  const date = new Date(year, monthIndex, day);
  return date.getFullYear() === year && date.getMonth() === monthIndex && date.getDate() === day;
}

function fullYear(year, now) {
  if (year == null) return null;
  if (year < 100) return year >= 70 ? 1900 + year : 2000 + year;
  return year;
}

function yearFor(monthIndex, day, year, now) {
  const given = fullYear(year, now);
  if (given != null) return validDay(given, monthIndex, day) ? given : null;
  const y = now.getFullYear();
  if (!validDay(y, monthIndex, day)) return null;
  const today = new Date(y, now.getMonth(), now.getDate()).getTime();
  const candidate = new Date(y, monthIndex, day).getTime();
  if (candidate < today - 7 * 24 * 3600 * 1000) return validDay(y + 1, monthIndex, day) ? y + 1 : null;
  return y;
}

function parseDateMatch(text, now) {
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    const year = Number(iso[1]);
    const monthIndex = Number(iso[2]) - 1;
    const day = Number(iso[3]);
    if (!validDay(year, monthIndex, day)) return null;
    return { year, monthIndex, day };
  }
  const monthName = text.match(/^(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(\d{2,4}))?$/i);
  if (monthName) {
    const monthIndex = MONTHS[monthName[1].toLowerCase()];
    const day = Number(monthName[2]);
    const year = yearFor(monthIndex, day, monthName[3] == null ? null : Number(monthName[3]), now);
    if (year == null) return null;
    return { year, monthIndex, day };
  }
  const numeric = text.match(/^(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+)?(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{2,4}))?$/i);
  if (!numeric) return null;
  let monthIndex = Number(numeric[1]) - 1;
  let day = Number(numeric[2]);
  if (monthIndex > 11 && day >= 1 && day <= 12) {
    monthIndex = day - 1;
    day = Number(numeric[1]);
  }
  const year = yearFor(monthIndex, day, numeric[3] == null ? null : Number(numeric[3]), now);
  if (year == null) return null;
  return { year, monthIndex, day };
}

function findDates(src, now, skip) {
  const pattern = /(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+)?(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:\s*,?\s*\d{2,4})?|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\/.\-]\d{1,2}(?:[\/.\-]\d{2,4})?)/gi;
  const found = [];
  for (const match of src.matchAll(pattern)) {
    if (overlaps(skip, match.index, match[0].length)) continue;
    const before = match.index > 0 ? src[match.index - 1] : "";
    const after = src[match.index + match[0].length] || "";
    if (/\d/.test(before) || /\d/.test(after)) continue;
    const parts = parseDateMatch(match[0], now);
    if (!parts) continue;
    found.push({ index: match.index, length: match[0].length, ...parts });
  }
  return found;
}

function parseClock(text) {
  const word = text.trim().toLowerCase();
  if (word === "noon") return { hour: 12, minute: 0, meridian: "pm" };
  if (word === "midnight") return { hour: 0, minute: 0, meridian: "am" };
  const ampm = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(a\.?\s*m\.?|p\.?\s*m\.?)$/i);
  if (ampm) {
    let hour = Number(ampm[1]);
    const minute = ampm[2] == null ? 0 : Number(ampm[2]);
    const meridian = /^p/i.test(ampm[3]) ? "pm" : "am";
    if (hour < 1 || hour > 12 || minute > 59) return null;
    if (meridian === "pm" && hour < 12) hour += 12;
    if (meridian === "am" && hour === 12) hour = 0;
    return { hour, minute, meridian };
  }
  const colon = text.match(/^(\d{1,2}):(\d{2})$/);
  if (colon) {
    const hour = Number(colon[1]);
    const minute = Number(colon[2]);
    if (hour > 23 || minute > 59) return null;
    return { hour, minute, meridian: hour >= 13 ? "24" : "" };
  }
  const compact = text.match(/^(\d{2})(\d{2})$/);
  if (compact) {
    const hour = Number(compact[1]);
    const minute = Number(compact[2]);
    if (hour > 23 || minute > 59) return null;
    return { hour, minute, meridian: hour >= 13 ? "24" : "" };
  }
  return null;
}

function followedByStreet(src, end) {
  return /^\s+(?:n|s|e|w|ne|nw|se|sw|north|south|east|west|st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|pkwy|parkway|hwy|highway|route|trl|trail|ct|court|cir|circle|pl|place|us)\b/i.test(src.slice(end));
}

function fourDigitOk(src, index, length) {
  if (followedByStreet(src, index + length)) return false;
  if (src[index] === "0") return true;
  const line = lineAt(src, index);
  if (line.trim() === src.slice(index, index + length)) return true;
  if (/\b(?:time|times|appt|appointment|hours|opens?|closes?|earliest|latest|ready|by)\b|@/i.test(line)) return true;
  const around = src.slice(Math.max(0, index - 8), index + length + 8);
  if (/[-–—]|to|until/i.test(around)) return true;
  return false;
}

function findClocks(src, skip) {
  const pattern = /\b(?:noon|midnight)\b|\d{1,2}:\d{2}[ \t]*(?:a\.?[ \t]*m\.?|p\.?[ \t]*m\.?)?|\d{1,2}[ \t]*(?:a\.?[ \t]*m\.?|p\.?[ \t]*m\.?)|(?<!\d)(?:[01]\d|2[0-3])[0-5]\d(?!\d)/gi;
  const found = [];
  for (const match of src.matchAll(pattern)) {
    const raw = match[0].trim();
    if (!raw || overlaps(skip, match.index, raw.length)) continue;
    const compact = /^\d{4}$/.test(raw);
    if (compact && !fourDigitOk(src, match.index, raw.length)) continue;
    const clock = parseClock(raw);
    if (!clock) continue;
    if (!compact && !/:|a\.?[ \t]*m|p\.?[ \t]*m|noon|midnight/i.test(raw)) continue;
    found.push({ index: match.index, length: raw.length, ...clock });
  }
  return found;
}

function rangeBetween(src, left, right) {
  if (right.index < left.index + left.length) return false;
  const gap = src.slice(left.index + left.length, right.index);
  if (gap.includes("\n")) return false;
  return /^[\s:]*(?:@|at|on)?[\s:]*(?:[-–—]|to|until|through)[\s:]*$/i.test(gap)
    || /^[\s:]*(?:@|at|on)[\s:]*$/i.test(gap);
}

function applyMeridian(start, end) {
  const outStart = { ...start };
  const outEnd = { ...end };
  if (!outStart.meridian && outEnd.meridian === "pm" && outStart.hour >= 1 && outStart.hour <= 11) {
    outStart.meridian = "am";
  }
  if (!outEnd.meridian && outStart.meridian === "am" && outEnd.hour >= 1 && outEnd.hour <= 11 && outEnd.hour < outStart.hour) {
    outEnd.hour += 12;
    outEnd.meridian = "pm";
  }
  if (!outStart.meridian && !outEnd.meridian && outEnd.hour >= 1 && outEnd.hour <= 11 && outEnd.hour < outStart.hour && outStart.hour <= 12) {
    outStart.meridian = "am";
    outEnd.hour += 12;
    outEnd.meridian = "pm";
  }
  if (!outStart.meridian && outStart.hour <= 12) outStart.meridian = outStart.hour >= 13 ? "24" : "am";
  if (!outEnd.meridian && outEnd.hour <= 12) outEnd.meridian = "am";
  return [outStart, outEnd];
}

function clockParts(clock) {
  return { hour: clock.hour, minute: clock.minute };
}

function weekdayDate(src, token, now) {
  const lineStart = src.lastIndexOf("\n", Math.max(0, token.index - 1)) + 1;
  const before = src.slice(lineStart, token.index);
  if (/(?:\d{1,2}[\/.\-]\d{1,2})|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)/i.test(before)) return null;
  const match = before.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|mon|tue|wed|thu|fri|sat|sun)\b[\s,]*$/i);
  if (!match) return null;
  const target = WEEKDAYS.findIndex((day) => day.startsWith(match[1].toLowerCase().slice(0, 3)));
  if (target < 0) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let delta = (target - today.getDay() + 7) % 7;
  const hour = token.hour ?? token.t1?.hour;
  const minute = token.minute ?? token.t1?.minute ?? 0;
  if (delta === 0 && hour != null) {
    const passed = hour < now.getHours() || (hour === now.getHours() && minute < now.getMinutes());
    if (passed) delta = 7;
  }
  const when = new Date(today.getFullYear(), today.getMonth(), today.getDate() + delta);
  return {
    index: lineStart + match.index,
    length: match[0].length,
    year: when.getFullYear(),
    monthIndex: when.getMonth(),
    day: when.getDate(),
  };
}

function dateNear(src, token, dates) {
  const before = dates.filter((date) => date.index + date.length <= token.index && token.index - (date.index + date.length) <= 80);
  const after = dates.filter((date) => date.index >= token.index + token.length && date.index - (token.index + token.length) <= 48);
  const sameBefore = before.filter((date) => sameLine(src, token.index, date.index));
  if (sameBefore.length) return sameBefore[sameBefore.length - 1];
  const sameAfter = after.filter((date) => sameLine(src, token.index, date.index));
  if (sameAfter.length) return sameAfter[0];
  if (before.length) return before[before.length - 1];
  if (after.length) return after[0];
  return null;
}

function withDate(date, clock, now) {
  const base = date || {
    year: now.getFullYear(),
    monthIndex: now.getMonth(),
    day: now.getDate(),
  };
  return {
    year: base.year,
    monthIndex: base.monthIndex,
    day: base.day,
    hour: clock.hour,
    minute: clock.minute,
  };
}

function addDays(parts, days) {
  const date = new Date(parts.year, parts.monthIndex, parts.day + days, parts.hour, parts.minute);
  return {
    year: date.getFullYear(),
    monthIndex: date.getMonth(),
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
  };
}

function wallKey(parts) {
  return Date.UTC(parts.year, parts.monthIndex, parts.day, parts.hour || 0, parts.minute || 0);
}

function extractAppointments(src, now, skip) {
  const dates = findDates(src, now, skip);
  const clocks = findClocks(src, [...skip, ...dates]);
  const used = new Set();
  const usedDates = new Set();
  const appointments = [];
  const consumed = [...dates];
  for (let i = 0; i < clocks.length; i += 1) {
    if (used.has(i)) continue;
    const next = clocks[i + 1];
    if (next && !used.has(i + 1) && rangeBetween(src, clocks[i], next)) {
      used.add(i);
      used.add(i + 1);
      const [startClock, endClock] = applyMeridian(clocks[i], next);
      const span = { index: clocks[i].index, length: next.index + next.length - clocks[i].index };
      const date = dateNear(src, span, dates) || weekdayDate(src, { ...span, ...startClock }, now);
      if (date && dates.includes(date)) usedDates.add(date);
      if (date?.length && !dates.includes(date)) consumed.push(date);
      const start = withDate(date, startClock, now);
      let end = withDate(date, endClock, now);
      if (wallKey(end) <= wallKey(start)) end = addDays(end, 1);
      appointments.push({ ...start, end });
      consumed.push(span);
      continue;
    }
    used.add(i);
    const date = dateNear(src, clocks[i], dates) || weekdayDate(src, clocks[i], now);
    if (date && dates.includes(date)) usedDates.add(date);
    if (date?.length && !dates.includes(date)) consumed.push(date);
    appointments.push(withDate(date, clocks[i], now));
    consumed.push(clocks[i]);
  }
  for (const date of dates) {
    if (usedDates.has(date)) continue;
    appointments.push({ year: date.year, monthIndex: date.monthIndex, day: date.day, hour: null, minute: null });
  }
  return { appointments, consumed };
}

function looksLikePlace(line) {
  if (/\d/.test(line) && /\b(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|pkwy|parkway|hwy|highway|route|trl|trail|ct|court|cir|circle|pl|place)\b/i.test(line)) return true;
  if (/^\d+\s+\S/.test(line)) return true;
  if (/\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/.test(line)) return true;
  if (/,\s*[A-Za-z]{2}\b/.test(line)) return true;
  if (/\b\d{5}(?:-\d{4})?\b/.test(line)) return true;
  return false;
}

function isMetaLine(line) {
  return /^(?:weight|pieces|pallets|cases|commodity|temp(?:erature)?|phone|tel|fax|email|contact|reference|ref|po#?|bol|pro#?|notes?|appointment\s+type|type|miles|distance|qty|quantity)\b/i.test(line);
}

function isHeaderLine(line) {
  return /^(?:stop\s*\d+\s*[-–:]?\s*)?(?:pick(?:\s*up)?|pickup|shipper|delivery|deliver(?:y)?(?:\s+to)?|consignee|receiver|drop(?:\s*-?\s*off)?)\b\s*$/i.test(line)
    || /^stop\s*\d+\s*$/i.test(line);
}

function stripLabel(line) {
  return line
    .replace(/^(?:address|location|company|facility|shipper|consignee|receiver|name|stop)\s*:\s*/i, "")
    .replace(/^(?:pickup|pick\s*up|delivery|drop(?:\s*-?\s*off)?)\s*[:\-]\s*/i, "")
    .replace(/^(?:pickup|delivery|appointment|appt|earliest|latest|ready|opens?|closes?|date(?:\s*\/\s*time)?|time|hours|be\s+there\s+by)\s*:\s*/i, "")
    .trim();
}

function blankSpans(src, spans) {
  const chars = [...src];
  for (const span of spans) {
    for (let i = span.index; i < span.index + span.length && i < chars.length; i += 1) {
      if (chars[i] !== "\n") chars[i] = " ";
    }
  }
  return chars.join("");
}

function extractAddress(src, consumed) {
  const blank = blankSpans(src, consumed);
  const lines = blank.split("\n").map((line) => stripLabel(line.replace(/\s+/g, " ").trim()).replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "").trim()).filter(Boolean);
  const kept = lines.filter((line) => !isHeaderLine(line) && !isMetaLine(line) && !/^(?:fcfs|first\s+come(?:\s*,?\s*first\s+served)?|anytime|24\s*\/\s*7|24\s*hours?)$/i.test(line) && !/^(?:(?:pickup|delivery|shipper|consignee|receiver)\s+)?(?:date(?:\s*\/\s*time)?|time|times|hours|opens?|closes?|earliest|latest|ready|appointment|appt|be\s+there\s+by|between|from|until|window|at|on|by)\b[:\s-]*$/i.test(line) && !/^\d{1,2}:\d{2}(?:\s*[ap]\.?m\.?)?$/i.test(line));
  const nameLine = kept.find((line) => !looksLikePlace(line));
  const address = kept.join(", ").replace(/\s+,/g, ",").replace(/,\s*,/g, ", ").replace(/\s+/g, " ").trim();
  const name = nameLine ? nameLine.split(/\s+/)[0].replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9']+$/g, "") : "";
  return { address, name };
}

export function parseStopPaste(text, nowMs = Date.now()) {
  const cleaned = cleanPaste(text);
  if (!cleaned) return null;
  const section = splitSections(cleaned);
  const src = section.text;
  if (!src) return null;
  const skip = ignoredSpans(src);
  const anytime = hasAnytime(src);
  const { appointments, consumed } = extractAppointments(src, new Date(nowMs), skip);
  const { address, name } = extractAddress(src, [...consumed, ...skip]);
  if (!address && !appointments.length && !anytime) return null;
  let start = null;
  let end = null;
  let window = false;
  if (appointments.length >= 2) {
    const ordered = appointments.map((item) => {
      if (item.end) return [item, item.end];
      return [item];
    }).flat();
    ordered.sort((a, b) => wallKey(a) - wallKey(b));
    start = ordered[0];
    end = ordered[ordered.length - 1];
    window = wallKey(end) !== wallKey(start);
    if (!window) end = null;
  } else if (appointments.length === 1) {
    start = appointments[0];
    if (start.end) {
      end = start.end;
      window = wallKey(end) !== wallKey(start);
      if (!window) end = null;
    }
  }
  if (start?.end) {
    const { end: nested, ...rest } = start;
    void nested;
    start = rest;
  }
  return {
    address,
    name,
    anytime: anytime && !start,
    window,
    start,
    end: window ? end : null,
    usedFirst: section.usedFirst,
    hadWhen: Boolean(start),
    timed: start?.hour != null || end?.hour != null,
  };
}
