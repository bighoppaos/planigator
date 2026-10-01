// First-party ad counts for the planigator Worker.
//
// Do not deploy this until the owner approves the pull request.
// Paste these functions into the Worker (the live file is not in this repo).
// Drop the export keywords if that file is one script.
//
// 1. Routes, next to /v1/visit and /v1/admin/visits:
//      if (request.method === "POST" && url.pathname === "/v1/ad") {
//        return await recordAdLanding(request, env, origin);
//      }
//      if (request.method === "GET" && url.pathname === "/v1/admin/ads") {
//        return await adminAds(request, env, origin);
//      }
// 2. In login(), inside the block that grants the first Google credits
//    (`if (!account.googleCreditsGranted && !account.unlimited)`), after
//    signupCredits is set:
//      adCounted = await countSignupAd(env, body);
//    Add `let adCounted = false` beside `let signupCredits = 0`, and add
//    `adCounted` to the login JSON. Do not write the labels onto the account.
// 3. In the Google full-page redirect (oauthCallbackPage), the /v1/login
//    body has to include the labels saved by js/ads.js, and a counted sign-up
//    has to set counted on that same localStorage key. See OAUTH_LOGIN_SCRIPT.
//
// Counts live in one KV key, site:ads. Rows are campaign totals only.
// No visitor id, name, or email is stored there. Same owner check as
// /v1/admin/visits (requireOwner).

export const AD_BOOK_KEY = "site:ads";
const AD_FIELDS = ["source", "medium", "campaign", "term", "content"];
const AD_PARAM = {
  source: "utm_source",
  medium: "utm_medium",
  campaign: "utm_campaign",
  term: "utm_term",
  content: "utm_content",
};
const AD_MAX = 80;
const AD_MAX_ROWS = 200;

export function cleanAdPart(value) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, AD_MAX);
  if (!text || text.includes("@")) return "";
  return text;
}

export function adTouchFrom(body) {
  const raw = body?.utm && typeof body.utm === "object" ? body.utm : null;
  if (!raw) return null;
  const touch = {};
  for (const field of AD_FIELDS) {
    const value = cleanAdPart(raw[AD_PARAM[field]] ?? raw[field]);
    if (value) touch[field] = value;
  }
  return Object.keys(touch).length ? touch : null;
}

export function adRowKey(touch) {
  return AD_FIELDS.map((field) => touch[field] || "").join("\u001f");
}

export function bumpAdBook(book, touch, field, now = Date.now()) {
  const current = book && typeof book === "object" ? book : {};
  const rows = current.rows && typeof current.rows === "object" ? { ...current.rows } : {};
  const key = adRowKey(touch);
  const prev = rows[key] && typeof rows[key] === "object" ? rows[key] : {};
  const row = {
    source: touch.source || "",
    medium: touch.medium || "",
    campaign: touch.campaign || "",
    term: touch.term || "",
    content: touch.content || "",
    landings: Number(prev.landings) || 0,
    signups: Number(prev.signups) || 0,
    first: Number(prev.first) || now,
    last: now,
  };
  if (field === "landings" || field === "signups") row[field] += 1;
  rows[key] = row;
  let entries = Object.entries(rows);
  if (entries.length > AD_MAX_ROWS) {
    entries.sort((a, b) => (Number(b[1].last) || 0) - (Number(a[1].last) || 0));
    entries = entries.slice(0, AD_MAX_ROWS);
  }
  return { rows: Object.fromEntries(entries) };
}

export function adRowsForOwner(book) {
  const rows = Object.values(book?.rows || {}).filter((row) => row && typeof row === "object");
  return rows
    .map((row) => ({
      source: cleanAdPart(row.source),
      medium: cleanAdPart(row.medium),
      campaign: cleanAdPart(row.campaign),
      term: cleanAdPart(row.term),
      content: cleanAdPart(row.content),
      landings: Number(row.landings) || 0,
      signups: Number(row.signups) || 0,
    }))
    .filter((row) => row.source || row.medium || row.campaign || row.term || row.content)
    .sort((a, b) => (
      b.signups - a.signups
      || b.landings - a.landings
      || String(a.campaign).localeCompare(String(b.campaign))
      || String(a.term).localeCompare(String(b.term))
    ));
}

async function writeAd(env, touch, field) {
  const current = await env.CREDITS.get(AD_BOOK_KEY, { type: "json" });
  const next = bumpAdBook(current, touch, field);
  await env.CREDITS.put(AD_BOOK_KEY, JSON.stringify(next));
}

export async function recordAdLanding(request, env, origin) {
  requireKV(env);
  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const touch = adTouchFrom(body);
  if (!touch) return json(origin, 200, { ok: true, landing: false });
  await writeAd(env, touch, "landings");
  return json(origin, 200, { ok: true, landing: true });
}

export async function countSignupAd(env, body) {
  try {
    const touch = adTouchFrom(body);
    if (!touch || !env?.CREDITS) return false;
    await writeAd(env, touch, "signups");
    return true;
  } catch {
    return false;
  }
}

export async function adminAds(request, env, origin) {
  await requireOwner(request, env);
  const book = await env.CREDITS.get(AD_BOOK_KEY, { type: "json" });
  return json(origin, 200, { rows: adRowsForOwner(book) });
}

// In oauthCallbackPage, replace the fetch("/v1/login") call and the three
// lines that save session, loginNonce, and signupCredits with the script
// below. The storage key matches js/ads.js AD_STORE_KEY ("planigator.web.utm").
//
//         let utm = null;
//         try {
//           const saved = JSON.parse(localStorage.getItem("planigator.web.utm") || "null");
//           if (saved && !saved.counted) {
//             utm = {};
//             for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]) {
//               const value = String(saved[key] || "").replace(/[\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
//               if (value && !value.includes("@")) utm[key] = value;
//             }
//             if (!Object.keys(utm).length) utm = null;
//           }
//         } catch (e) {}
//         const loginBody = { provider: "google", idToken: credential, dropSession: previous };
//         if (utm) loginBody.utm = utm;
//         const response = await fetch("/v1/login", {
//           method: "POST",
//           headers,
//           body: JSON.stringify(loginBody),
//         });
//         const data = await response.json().catch(() => ({}));
//         if (!response.ok) throw new Error(data.error || "Google sign-in failed.");
//         if (data.session) localStorage.setItem(sessionKey, data.session);
//         if (data.loginNonce) localStorage.setItem(authKey, data.loginNonce);
//         if (data.signupCredits) sessionStorage.setItem("planigator.web.signup", "1");
//         if (data.adCounted) {
//           try {
//             const saved = JSON.parse(localStorage.getItem("planigator.web.utm") || "{}");
//             saved.counted = true;
//             localStorage.setItem("planigator.web.utm", JSON.stringify(saved));
//           } catch (e) {}
//         }
