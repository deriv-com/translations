#!/usr/bin/env node

/* eslint-disable */
"use strict";

/**
 * deriv-rosetta-sync — translate the extracted `translations/en.json` with the
 * Rosetta gateway and write one `translations/<locale>.json` per target locale,
 * in the same shape the Crowdin-based action produced, so the runtime
 * (`initializeI18n`, which fetches `<cdnUrl>/translations/<lang>.json` and looks
 * strings up by crc32 of the English text) cannot tell the two apart.
 *
 * It translates only the delta: the current `<locale>.json` is fetched from the
 * CDN first and acts as the translation memory. A key already there is kept
 * verbatim, a key no longer in `en.json` is pruned, and only keys the CDN does
 * not have are sent to Rosetta. Because keys are the crc32 of the English text,
 * a reworded string is simply a new key.
 *
 * Two optional sources come before Rosetta (see `planLocale`):
 *   - FALLBACK_ENVIRONMENT: another environment's CDN catalogue, so production
 *     takes the value QA reviewed on staging instead of translating the key a
 *     second time. FALLBACK_MODE "missing" (default) uses it only for keys this
 *     environment lacks; "prefer" lets it win over this environment's own value.
 *   - OVERRIDES_FILE: reviewed corrections committed in the consumer's repo,
 *     applied last in every environment (see `resolveOverrides`).
 *
 * Placeholders (`{{name}}`), i18next component markers (`<0>…</0>`) and
 * caller-supplied protected terms (brand and product names) are swapped for
 * HTML tokens Rosetta preserves, restored afterwards, and verified to appear
 * exactly once. A string whose tokens did not survive is left OUT of the
 * locale file: the runtime then falls back to English for it, and the next run
 * retries it because its key is still missing.
 *
 * Environment (the composite action maps its inputs onto these):
 *   PROJECT_NAME, ENVIRONMENT (staging|production), TARGET_LOCALES (e.g.
 *   "es,fr,pt"), ROSETTA_API_TOKEN, ROSETTA_API_BASE, CDN_BASE_URL, DRY_RUN,
 *   ROSETTA_CF_ACCESS_CLIENT_ID and ROSETTA_CF_ACCESS_CLIENT_SECRET (optional,
 *   both or neither: a Cloudflare Access service token for the Rosetta API),
 *   PROTECTED_TERMS_FILE (optional JSON array of strings), FALLBACK_ENVIRONMENT,
 *   FALLBACK_MODE, OVERRIDES_FILE (all optional), TRANSLATIONS_DIR
 *   (default ./translations), REFERENCE (default "<project>/<env>/<GITHUB_SHA>").
 *
 * The API key and the service token are read from the environment and never
 * written to any log.
 *
 * Exit code: non-zero only for hard failures (bad configuration, auth, the job
 * failing outright, a timeout). A `partial` job writes the locales that
 * succeeded and reports `status=partial` through $GITHUB_OUTPUT so the action
 * can fail the run after uploading.
 */

const fs = require("fs");
const path = require("path");

/** Locale code → language name the API expects, from the Makima API guide that Rosetta replaced (39 languages). */
const LANGUAGES = [
  { code: "fr", name: "French" },
  { code: "ar", name: "Arabic" },
  { code: "pt", name: "Portuguese" },
  { code: "es", name: "Spanish" },
  { code: "ru", name: "Russian" },
  { code: "vi", name: "Vietnamese" },
  { code: "bn", name: "Bengali" },
  { code: "si", name: "Sinhala" },
  { code: "tr", name: "Turkish" },
  { code: "sw", name: "Swahili" },
  // Aliases are the runtime's spellings (ALL_LANGUAGES ZH_CN / ZH_TW), so the CDN files are zh_cn.json / zh_tw.json.
  { code: "zh-CN", name: "Simplified Chinese", aliases: ["zh_cn"] },
  { code: "zh-Hant-TW", name: "Traditional Chinese", aliases: ["zh_tw"] },
  { code: "ko", name: "Korean" },
  { code: "it", name: "Italian" },
  { code: "de", name: "German" },
  { code: "pl", name: "Polish" },
  { code: "uz", name: "Uzbek" },
  { code: "mn", name: "Mongolian" },
  { code: "ta", name: "Tamil" },
  { code: "ur", name: "Urdu" },
  { code: "uk", name: "Ukrainian" },
  { code: "am", name: "Amharic" },
  { code: "mg", name: "Malagasy" },
  { code: "fa", name: "Persian" },
  { code: "ps", name: "Pashto" },
  { code: "nl", name: "Dutch" },
  { code: "ckb", name: "Sorani Kurdish" },
  { code: "ny", name: "Chichewa" },
  { code: "ht", name: "Haitian Creole" },
  { code: "ja", name: "Japanese" },
  { code: "kk", name: "Kazakh" },
  { code: "ky", name: "Kyrgyz" },
  { code: "ne", name: "Nepali" },
  { code: "so", name: "Somali" },
  { code: "st", name: "Sotho" },
  { code: "ss", name: "Swazi" },
  { code: "zgh", name: "Tamazight" },
  { code: "th", name: "Thai" },
  { code: "tn", name: "Tswana" },
];

/**
 * Resolve a locale code (as used in the file name, e.g. "es") to the language
 * name Rosetta expects (e.g. "Spanish"). The runtime lower-cases the code when
 * it builds the URL, so matching is case-insensitive; the file is always
 * written with the lower-case code.
 */
function languageNameFor(code) {
  const wanted = String(code).trim().toLowerCase();
  const codesOf = (l) => [l.code, ...(l.aliases || [])];
  const hit = LANGUAGES.find((l) => codesOf(l).some((c) => c.toLowerCase() === wanted));
  if (!hit) {
    throw new Error(
      `Unknown locale "${code}". Known codes: ${LANGUAGES.flatMap(codesOf).join(", ")}`
    );
  }
  return hit.name;
}

function localeFileName(code) {
  return `${String(code).trim().toLowerCase()}.json`;
}

// ---------------------------------------------------------------------------
// Token protection
// ---------------------------------------------------------------------------

