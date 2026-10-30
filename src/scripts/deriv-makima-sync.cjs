#!/usr/bin/env node

/* eslint-disable */
"use strict";

/**
 * deriv-makima-sync — translate the extracted `translations/en.json` with the
 * Makima gateway and write one `translations/<locale>.json` per target locale,
 * in the same shape the Crowdin-based action produced, so the runtime
 * (`initializeI18n`, which fetches `<cdnUrl>/translations/<lang>.json` and looks
 * strings up by crc32 of the English text) cannot tell the two apart.
 *
 * It translates only the delta: the current `<locale>.json` is fetched from the
 * CDN first and acts as the translation memory. A key already there is kept
 * verbatim, a key no longer in `en.json` is pruned, and only keys the CDN does
 * not have are sent to Makima. Because keys are the crc32 of the English text,
 * a reworded string is simply a new key.
 *
 * Two optional sources come before Makima (see `planLocale`):
 *   - FALLBACK_ENVIRONMENT: another environment's CDN catalogue, so production
 *     takes the value QA reviewed on staging instead of translating the key a
 *     second time. FALLBACK_MODE "missing" (default) uses it only for keys this
 *     environment lacks; "prefer" lets it win over this environment's own value.
 *   - OVERRIDES_FILE: reviewed corrections committed in the consumer's repo,
 *     applied last in every environment (see `resolveOverrides`).
 *
 * Placeholders (`{{name}}`), i18next component markers (`<0>…</0>`) and
 * caller-supplied protected terms (brand and product names) are swapped for
 * HTML tokens Makima preserves, restored afterwards, and verified to appear
 * exactly once. A string whose tokens did not survive is left OUT of the
 * locale file: the runtime then falls back to English for it, and the next run
 * retries it because its key is still missing.
 *
 * Environment (the composite action maps its inputs onto these):
 *   PROJECT_NAME, ENVIRONMENT (staging|production), TARGET_LOCALES (e.g.
 *   "es,fr,pt"), MAKIMA_API_KEY, MAKIMA_API_BASE, CDN_BASE_URL, DRY_RUN,
 *   PROTECTED_TERMS_FILE (optional JSON array of strings), FALLBACK_ENVIRONMENT,
 *   FALLBACK_MODE, OVERRIDES_FILE (all optional), TRANSLATIONS_DIR
 *   (default ./translations), REFERENCE (default "<project>/<env>/<GITHUB_SHA>").
 *
 * The API key is read from the environment and never written to any log.
 *
 * Exit code: non-zero only for hard failures (bad configuration, auth, the job
 * failing outright, a timeout). A `partial` job writes the locales that
 * succeeded and reports `status=partial` through $GITHUB_OUTPUT so the action
 * can fail the run after uploading.
 */

const fs = require("fs");
const path = require("path");

/** Locale code → Makima language name, from the Makima API guide (39 languages). */
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
 * name Makima expects (e.g. "Spanish"). The runtime lower-cases the code when
 * it builds the URL, so matching is case-insensitive; the file is always
 * written with the lower-case code.
 */
