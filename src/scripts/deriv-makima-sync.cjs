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
 *   PROTECTED_TERMS_FILE (optional JSON array of strings), TRANSLATIONS_DIR
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
  { code: "zh-CN", name: "Simplified Chinese" },
  { code: "zh-Hant-TW", name: "Traditional Chinese" },
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
  const hit = LANGUAGES.find((l) => l.code.toLowerCase() === wanted);
  if (!hit) {
    throw new Error(
      `Unknown locale "${code}". Known codes: ${LANGUAGES.map((l) => l.code).join(", ")}`
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

const PLACEHOLDER_RE = /\{\{\s*[A-Za-z0-9_.-]+\s*\}\}/g;
const MARKER_RE = /<(\/?)(\d+)>/g;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`, "gu");
    out = out.replace(re, () => {
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

  if (/\u0000|<\/?(?:ph|pt|c\d+)\b/.test(out)) {
    return { ok: false, text: out, reason: "a protected token was altered or lost" };
  }
  const want = signature(sourceEnglish);
  const got = signature(out);
  if (want.placeholders.join("|") !== got.placeholders.join("|")) {
    return { ok: false, text: out, reason: "placeholders do not match the source" };
  }
  if (want.markers !== got.markers) {
    return { ok: false, text: out, reason: "component markers do not match the source" };
  }
  const expectedTerms = tokens.filter((t) => t.kind === "pt").map((t) => t.original);
  for (const term of new Set(expectedTerms)) {
    const wanted = expectedTerms.filter((t) => t === term).length;
    const found = out.split(term).length - 1;
    if (found !== wanted) {
      return { ok: false, text: out, reason: `protected term "${term}" does not appear exactly as in the source` };
    }
  }
  return { ok: true, text: out, reason: null };
}

// ---------------------------------------------------------------------------
// Delta and merge
// ---------------------------------------------------------------------------

/** Split a locale's current catalogue against the extracted English. */
function planLocale(en, prev) {
  const missing = [];
  const reuse = {};
  for (const key of Object.keys(en)) {
    if (Object.prototype.hasOwnProperty.call(prev, key) && typeof prev[key] === "string") {
      reuse[key] = prev[key];
    } else {
      missing.push(key);
    }
  }
  const pruned = Object.keys(prev).filter((k) => !Object.prototype.hasOwnProperty.call(en, k));
  return { reuse, missing, pruned };
}

/**
 * Build the locale file: reused strings plus the newly translated ones that
 * pass the token check. A key that was not returned, or whose tokens broke, is
 * left out (runtime falls back to English; the next run retries it).
 */
function mergeLocale({ en, plan, translated, tokensByKey }) {
  const catalogue = { ...plan.reuse };
  const keptBack = [];
  let added = 0;
  for (const key of plan.missing) {
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
  return { catalogue, keptBack, added, reused: Object.keys(plan.reuse).length, pruned: plan.pruned.length };
}

// ---------------------------------------------------------------------------
// Makima client (submit → poll)
// ---------------------------------------------------------------------------

const DEFAULT_BASE = "https://pedro-api-dev.deriv.ai";
/** Keep each job well under Makima's 1,500,000-byte transport limit. */
const MAX_CHUNK_BYTES = 400 * 1024;

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
    const res = await fetchImpl(`${base}/api/makima/translate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
    const res = await fetchImpl(`${base}/api/makima/translate/${encodeURIComponent(jobId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
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
 * Returns `{ status, results: { [languageName]: { key: text } }, errors }`,
 * merged across chunks; `status` is `partial` if any chunk or language was.
 */
async function translateContent({ content, targetNames, reference, fetchImpl, base, apiKey, sleep, log = () => {} }) {
  const results = {};
  const errors = {};
  let status = "completed";
  const chunks = chunkContent(content);
  for (let i = 0; i < chunks.length; i += 1) {
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
    log(`Submitted job ${jobId} (${Object.keys(chunks[i]).length} strings, ref ${chunkRef})`);
    const body = await pollJob({ fetchImpl, base, apiKey, jobId, sleep });
    if (body.status === "partial") status = "partial";
    for (const [language, value] of Object.entries(body.results || {})) {
      if (value && typeof value === "object") {
        results[language] = { ...(results[language] || {}), ...value };
      } else {
        errors[language] = `unexpected result shape for ${language} in job ${jobId}`;
        status = "partial";
      }
    }
    for (const [language, message] of Object.entries(body.errors || {})) {
      errors[language] = String(message);
      status = "partial";
    }
  }
  return { status, results, errors };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function fetchPrevious({ fetchImpl, cdnBase, project, environment, locale, log }) {
  const url = `${cdnBase.replace(/\/$/, "")}/${project}/${environment}/translations/${localeFileName(locale)}`;
  const res = await fetchImpl(url, { headers: { "Cache-Control": "no-cache" } });
  if (res.status === 404) {
    log(`No previous catalogue at ${url} (404) — starting ${locale} from empty`);
    return {};
  }
  if (res.status !== 200) throw new Error(`Fetching the previous ${locale} catalogue failed: HTTP ${res.status} for ${url}`);
  const json = await readJson(res);
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error(`Previous ${locale} catalogue at ${url} is not a JSON object`);
  }
  return json;
}

function buildSummary({ project, environment, reference, status, perLocale, makimaErrors, dryRun }) {
  const lines = [];
  lines.push(`## Makima translation sync — ${project} / ${environment}${dryRun ? " (dry run)" : ""}`);
  lines.push("");
  lines.push(`Reference: \`${reference}\` · Job status: **${status}**`);
  lines.push("");
  lines.push("| Locale | Reused | New | Pruned | Kept back | Note |");
  lines.push("| --- | ---: | ---: | ---: | ---: | --- |");
  for (const row of perLocale) {
    lines.push(`| ${row.locale} | ${row.reused} | ${row.added} | ${row.pruned} | ${row.keptBack.length} | ${row.note || ""} |`);
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
  const required = ["PROJECT_NAME", "ENVIRONMENT", "TARGET_LOCALES", "MAKIMA_API_KEY"];
  for (const name of required) {
    if (!env[name] || !String(env[name]).trim()) throw new Error(`${name} is required`);
  }
  const environment = String(env.ENVIRONMENT).trim();
  if (!["staging", "production"].includes(environment)) {
    throw new Error(`ENVIRONMENT must be "staging" or "production", got "${environment}"`);
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
    base: (env.MAKIMA_API_BASE || DEFAULT_BASE).replace(/\/$/, ""),
    cdnBase: env.CDN_BASE_URL || "https://translations.deriv.com",
    dryRun: /^(1|true|yes)$/i.test(String(env.DRY_RUN || "")),
    translationsDir: path.resolve(env.TRANSLATIONS_DIR || "./translations"),
    protectedTermsFile: env.PROTECTED_TERMS_FILE ? path.resolve(env.PROTECTED_TERMS_FILE) : null,
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

  // Plan every locale against its current CDN copy.
  const plans = {};
  const union = new Set();
  for (const locale of cfg.locales) {
    const prev = await fetchPrevious({ fetchImpl, cdnBase: cfg.cdnBase, project: cfg.project, environment: cfg.environment, locale, log });
    plans[locale] = planLocale(en, prev);
    plans[locale].missing.forEach((k) => union.add(k));
    log(`${locale}: ${Object.keys(plans[locale].reuse).length} reused, ${plans[locale].missing.length} to translate, ${plans[locale].pruned.length} pruned`);
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
  if (union.size > 0) {
    const out = await translateContent({ content, targetNames, reference: cfg.reference, fetchImpl, base: cfg.base, apiKey: cfg.apiKey, sleep, log });
    status = out.status;
    results = out.results;
    makimaErrors = out.errors;
  } else {
    log("Nothing new to translate — every key is already on the CDN");
  }

  // Merge and write per locale.
  fs.mkdirSync(cfg.translationsDir, { recursive: true });
  const perLocale = [];
  for (const locale of cfg.locales) {
    const languageName = makimaNameFor(locale);
    const plan = plans[locale];
    const failed = Object.prototype.hasOwnProperty.call(makimaErrors, languageName);
    if (failed && plan.missing.length > 0) {
      // Leave this locale exactly as the CDN has it (pruned keys included):
      // nothing new is known, and a half-written file would be worse.
      const prevFile = { ...plan.reuse };
      fs.writeFileSync(path.join(cfg.translationsDir, localeFileName(locale)), JSON.stringify(prevFile));
      perLocale.push({ locale, reused: Object.keys(plan.reuse).length, added: 0, pruned: plan.pruned.length, keptBack: plan.missing.map((key) => ({ key, english: en[key], reason: `language failed: ${makimaErrors[languageName]}` })), note: "language failed — file unchanged apart from pruning" });
      continue;
    }
    const merged = mergeLocale({ en, plan, translated: results[languageName], tokensByKey });
    fs.writeFileSync(path.join(cfg.translationsDir, localeFileName(locale)), JSON.stringify(merged.catalogue));
    perLocale.push({ locale, ...merged });
  }

  const keptBackTotal = perLocale.reduce((n, r) => n + r.keptBack.length, 0);
  const summary = buildSummary({ project: cfg.project, environment: cfg.environment, reference: cfg.reference, status, perLocale, makimaErrors, dryRun: cfg.dryRun });
  log(summary);
  if (cfg.summaryFile) fs.appendFileSync(cfg.summaryFile, `${summary}\n`);
  appendOutput(cfg.outputFile, [`status=${status}`, `kept_back=${keptBackTotal}`, `translated=${union.size}`]);
  return { status, perLocale, keptBackTotal };
}

module.exports = {
  LANGUAGES,
  makimaNameFor,
  localeFileName,
  protect,
  restore,
  planLocale,
  mergeLocale,
  chunkContent,
  retryDelayMs,
  submitJob,
  pollJob,
  translateContent,
  fetchPrevious,
  buildSummary,
  readEnv,
  main,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`✗ ${err && err.message ? err.message : err}`);
    process.exit(1);
  });
}