// Every interpolation shape i18next accepts: `{{name}}`, `{{count, number}}`,
// `{{- raw}}`, and nested `$t(key)` lookups. Matching broadly here matters
// because the same regex builds the signature the token check compares.
const PLACEHOLDER_RE = /\{\{-?\s*[^{}]+?\s*\}\}|\$t\([^()]*\)/g;
const MARKER_RE = /<(\/?)(\d+)>/g;
// Entities restore() decodes, and any entity at all (for the leftover check).
const ENTITY_RE = /&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);/g;
const ANY_ENTITY_RE = /&(?:[A-Za-z][A-Za-z0-9]*|#\d+|#x[0-9a-fA-F]+);/g;
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
/**
 * Decode one entity matched by ENTITY_RE (named, decimal or hex). A numeric
 * entity for a surrogate, a control character (other than tab, LF and CR) or
 * an out-of-range code point is returned as is, so the leftover check fails it.
 */
function decodeEntity(match, name) {
  if (name[0] !== "#") return ENTITIES[name];
  const code = name[1] === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
  const control = (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || (code >= 0x7f && code <= 0x9f);
  const surrogate = code >= 0xd800 && code <= 0xdfff;
  return code > 0 && code <= 0x10ffff && !control && !surrogate ? String.fromCodePoint(code) : match;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Protection tags are custom elements (a hyphen in the name): see protect().
// restore()'s regexes are built from the same table, so a rename stays in one place.
const TAG = { ph: "x-ph", pt: "x-pt", marker: "x-c" };
const KIND_BY_TAG = { [TAG.ph]: "ph", [TAG.pt]: "pt" };
const TOKEN_TAG_RE = new RegExp(
  `<(${escapeRegExp(TAG.ph)}|${escapeRegExp(TAG.pt)})\\s+i="(\\d+)"\\s*(?:\\/>|>\\s*<\\/\\1\\s*>)`,
  "g"
);
const MARKER_TAG_RE = new RegExp(`<(\\/?)${escapeRegExp(TAG.marker)}(\\d+)>`, "g");
// A token that survived restore, in its tag form or without its prefix.
const LEFTOVER_TOKEN_RE = new RegExp(
  `\\u0000|<\\/?(?:${escapeRegExp(TAG.ph)}|${escapeRegExp(TAG.pt)}|${escapeRegExp(TAG.marker)}\\d+|ph|pt|c\\d+)\\b`
);

/** Whole-term match: not glued to a letter or digit on either side. */
function termRegExp(term) {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`, "gu");
}

/**
 * Count whole-term occurrences, longest term first, blanking each match so a
 * term that contains another ("Deriv MCP" ⊃ "Deriv") is not counted twice.
 */
function countTerms(text, terms) {
  const counts = {};
  let work = text;
  for (const term of [...new Set(terms)].sort((a, b) => b.length - a.length)) {
    let n = 0;
    work = work.replace(termRegExp(term), () => {
      n += 1;
      return "\u0001".repeat(term.length);
    });
    counts[term] = n;
  }
  return counts;
}

/**
 * Replace everything Rosetta must not translate with HTML tokens it preserves:
 *   `{{name}}`      → `<x-ph i="N"></x-ph>`  (an element with no visible text)
 *   `<0>…</0>`      → `<x-c0>…</x-c0>`       (the inner text is still translated)
 *   protected term  → `<x-pt i="N"></x-pt>`  (brand names; the term is kept in `tokens`)
 * The names are custom elements (they contain a hyphen) on purpose: Rosetta
 * treats a string that starts with any other non-HTML tag as XML and rejects it
 * as malformed (HTTP 422) unless it is a whole XML document, so a string that
 * began with a marker, a placeholder or a protected term would fail the batch.
 * Returns the protected text and the token table needed to restore it.
 */
function protect(text, protectedTerms = []) {
  const tokens = [];
  let out = text.replace(PLACEHOLDER_RE, (m) => {
    tokens.push({ kind: "ph", original: m });
    return `<${TAG.ph} i="${tokens.length - 1}"></${TAG.ph}>`;
  });
  out = out.replace(MARKER_RE, (_m, slash, n) => `<${slash}${TAG.marker}${n}>`);
  const terms = [...new Set(protectedTerms.filter(Boolean))].sort(
    (a, b) => b.length - a.length
  );
  for (const term of terms) {
    out = out.replace(termRegExp(term), () => {
      tokens.push({ kind: "pt", original: term });
      return `<${TAG.pt} i="${tokens.length - 1}"></${TAG.pt}>`;
    });
  }
  return { text: out, tokens };
}

/** Everything that must survive translation, in a comparable form. */
function signature(text) {
  const placeholders = (text.match(PLACEHOLDER_RE) || []).map((m) => m.replace(/\s+/g, ""));
  const markers = [];
  text.replace(MARKER_RE, (m, slash, n) => {
    markers.push(`${slash}${n}`);
    return m;
  });
  return { placeholders: placeholders.sort(), markers: markers.join(" ") };
}

/**
 * Put the original placeholders, markers and terms back and check that the
 * result carries exactly the same set of them as the source English did.
 * Returns `{ ok, text, reason }`; `text` is only meaningful when `ok`.
 */
function restore(translated, tokens, sourceEnglish) {
  let out = String(translated);
  // Rosetta may serialise an empty element as <x-ph i="1"></x-ph>, <x-ph i="1"/>
  // or <x-ph i="1" /> and may put whitespace inside; accept all of them.
  out = out.replace(TOKEN_TAG_RE, (_m, tag, i) => {
    const kind = KIND_BY_TAG[tag];
    const token = tokens[Number(i)];
    return token && token.kind === kind ? token.original : `\u0000${kind}${i}\u0000`;
  });
  out = out.replace(MARKER_TAG_RE, "<$1$2>");
  // An HTML-aware translator may escape `&`, `<`, `>`, quotes and non-breaking
  // spaces, or emit numeric entities, on the way back. Decode those, except an
  // entity the source itself contains, which is kept as written: a source
  // with `&amp;` keeps its `&amp;`, while a `&amp;` the translator added to a
  // source with only `&nbsp;` is still decoded.
  const sourceEntities = new Set(String(sourceEnglish).match(ANY_ENTITY_RE) || []);
  out = out.replace(ENTITY_RE, (m, name) => (sourceEntities.has(m) ? m : decodeEntity(m, name)));

  // Also catches a token Rosetta returned without its x- prefix.
  if (LEFTOVER_TOKEN_RE.test(out)) {
    return { ok: false, text: out, reason: "a protected token was altered or lost" };
  }
  // Any other entity the source did not have (`&rsquo;`, a surrogate) would be
  // published literally, so the string is held back instead.
  const leftover = (out.match(ANY_ENTITY_RE) || []).find((e) => !sourceEntities.has(e));
  if (leftover) {
    return { ok: false, text: out, reason: `an HTML entity was left in the translation (${leftover})` };
  }
  const terms = tokens.filter((t) => t.kind === "pt").map((t) => t.original);
  const check = checkTranslation(out, sourceEnglish, terms);
  return { ok: check.ok, text: out, reason: check.reason };
}

/**
 * Check a plain-text translation against its source: it must carry the
 * source's placeholders and markers, and each protected term the source
 * contains exactly as often as the source does. `restore` runs it once the
 * tokens are back, and a value taken from another environment's catalogue or
 * from the overrides file goes through it as is, so all three pass the same
 * check.
 */
function checkTranslation(text, sourceEnglish, protectedTerms = []) {
  if (typeof text !== "string" || text.trim() === "") {
    return { ok: false, reason: "the value is not a non-empty string" };
  }
  const want = signature(sourceEnglish);
  const got = signature(text);
  if (want.placeholders.join("|") !== got.placeholders.join("|")) {
    return { ok: false, reason: "placeholders do not match the source" };
  }
  if (want.markers !== got.markers) {
    return { ok: false, reason: "component markers do not match the source" };
  }
  const terms = [...new Set(protectedTerms.filter(Boolean))];
  const expected = countTerms(sourceEnglish, terms);
  const found = countTerms(text, terms);
  for (const term of terms) {
    if (expected[term] > 0 && found[term] !== expected[term]) {
      return { ok: false, reason: `protected term "${term}" does not appear exactly as in the source` };
    }
  }
  return { ok: true, reason: null };
}

// ---------------------------------------------------------------------------
// Delta and merge
// ---------------------------------------------------------------------------

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/**
 * Split a locale's current catalogue against the extracted English.
 *
 * Each key in `en.json` takes the first value that applies:
 *   1. `overrides[key]`, a reviewed correction from the consumer's repo (one
 *      equal to this environment's value is already published, so it counts as
 *      reused, the way an equal fallback value does);
 *   2. with `fallbackMode: "missing"` (the default), the key's value in `prev`
 *      (this environment's CDN catalogue), else in `fallback` (another
 *      environment's, e.g. the staging catalogue QA reviewed);
 *      with `fallbackMode: "prefer"`, `fallback` first and `prev` second;
 *   3. otherwise the key is missing and goes to Rosetta.
 * A fallback value is used only if it passes `checkTranslation`; one that does
 * not is reported in `rejectedFallback` and the key carries on to `prev` or
 * Rosetta. Keys are the crc32 of the English text, so an equal key in another
 * environment means an equal source. Keys of `prev` that are no longer in
 * `en.json` are pruned; keys only the fallback has are never added.
 */
function planLocale(en, prev, { fallback = {}, fallbackMode = "missing", overrides = {}, protectedTerms = [] } = {}) {
  const missing = [];
  const reuse = {};
  const fromFallback = {};
  const overridden = {};
  const rejectedFallback = [];
  for (const key of Object.keys(en)) {
    const own = has(prev, key) && typeof prev[key] === "string" ? prev[key] : undefined;
    if (has(overrides, key)) {
      if (overrides[key] === own) reuse[key] = own;
      else overridden[key] = overrides[key];
      continue;
    }
    let other;
    if (has(fallback, key) && (fallbackMode === "prefer" || own === undefined)) {
      const check = checkTranslation(fallback[key], en[key], protectedTerms);
      if (check.ok) other = fallback[key];
      else rejectedFallback.push({ key, english: en[key], reason: check.reason });
    }
    if (other !== undefined && other !== own) {
      fromFallback[key] = other;
    } else if (own !== undefined) {
      reuse[key] = own;
    } else {
      missing.push(key);
    }
  }
  const pruned = Object.keys(prev).filter((k) => !has(en, k));
  return { reuse, fromFallback, overridden, missing, pruned, rejectedFallback };
}

/**
 * Build the locale file: reused strings plus the newly translated ones that
 * pass the token check. A key that was not returned, or whose tokens broke, is
 * left out (runtime falls back to English; the next run retries it).
 */
function mergeLocale({ en, plan, translated, tokensByKey, failedKeys, failureMessage }) {
  const fromFallback = plan.fromFallback || {};
  const overridden = plan.overridden || {};
  const catalogue = { ...plan.reuse, ...fromFallback, ...overridden };
  const keptBack = [];
  let added = 0;
  for (const key of plan.missing) {
    if (failedKeys && failedKeys.has(key)) {
      keptBack.push({ key, english: en[key], reason: `language failed in Rosetta: ${failureMessage || "see errors"}` });
      continue;
    }
    const value = translated ? translated[key] : undefined;
    if (typeof value !== "string" || value.trim() === "") {
      keptBack.push({ key, english: en[key], reason: "not returned by Rosetta" });
      continue;
    }
    const result = restore(value, tokensByKey[key] || [], en[key]);
    if (!result.ok) {
      keptBack.push({ key, english: en[key], reason: result.reason });
      continue;
    }
    catalogue[key] = result.text;
    added += 1;
  }
  return {
    catalogue,
    keptBack,
    added,
    reused: Object.keys(plan.reuse).length,
    fromFallback: Object.keys(fromFallback).length,
    overridden: Object.keys(overridden).length,
    pruned: plan.pruned.length,
  };
}

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

/**
 * Validate the consumer's overrides file and resolve it to catalogue keys.
 *
 * The file is `{ "<locale>": { "<English source text>": "<translation>" } }`.
 * Entries are keyed by the English text, not the crc32 key, so a pull request
 * that adds one shows what it corrects; and a reworded string has a new key,
 * so its old override stops applying instead of silently landing on new text.
 *
 * Throws (failing the run) on a malformed file, an unknown locale code, two
 * codes for the same language (e.g. "zh-CN" and "zh_cn"), or a value that fails
 * `checkTranslation`: the file is reviewed input, so a broken entry must be
 * fixed, not skipped. Values are checked in every locale the file names, so a
 * broken entry fails every run, not only the one that targets its locale. An
 * entry whose English is no longer extracted is reported in `stale`; a known
 * locale this run does not target is reported in `ignoredLocales`.
 */
function resolveOverrides(raw, { en, locales, protectedTerms = [], file = "the overrides file" }) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${file} must be a JSON object of { "<locale>": { "<English text>": "<translation>" } }`);
  }
  const keyByEnglish = new Map(Object.entries(en).map(([key, english]) => [english, key]));
  // Matched by language, so "zh-CN" in the file reaches a run that targets "zh_cn".
  const targeted = new Map(locales.map((l) => [languageNameFor(l), l]));
  const byLocale = Object.fromEntries(locales.map((l) => [l, {}]));
  const codeByLanguage = new Map();
  const stale = [];
  const ignoredLocales = [];
  const problems = [];
  for (const [code, entries] of Object.entries(raw)) {
    const language = languageNameFor(code); // throws on a typo'd locale code
    if (codeByLanguage.has(language)) {
      problems.push(`"${codeByLanguage.get(language)}" and "${code}" both name ${language}; merge them into one`);
      continue;
    }
    codeByLanguage.set(language, code);
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
      problems.push(`"${code}" must map English text to a translation`);
      continue;
    }
    const locale = targeted.get(language);
    if (!locale) ignoredLocales.push(code);
    for (const [english, value] of Object.entries(entries)) {
      const key = keyByEnglish.get(english);
      if (key === undefined) {
        if (locale) stale.push({ locale, english });
        continue;
      }
      const check = checkTranslation(value, english, protectedTerms);
      if (!check.ok) {
        problems.push(`${code} ${JSON.stringify(english)}: ${check.reason}`);
        continue;
      }
      if (locale) byLocale[locale][key] = value;
    }
  }
  if (problems.length) {
    throw new Error(`${file} has ${problems.length} invalid entr${problems.length === 1 ? "y" : "ies"}:\n- ${problems.join("\n- ")}`);
  }
  return { byLocale, stale, ignoredLocales };
}