function makimaNameFor(code) {
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
const ENTITY_RE = /&(amp|lt|gt|quot|#39|apos);/g;
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'" };

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
 * Replace everything Makima must not translate with HTML tokens it preserves:
 *   `{{name}}`      → `<ph i="N"></ph>`   (an element with no visible text)
 *   `<0>…</0>`      → `<c0>…</c0>`        (valid tag names; the inner text is still translated)
 *   protected term  → `<pt i="N"></pt>`   (brand names; the term is kept in `tokens`)
 * Returns the protected text and the token table needed to restore it.
 */
function protect(text, protectedTerms = []) {
  const tokens = [];
  let out = text.replace(PLACEHOLDER_RE, (m) => {
    tokens.push({ kind: "ph", original: m });
    return `<ph i="${tokens.length - 1}"></ph>`;
  });
  out = out.replace(MARKER_RE, (_m, slash, n) => `<${slash}c${n}>`);
  const terms = [...new Set(protectedTerms.filter(Boolean))].sort(
    (a, b) => b.length - a.length
  );
  for (const term of terms) {
    out = out.replace(termRegExp(term), () => {
      tokens.push({ kind: "pt", original: term });
      return `<pt i="${tokens.length - 1}"></pt>`;
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
  // Makima may serialise an empty element as <ph i="1"></ph>, <ph i="1"/> or
  // <ph i="1" /> and may put whitespace inside; accept all of them.
  out = out.replace(/<(ph|pt)\s+i="(\d+)"\s*(?:\/>|>\s*<\/\1\s*>)/g, (_m, kind, i) => {
    const token = tokens[Number(i)];
    return token && token.kind === kind ? token.original : `\u0000${kind}${i}\u0000`;
  });
  out = out.replace(/<(\/?)c(\d+)>/g, "<$1$2>");
  // An HTML-aware translator may escape `&`, `<`, `>` and quotes on the way
  // back. Decode the basic entities only when the source had none of them, so
  // a source that legitimately contains `&amp;` is left alone.
  if (!ENTITY_RE.test(sourceEnglish)) {
    out = out.replace(ENTITY_RE, (_m, name) => ENTITIES[name]);
  }
  ENTITY_RE.lastIndex = 0;

  if (/\u0000|<\/?(?:ph|pt|c\d+)\b/.test(out)) {
    return { ok: false, text: out, reason: "a protected token was altered or lost" };
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
 *   3. otherwise the key is missing and goes to Makima.
 * A fallback value is used only if it passes `checkTranslation`; one that does
 * not is reported in `rejectedFallback` and the key carries on to `prev` or
 * Makima. Keys are the crc32 of the English text, so an equal key in another
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
      keptBack.push({ key, english: en[key], reason: `language failed in Makima: ${failureMessage || "see errors"}` });
      continue;
    }
    const value = translated ? translated[key] : undefined;
    if (typeof value !== "string" || value.trim() === "") {
      keptBack.push({ key, english: en[key], reason: "not returned by Makima" });
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
  const targeted = new Map(locales.map((l) => [makimaNameFor(l), l]));
  const byLocale = Object.fromEntries(locales.map((l) => [l, {}]));
  const codeByLanguage = new Map();
  const stale = [];
  const ignoredLocales = [];
  const problems = [];
  for (const [code, entries] of Object.entries(raw)) {
    const language = makimaNameFor(code); // throws on a typo'd locale code
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
// Makima client (submit → poll)
// ---------------------------------------------------------------------------

/** Keep each job well under Makima's 1,500,000-byte transport limit. */
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

async function readJson(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

async function submitJob({ fetchImpl, base, apiKey, body, sleep, maxAttempts = 5 }) {
  let attempt = 0;
  for (;;) {
    // A 5xx after the gateway actually accepted the job would create a
    // duplicate on retry; that costs quota, not correctness, and the
    // `reference` identifies both as the same sync.
    const res = await fetchWithRetry({
      fetchImpl,
      sleep,
      url: `${base}/api/makima/translate`,
      init: {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    });
    if (res.status === 202 || res.status === 200) {
      const json = await readJson(res);
      if (!json.job_id) throw new Error(`Makima accepted the job but returned no job_id: ${JSON.stringify(json)}`);
      return json.job_id;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
      await sleep(retryDelayMs(res, attempt));
      attempt += 1;
      continue;
    }
    const detail = await readJson(res);
    throw new Error(`Makima submit failed with HTTP ${res.status}: ${JSON.stringify(detail)}`);
  }
}

async function pollJob({ fetchImpl, base, apiKey, jobId, sleep, maxWaitMs = 30 * 60 * 1000, now = Date.now }) {
  const deadline = now() + maxWaitMs;
  let attempt = 0;
  let transient = 0;
  for (;;) {
    if (now() > deadline) throw new Error(`Makima job ${jobId} did not finish within ${maxWaitMs / 1000}s`);
    const res = await fetchWithRetry({
      fetchImpl,
      sleep,
      url: `${base}/api/makima/translate/${encodeURIComponent(jobId)}`,
      init: { headers: { Authorization: `Bearer ${apiKey}` } },
    });
    if (res.status === 429 || res.status >= 500) {
      if (transient >= 8) throw new Error(`Makima poll for ${jobId} kept failing with HTTP ${res.status}`);
      await sleep(retryDelayMs(res, transient));
      transient += 1;
      continue;
    }
    if (res.status !== 200) {
      const detail = await readJson(res);
      throw new Error(`Makima poll for ${jobId} failed with HTTP ${res.status}: ${JSON.stringify(detail)}`);
    }
    const body = await readJson(res);
    if (body.status === "completed" || body.status === "partial") return body;
    if (body.status === "failed") {
      throw new Error(`Makima job ${jobId} failed: ${JSON.stringify(body.error || body.errors || body)}`);
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
async function translateContent({ content, targetNames, reference, fetchImpl, base, apiKey, sleep, log = () => {} }) {
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
      sleep,
      body: {
        reference: chunkRef,
        source_language: "English",
        target_languages: targetNames,
        content: chunks[i],
      },
    });
    log(`Submitted job ${jobId} (${chunkKeys.length} strings, ref ${chunkRef})`);
    const body = await pollJob({ fetchImpl, base, apiKey, jobId, sleep });
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

function buildSummary({ project, environment, reference, status, perLocale, makimaErrors, dryRun, fallbackEnvironment, fallbackMode, overrides }) {
  const lines = [];
  lines.push(`## Makima translation sync — ${project} / ${environment}${dryRun ? " (dry run)" : ""}`);
  lines.push("");
  lines.push(`Reference: \`${reference}\` · Job status: **${status}**`);
  if (fallbackEnvironment) {
    lines.push("");
    lines.push(
      fallbackMode === "prefer"
        ? `Fallback: **${fallbackEnvironment}** values win over ${environment}'s own; "From ${fallbackEnvironment}" counts the values that changed or were missing.`
        : `Fallback: keys ${environment} lacks are taken from **${fallbackEnvironment}** before Makima is asked.`
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
    lines.push(`### ${fallbackEnvironment} values not used (failed the token check; ${environment}'s own value or Makima used instead)`);
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
  const errs = Object.entries(makimaErrors || {});
  if (errs.length) {
    lines.push("");
    lines.push("### Makima errors");
    for (const [language, message] of errs) lines.push(`- **${language}**: ${message}`);
  }
  return lines.join("\n");
}

function appendOutput(file, lines) {
  if (!file) return;
  fs.appendFileSync(file, lines.map((l) => `${l}\n`).join(""));
}

function readEnv(env) {
  // MAKIMA_API_BASE is deliberately required: the guide's only published host
  // is a `-dev` one, and no consumer should fall back to it without noticing.
  const required = ["PROJECT_NAME", "ENVIRONMENT", "TARGET_LOCALES", "MAKIMA_API_KEY", "MAKIMA_API_BASE"];
  for (const name of required) {
    if (!env[name] || !String(env[name]).trim()) throw new Error(`${name} is required`);
  }
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
  const project = String(env.PROJECT_NAME).trim();
  return {
    project,
    environment,
    locales,
    apiKey: String(env.MAKIMA_API_KEY),
    base: String(env.MAKIMA_API_BASE).trim().replace(/\/$/, ""),
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
  log(`Makima sync for ${cfg.project}/${cfg.environment} → ${cfg.locales.join(", ")}${cfg.dryRun ? " (dry run)" : ""}`);

  const enPath = path.join(cfg.translationsDir, "en.json");
  if (!fs.existsSync(enPath)) throw new Error(`${enPath} not found — run deriv-extract-translations first`);
  const en = JSON.parse(fs.readFileSync(enPath, "utf8"));
  const protectedTerms = loadProtectedTerms(cfg.protectedTermsFile);
  const targetNames = cfg.locales.map(makimaNameFor);
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
  let makimaErrors = {};
  let failedKeys = {};
  if (union.size > 0) {
    const out = await translateContent({ content, targetNames, reference: cfg.reference, fetchImpl, base: cfg.base, apiKey: cfg.apiKey, sleep, log });
    status = out.status;
    results = out.results;
    makimaErrors = out.errors;
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
    const languageName = makimaNameFor(locale);
    const plan = plans[locale];
    const merged = mergeLocale({
      en,
      plan,
      translated: results[languageName],
      tokensByKey,
      failedKeys: failedKeys[languageName],
      failureMessage: makimaErrors[languageName],
    });
    fs.writeFileSync(path.join(cfg.translationsDir, localeFileName(locale)), JSON.stringify(merged.catalogue));
    const note = makimaErrors[languageName] ? "Makima failed this language for some or all chunks; those keys are left out and retried next run" : "";
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
    makimaErrors,
    dryRun: cfg.dryRun,
    fallbackEnvironment: cfg.fallbackEnvironment,
    fallbackMode: cfg.fallbackMode,
    overrides,
  });
  log(summary);
  if (cfg.summaryFile) fs.appendFileSync(cfg.summaryFile, `${summary}\n`);
  // Surface problems as workflow annotations, not only in the summary table.
  if (status === "partial") log(`::warning::Makima returned a partial result for ${cfg.project}/${cfg.environment}: ${Object.keys(makimaErrors).join(", ")} — see the job summary`);
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
  makeTempDir(prefix = "makima-sync-") {
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
  makimaNameFor,
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
  main,
  testSupport,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`✗ ${err && err.message ? err.message : err}`);
    process.exit(1);
  });
}