// ---------------------------------------------------------------------------
// Rosetta client (submit → poll)
// ---------------------------------------------------------------------------

/**
 * Keep each job well under the 1,500,000-byte transport limit Makima
 * documented. Rosetta's limit is not published yet; this assumes it is no lower.
 */
const MAX_CHUNK_BYTES = 400 * 1024;
/** Per-request timeout; a hung socket must not stall the job for hours. */
const FETCH_TIMEOUT_MS = 60 * 1000;

function withTimeout(init, ms) {
  if (typeof AbortSignal === "undefined" || typeof AbortSignal.timeout !== "function") return init;
  return { ...init, signal: AbortSignal.timeout(ms) };
}

/**
 * fetch with a per-request timeout, retrying thrown network errors
 * (ECONNRESET, DNS, TLS, timeout) the same way an HTTP 5xx is retried.
 * Returns the Response; HTTP status handling stays with the caller.
 */
async function fetchWithRetry({ fetchImpl, url, init = {}, sleep, maxAttempts = 5, timeoutMs = FETCH_TIMEOUT_MS }) {
  let attempt = 0;
  for (;;) {
    try {
      return await fetchImpl(url, withTimeout(init, timeoutMs));
    } catch (err) {
      if (attempt >= maxAttempts) {
        throw new Error(`Network error calling ${url} after ${attempt + 1} attempts: ${err && err.message ? err.message : err}`);
      }
      await sleep(retryDelayMs(null, attempt));
      attempt += 1;
    }
  }
}

/** Split a key → text map into chunks that each serialise under the limit. */
function chunkContent(content, maxBytes = MAX_CHUNK_BYTES) {
  const chunks = [];
  let current = {};
  let size = 2;
  for (const [key, text] of Object.entries(content)) {
    const entry = Buffer.byteLength(JSON.stringify({ [key]: text })) + 1;
    if (size + entry > maxBytes && Object.keys(current).length > 0) {
      chunks.push(current);
      current = {};
      size = 2;
    }
    current[key] = text;
    size += entry;
  }
  if (Object.keys(current).length > 0) chunks.push(current);
  return chunks;
}

function retryDelayMs(res, attempt, cap = 30000) {
  const header = res && res.headers && typeof res.headers.get === "function" ? res.headers.get("Retry-After") : null;
  const seconds = header ? Number(header) : NaN;
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, cap);
  return Math.min(3000 * 2 ** attempt, cap);
}

/** Parse a response body: JSON when it is JSON, otherwise `{ raw: text }`. */
function parseBody(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

async function readJson(res) {
  return parseBody(await res.text());
}

const headerOf = (res, name) => (res && res.headers && typeof res.headers.get === "function" ? res.headers.get(name) : null);

/** A redirect's Location as a URL, resolved against the request URL; null if it can't be parsed. */
function parseLocation(location, requestUrl) {
  try {
    return new URL(location, requestUrl || undefined);
  } catch {
    return null;
  }
}

/** Whether a redirect target is Cloudflare Access login: judged by host and path only, never the query. */
const isAccessLogin = (url) => Boolean(url) && (/(^|\.)cloudflareaccess\.com$/i.test(url.hostname) || url.pathname.startsWith("/cdn-cgi/access/"));

/**
 * The error for an unexpected response. Cloudflare in front of the API answers
 * a blocked request with a 403 HTML page, and Cloudflare Access with a
 * redirect to its login page; report either in one line, with the Ray ID,
 * instead of dumping the page into the log. Any other response (an outage
 * page, a wrong host) keeps its status, with the Ray ID when there is one,
 * and a non-JSON body is cut short.
 */
async function httpFailure(res, what, { tokenSent = false, requestUrl } = {}) {
  const text = await res.text().catch(() => "");
  const html = /text\/html/i.test(headerOf(res, "content-type") || "");
  const rayHeader = headerOf(res, "cf-ray");
  const rayId = rayHeader ? rayHeader.split("-")[0] : (text.match(/Ray ID:?\s*(?:<[^>]*>\s*)*([0-9a-f]{16})/i) || [])[1];
  const location = headerOf(res, "location") || "";
  const target = location ? parseLocation(location, requestUrl) : null;
  const redirect = res.status >= 300 && res.status < 400;
  if (redirect && isAccessLogin(target)) {
    return new Error(
      tokenSent
        ? `${what} was redirected to Cloudflare Access login (HTTP ${res.status}): the service token was not accepted. Check or rotate ROSETTA_CF_ACCESS_CLIENT_ID / _SECRET (see the README).`
        : `${what} was redirected to Cloudflare Access login (HTTP ${res.status}): set ROSETTA_CF_ACCESS_CLIENT_ID and ROSETTA_CF_ACCESS_CLIENT_SECRET to a valid service token (see the README).`
    );
  }
  if (res.status === 403 && html && (rayHeader || /cloudflare/i.test(text))) {
    const ray = rayId ? `, Ray ID ${rayId}` : "";
    return new Error(
      tokenSent
        ? `${what} was blocked by Cloudflare (HTTP 403${ray}) although a service token was sent: the token may be wrong, or another Cloudflare rule blocked the request. Share the Ray ID with the Rosetta team (see the README).`
        : `${what} was blocked by Cloudflare (HTTP 403${ray}): if the API requires a Cloudflare Access service token, set ROSETTA_CF_ACCESS_CLIENT_ID / _SECRET; otherwise share the Ray ID with the Rosetta team (see the README).`
    );
  }
  if (redirect) {
    // Rosetta requests do not follow redirects (see rosettaInit); say where it pointed,
    // origin and path only (a query string may carry tokens).
    const where = !location ? "no Location" : target ? `${target.origin}${target.pathname}` : "an unparseable Location";
    return new Error(`${what} was redirected (HTTP ${res.status}) to ${where}; Rosetta requests do not follow redirects, so check ROSETTA_API_BASE.`);
  }
  const body = parseBody(text);
  if (typeof body.raw === "string" && body.raw.length > 300) body.raw = `${body.raw.slice(0, 300)}…`;
  return new Error(`${what} failed with HTTP ${res.status}${rayId ? ` (Ray ID ${rayId})` : ""}: ${JSON.stringify(body)}`);
}

/** Whether extraHeaders carries a Cloudflare Access service token, whatever the header-name casing. */
const hasServiceToken = (extraHeaders) => Object.keys(extraHeaders || {}).some((name) => /^cf-access-client-/i.test(name));

/**
 * Headers for every Rosetta request. `extraHeaders` carries the optional
 * Cloudflare Access service token. Redirects are not followed: Cloudflare
 * Access answers an unauthenticated request with a redirect to its login page,
 * which must surface as an error, not as an HTML page with status 200.
 */
const rosettaInit = (apiKey, extraHeaders, init = {}) => ({
  ...init,
  redirect: "manual",
  headers: { ...(extraHeaders || {}), ...(init.headers || {}), Authorization: `Bearer ${apiKey}` },
});

async function submitJob({ fetchImpl, base, apiKey, extraHeaders, body, sleep, maxAttempts = 5 }) {
  const url = `${base}/v1/translate`;
  let attempt = 0;
  for (;;) {
    // A 5xx after the gateway actually accepted the job would create a
    // duplicate on retry; that costs quota, not correctness, and the
    // `reference` identifies both as the same sync.
    const res = await fetchWithRetry({
      fetchImpl,
      sleep,
      url,
      init: rosettaInit(apiKey, extraHeaders, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    });
    if (res.status === 202 || res.status === 200) {
      const json = await readJson(res);
      if (!json.job_id) throw new Error(`Rosetta accepted the job but returned no job_id: ${JSON.stringify(json)}`);
      return json.job_id;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
      await sleep(retryDelayMs(res, attempt));
      attempt += 1;
      continue;
    }
    throw await httpFailure(res, "Rosetta submit", { tokenSent: hasServiceToken(extraHeaders), requestUrl: url });
  }
}

async function pollJob({ fetchImpl, base, apiKey, extraHeaders, jobId, sleep, maxWaitMs = 30 * 60 * 1000, now = Date.now }) {
  const url = `${base}/v1/translate/${encodeURIComponent(jobId)}`;
  const deadline = now() + maxWaitMs;
  let attempt = 0;
  let transient = 0;
  for (;;) {
    if (now() > deadline) throw new Error(`Rosetta job ${jobId} did not finish within ${maxWaitMs / 1000}s`);
    const res = await fetchWithRetry({
      fetchImpl,
      sleep,
      url,
      init: rosettaInit(apiKey, extraHeaders),
    });
    if (res.status === 429 || res.status >= 500) {
      if (transient >= 8) throw new Error(`Rosetta poll for ${jobId} kept failing with HTTP ${res.status}`);
      await sleep(retryDelayMs(res, transient));
      transient += 1;
      continue;
    }
    if (res.status !== 200) {
      throw await httpFailure(res, `Rosetta poll for ${jobId}`, { tokenSent: hasServiceToken(extraHeaders), requestUrl: url });
    }
    const body = await readJson(res);
    if (body.status === "completed" || body.status === "partial") return body;
    if (body.status === "failed") {
      throw new Error(`Rosetta job ${jobId} failed: ${JSON.stringify(body.error || body.errors || body)}`);
    }
    await sleep(retryDelayMs(null, Math.min(attempt, 3)));
    attempt += 1;
  }
}

/**
 * Translate a key → protected-English map into every target language.
 * Returns `{ status, results, errors, failedKeys }`:
 *   results    { [languageName]: { key: text } } merged across chunks
 *   errors     { [languageName]: lastMessage } for languages that failed anywhere
 *   failedKeys { [languageName]: Set(keys) } the keys of the chunks that failed
 * A failure is tracked per chunk, so a language that succeeded in chunk 1 and
 * failed in chunk 2 keeps chunk 1's translations; only chunk 2's keys are
 * retried on the next run. `status` is `partial` if anything failed.
 */
async function translateContent({ content, targetNames, reference, fetchImpl, base, apiKey, extraHeaders = {}, sleep, log = () => {} }) {
  const results = {};
  const errors = {};
  const failedKeys = {};
  let status = "completed";
  const chunks = chunkContent(content);
  const fail = (language, message, keys) => {
    errors[language] = String(message);
    failedKeys[language] = failedKeys[language] || new Set();
    keys.forEach((k) => failedKeys[language].add(k));
    status = "partial";
  };
  for (let i = 0; i < chunks.length; i += 1) {
    const chunkKeys = Object.keys(chunks[i]);
    const chunkRef = chunks.length > 1 ? `${reference}#${i + 1}of${chunks.length}` : reference;
    const jobId = await submitJob({
      fetchImpl,
      base,
      apiKey,
      extraHeaders,
      sleep,
      body: {
        reference: chunkRef,
        source_language: "English",
        target_languages: targetNames,
        content: chunks[i],
      },
    });
    log(`Submitted job ${jobId} (${chunkKeys.length} strings, ref ${chunkRef})`);
    const body = await pollJob({ fetchImpl, base, apiKey, extraHeaders, jobId, sleep });
    const returned = body.results || {};
    for (const language of targetNames) {
      const value = returned[language];
      if (body.errors && body.errors[language]) {
        fail(language, body.errors[language], chunkKeys);
      } else if (value && typeof value === "object") {
        results[language] = { ...(results[language] || {}), ...value };
      } else {
        fail(language, `no result for ${language} in job ${jobId}`, chunkKeys);
      }
    }
  }
  return { status, results, errors, failedKeys };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Fetch a locale's catalogue from the CDN. `role` only changes the wording of
 * the log and errors: "previous" is this environment's catalogue, "fallback"
 * is FALLBACK_ENVIRONMENT's.
 */
async function fetchPrevious({ fetchImpl, cdnBase, project, environment, locale, log, role = "previous", sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const url = `${cdnBase.replace(/\/$/, "")}/${project}/${environment}/translations/${localeFileName(locale)}`;
  const label = role === "fallback" ? `fallback (${environment})` : "previous";
  const res = await fetchWithRetry({ fetchImpl, sleep, url, init: { headers: { "Cache-Control": "no-cache" } } });
  if (res.status === 404) {
    log(
      role === "fallback"
        ? `No fallback catalogue at ${url} (404) — ${locale} takes no values from ${environment}`
        : `No previous catalogue at ${url} (404) — starting ${locale} from empty`
    );
    return {};
  }
  if (res.status !== 200) throw new Error(`Fetching the ${label} ${locale} catalogue failed: HTTP ${res.status} for ${url}`);
  const json = await readJson(res);
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error(`The ${label} ${locale} catalogue at ${url} is not a JSON object`);
  }
  return json;
}

function buildSummary({ project, environment, reference, status, perLocale, rosettaErrors, dryRun, fallbackEnvironment, fallbackMode, overrides }) {
  const lines = [];
  lines.push(`## Rosetta translation sync — ${project} / ${environment}${dryRun ? " (dry run)" : ""}`);
  lines.push("");
  lines.push(`Reference: \`${reference}\` · Job status: **${status}**`);
  if (fallbackEnvironment) {
    lines.push("");
    lines.push(
      fallbackMode === "prefer"
        ? `Fallback: **${fallbackEnvironment}** values win over ${environment}'s own; "From ${fallbackEnvironment}" counts the values that changed or were missing.`
        : `Fallback: keys ${environment} lacks are taken from **${fallbackEnvironment}** before Rosetta is asked.`
    );
  }
  // The extra columns sit after "Kept back" so existing readers of the table keep their positions.
  const extraHeads = [...(fallbackEnvironment ? [`From ${fallbackEnvironment}`] : []), ...(overrides ? ["Overridden"] : [])];
  lines.push("");
  lines.push(`| Locale | Reused | New | Pruned | Kept back | ${extraHeads.map((h) => `${h} | `).join("")}Note |`);
  lines.push(`| --- | ---: | ---: | ---: | ---: | ${extraHeads.map(() => "---: | ").join("")}--- |`);
  for (const row of perLocale) {
    const extra = [...(fallbackEnvironment ? [row.fromFallback || 0] : []), ...(overrides ? [row.overridden || 0] : [])];
    lines.push(`| ${row.locale} | ${row.reused} | ${row.added} | ${row.pruned} | ${row.keptBack.length} | ${extra.map((n) => `${n} | `).join("")}${row.note || ""} |`);
  }
  const rejected = perLocale.flatMap((r) => (r.rejectedFallback || []).map((k) => ({ locale: r.locale, ...k })));
  if (rejected.length) {
    lines.push("");
    lines.push(`### ${fallbackEnvironment} values not used (failed the token check; ${environment}'s own value or Rosetta used instead)`);
    for (const k of rejected) {
      lines.push(`- **${k.locale}** \`${k.key}\` — ${k.reason}: ${JSON.stringify(k.english)}`);
    }
  }
  if (overrides && (overrides.stale.length || overrides.ignoredLocales.length)) {
    lines.push("");
    lines.push("### Overrides not applied");
    for (const s of overrides.stale) {
      lines.push(`- **${s.locale}** ${JSON.stringify(s.english)} — this English text is no longer extracted; update or remove the entry`);
    }
    for (const code of overrides.ignoredLocales) {
      lines.push(`- **${code}** — not in TARGET_LOCALES for this run`);
    }
  }
  const kept = perLocale.flatMap((r) => r.keptBack.map((k) => ({ locale: r.locale, ...k })));
  if (kept.length) {
    lines.push("");
    lines.push("### Kept back (left out of the file; English shows at runtime; retried next run)");
    for (const k of kept) {
      lines.push(`- **${k.locale}** \`${k.key}\` — ${k.reason}: ${JSON.stringify(k.english)}`);
    }
  }
  const errs = Object.entries(rosettaErrors || {});
  if (errs.length) {
    lines.push("");
    lines.push("### Rosetta errors");
    for (const [language, message] of errs) lines.push(`- **${language}**: ${message}`);
  }
  return lines.join("\n");
}

function appendOutput(file, lines) {
  if (!file) return;
  fs.appendFileSync(file, lines.map((l) => `${l}\n`).join(""));
}

const isSet = (value) => value !== undefined && value !== null && String(value).trim() !== "";

/**
 * Parse ROSETTA_API_BASE into the origin requests are sent to. The token goes
 * to this host, so it must be https, carry no path, query or fragment (the
 * client adds `/v1/translate` itself). Errors never echo the value: a token wired into this input by mistake must
 * not reach the log.
 */
function parseBase(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new Error("ROSETTA_API_BASE must be an https URL: the Rosetta API host");
  }
  if (url.protocol !== "https:") {
    throw new Error("ROSETTA_API_BASE must be an https URL: the Rosetta API host");
  }
  if (!/^\/*$/.test(url.pathname) || url.search || url.hash || url.username || url.password) {
    throw new Error("ROSETTA_API_BASE must be the Rosetta API host only, with no path (the sync adds /v1/translate), query or credentials");
  }
  return url.origin;
}

/**
 * A credential that is sent as a header value, trimmed. A value with a space or
 * a control character inside fails here, naming the setting but never the
 * value: fetch would reject the header with an error that quotes it, and the
 * retry loop would then log that error.
 */
function headerSecret(env, name) {
  const value = String(env[name] ?? "").trim();
  if (/[^\x21-\x7e]/.test(value)) {
    throw new Error(`${name} contains a space, a line break or another character a header cannot carry; set it again without them`);
  }
  return value;
}

/**
 * The optional Cloudflare Access service token in front of the Rosetta API,
 * as the two headers Cloudflare Access reads. Both settings or neither: one
 * without the other is a configuration mistake, not a partial token.
 */
function readServiceToken(env) {
  const id = headerSecret(env, "ROSETTA_CF_ACCESS_CLIENT_ID");
  const secret = headerSecret(env, "ROSETTA_CF_ACCESS_CLIENT_SECRET");
  if (!id && !secret) return {};
  if (!id || !secret) {
    throw new Error("ROSETTA_CF_ACCESS_CLIENT_ID and ROSETTA_CF_ACCESS_CLIENT_SECRET must be set together (a Cloudflare Access service token)");
  }
  return { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret };
}

function readEnv(env) {
  // ROSETTA_API_BASE is deliberately required, with no default, so a consumer
  // always names the host it sends the token to.
  for (const name of ["PROJECT_NAME", "ENVIRONMENT", "TARGET_LOCALES", "ROSETTA_API_TOKEN", "ROSETTA_API_BASE"]) {
    if (!isSet(env[name])) throw new Error(`${name} is required`);
  }
  // Trimmed: a secret pasted with a trailing newline is not a valid header value.
  const token = headerSecret(env, "ROSETTA_API_TOKEN");
  const base = parseBase(env.ROSETTA_API_BASE);
  const extraHeaders = readServiceToken(env);
  const environments = ["staging", "production"];
  const environment = String(env.ENVIRONMENT).trim();
  if (!environments.includes(environment)) {
    throw new Error(`ENVIRONMENT must be "staging" or "production", got "${environment}"`);
  }
  const fallbackEnvironment = String(env.FALLBACK_ENVIRONMENT || "").trim() || null;
  if (fallbackEnvironment && !environments.includes(fallbackEnvironment)) {
    throw new Error(`FALLBACK_ENVIRONMENT must be "staging", "production" or empty, got "${fallbackEnvironment}"`);
  }
  if (fallbackEnvironment === environment) {
    throw new Error(`FALLBACK_ENVIRONMENT must differ from ENVIRONMENT (both are "${environment}")`);
  }
  const fallbackMode = String(env.FALLBACK_MODE || "").trim() || "missing";
  if (!["missing", "prefer"].includes(fallbackMode)) {
    throw new Error(`FALLBACK_MODE must be "missing" or "prefer", got "${fallbackMode}"`);
  }
  if (fallbackMode === "prefer" && !fallbackEnvironment) {
    throw new Error('FALLBACK_MODE "prefer" needs FALLBACK_ENVIRONMENT');
  }
  const locales = String(env.TARGET_LOCALES)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!locales.length) throw new Error("TARGET_LOCALES must list at least one locale code");
  // Resolved once here, so a typo'd code fails before anything is installed or extracted.
  const languageNames = new Map(locales.map((code) => [code, languageNameFor(code)]));
  const project = String(env.PROJECT_NAME).trim();
  return {
    project,
    environment,
    locales,
    languageNames,
    apiKey: token,
    extraHeaders,
    base,
    cdnBase: env.CDN_BASE_URL || "https://translations.deriv.com",
    dryRun: /^(1|true|yes)$/i.test(String(env.DRY_RUN || "")),
    translationsDir: path.resolve(env.TRANSLATIONS_DIR || "./translations"),
    protectedTermsFile: env.PROTECTED_TERMS_FILE ? path.resolve(env.PROTECTED_TERMS_FILE) : null,
    fallbackEnvironment,
    fallbackMode,
    overridesFile: env.OVERRIDES_FILE ? path.resolve(env.OVERRIDES_FILE) : null,
    reference: env.REFERENCE || `${project}/${environment}/${env.GITHUB_SHA || "local"}`,
    outputFile: env.GITHUB_OUTPUT || null,
    summaryFile: env.GITHUB_STEP_SUMMARY || null,
  };
}

function loadProtectedTerms(file) {
  if (!file) return [];
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(parsed) || parsed.some((t) => typeof t !== "string")) {
    throw new Error(`${file} must be a JSON array of strings`);
  }
  return parsed;
}

async function main(env = process.env, io = {}) {
  const fetchImpl = io.fetch || globalThis.fetch;
  const sleep = io.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = io.log || ((m) => console.log(m));
  const cfg = readEnv(env);

  // The API key is never logged, not even derived from: the gateway records its
  // own per-caller fingerprint, which is enough to attribute a call.
  log(`Rosetta sync for ${cfg.project}/${cfg.environment} → ${cfg.locales.join(", ")}${cfg.dryRun ? " (dry run)" : ""}`);

  const enPath = path.join(cfg.translationsDir, "en.json");
  if (!fs.existsSync(enPath)) throw new Error(`${enPath} not found — run deriv-extract-translations first`);
  const en = JSON.parse(fs.readFileSync(enPath, "utf8"));
  const protectedTerms = loadProtectedTerms(cfg.protectedTermsFile);
  const targetNames = cfg.locales.map((code) => cfg.languageNames.get(code));
  const overrides = cfg.overridesFile
    ? resolveOverrides(JSON.parse(fs.readFileSync(cfg.overridesFile, "utf8")), { en, locales: cfg.locales, protectedTerms, file: cfg.overridesFile })
    : null;

  // Plan every locale against its current CDN copy, the fallback environment's
  // copy and the overrides.
  const plans = {};
  const union = new Set();
  for (const locale of cfg.locales) {
    const fetchCatalogue = (environment, role) =>
      fetchPrevious({ fetchImpl, cdnBase: cfg.cdnBase, project: cfg.project, environment, locale, log, role, sleep });
    const prev = await fetchCatalogue(cfg.environment, "previous");
    const fallback = cfg.fallbackEnvironment ? await fetchCatalogue(cfg.fallbackEnvironment, "fallback") : {};
    plans[locale] = planLocale(en, prev, {
      fallback,
      fallbackMode: cfg.fallbackMode,
      overrides: overrides ? overrides.byLocale[locale] : {},
      protectedTerms,
    });
    plans[locale].missing.forEach((k) => union.add(k));
    const p = plans[locale];
    log(
      `${locale}: ${Object.keys(p.reuse).length} reused` +
        (cfg.fallbackEnvironment ? `, ${Object.keys(p.fromFallback).length} from ${cfg.fallbackEnvironment}` : "") +
        (overrides ? `, ${Object.keys(p.overridden).length} overridden` : "") +
        `, ${p.missing.length} to translate, ${p.pruned.length} pruned`
    );
  }

  // Protect and translate the union of missing keys once for all languages.
  const tokensByKey = {};
  const content = {};
  for (const key of union) {
    const p = protect(en[key], protectedTerms);
    tokensByKey[key] = p.tokens;
    content[key] = p.text;
  }

  let status = "noop";
  let results = {};
  let rosettaErrors = {};
  let failedKeys = {};
  if (union.size > 0) {
    const out = await translateContent({ content, targetNames, reference: cfg.reference, fetchImpl, base: cfg.base, apiKey: cfg.apiKey, extraHeaders: cfg.extraHeaders, sleep, log });
    status = out.status;
    results = out.results;
    rosettaErrors = out.errors;
    failedKeys = out.failedKeys;
  } else {
    log("Nothing new to translate — every key already has a value");
  }

  // Merge and write per locale. A key whose chunk failed, or that came back
  // broken, is left out: the file keeps every reused string plus the new ones
  // that passed, the runtime shows English for the rest, and the next run
  // retries exactly those keys because they are still missing.
  fs.mkdirSync(cfg.translationsDir, { recursive: true });
  const perLocale = [];
  for (const locale of cfg.locales) {
    const languageName = cfg.languageNames.get(locale);
    const plan = plans[locale];
    const merged = mergeLocale({
      en,
      plan,
      translated: results[languageName],
      tokensByKey,
      failedKeys: failedKeys[languageName],
      failureMessage: rosettaErrors[languageName],
    });
    fs.writeFileSync(path.join(cfg.translationsDir, localeFileName(locale)), JSON.stringify(merged.catalogue));
    const note = rosettaErrors[languageName] ? "Rosetta failed this language for some or all chunks; those keys are left out and retried next run" : "";
    perLocale.push({ locale, ...merged, rejectedFallback: plan.rejectedFallback, note });
  }

  const keptBackTotal = perLocale.reduce((n, r) => n + r.keptBack.length, 0);
  const fromFallbackTotal = perLocale.reduce((n, r) => n + r.fromFallback, 0);
  const overriddenTotal = perLocale.reduce((n, r) => n + r.overridden, 0);
  const prunedTotal = perLocale.reduce((n, r) => n + r.pruned, 0);
  // `noop` means the uploaded catalogues equal the CDN's. With nothing to
  // translate, the fallback, an override or pruning can still change them.
  if (status === "noop" && fromFallbackTotal + overriddenTotal + prunedTotal > 0) status = "completed";
  const summary = buildSummary({
    project: cfg.project,
    environment: cfg.environment,
    reference: cfg.reference,
    status,
    perLocale,
    rosettaErrors,
    dryRun: cfg.dryRun,
    fallbackEnvironment: cfg.fallbackEnvironment,
    fallbackMode: cfg.fallbackMode,
    overrides,
  });
  log(summary);
  if (cfg.summaryFile) fs.appendFileSync(cfg.summaryFile, `${summary}\n`);
  // Surface problems as workflow annotations, not only in the summary table.
  if (status === "partial") log(`::warning::Rosetta returned a partial result for ${cfg.project}/${cfg.environment}: ${Object.keys(rosettaErrors).join(", ")} — see the job summary`);
  if (keptBackTotal > 0) log(`::warning::${keptBackTotal} string(s) were kept out of the ${cfg.project}/${cfg.environment} catalogues because a placeholder, marker or protected term did not survive translation — see the job summary`);
  if (overrides && overrides.stale.length) log(`::warning::${overrides.stale.length} override(s) in ${cfg.overridesFile} name English text that is no longer extracted — see the job summary`);
  appendOutput(cfg.outputFile, [
    `status=${status}`,
    `kept_back=${keptBackTotal}`,
    `translated=${union.size}`,
    `from_fallback=${fromFallbackTotal}`,
    `overridden=${overriddenTotal}`,
  ]);
  return { status, perLocale, keptBackTotal, fromFallbackTotal, overriddenTotal };
}

/** Small file helpers for tests; the test runner has no Node type definitions. */
const testSupport = {
  makeTempDir(prefix = "rosetta-sync-") {
    return fs.mkdtempSync(path.join(require("os").tmpdir(), prefix));
  },
  writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  },
  readJson(file) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  },
  readText(file) {
    return fs.readFileSync(file, "utf8");
  },
  join: (...parts) => path.join(...parts),
};

module.exports = {
  LANGUAGES,
  languageNameFor,
  localeFileName,
  protect,
  restore,
  checkTranslation,
  planLocale,
  mergeLocale,
  resolveOverrides,
  chunkContent,
  retryDelayMs,
  submitJob,
  pollJob,
  translateContent,
  fetchPrevious,
  fetchWithRetry,
  countTerms,
  buildSummary,
  readEnv,
  // Exported so callers that load this file directly (deriv-api-templates)
  // validate the base URL and the service token with these rules, not a copy.
  parseBase,
  readServiceToken,
  main,
  testSupport,
};

if (require.main === module) {
  // `--check-settings` validates the environment only; the action runs it
  // before installing dependencies and extracting, so a bad setting fails first.
  const run = process.argv.includes("--check-settings") ? async () => readEnv(process.env) : () => main();
  run().catch((err) => {
    console.error(`✗ ${err && err.message ? err.message : err}`);
    process.exit(1);
  });
}
