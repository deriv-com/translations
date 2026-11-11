import { describe, expect, it, vi } from "vitest";

type Token = { kind: "ph" | "pt"; original: string };
type KeptBack = { key: string; english: string; reason: string };
type Plan = {
  reuse: Record<string, string>;
  fromFallback?: Record<string, string>;
  overridden?: Record<string, string>;
  missing: string[];
  pruned: string[];
  rejectedFallback?: KeptBack[];
};
type PlanOptions = {
  fallback?: Record<string, string>;
  fallbackMode?: "missing" | "prefer";
  overrides?: Record<string, string>;
  protectedTerms?: string[];
};
type MergeResult = {
  catalogue: Record<string, string>;
  keptBack: KeptBack[];
  added: number;
  reused: number;
  fromFallback: number;
  overridden: number;
  pruned: number;
};
type Overrides = {
  byLocale: Record<string, Record<string, string>>;
  stale: { locale: string; english: string }[];
  ignoredLocales: string[];
};
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
type Env = Record<string, string | undefined>;

interface SyncModule {
  LANGUAGES: { code: string; name: string; aliases?: string[] }[];
  languageNameFor(code: string): string;
  localeFileName(code: string): string;
  protect(text: string, terms?: string[]): { text: string; tokens: Token[] };
  restore(translated: string, tokens: Token[], source: string): { ok: boolean; text: string; reason: string | null };
  countTerms(text: string, terms: string[]): Record<string, number>;
  checkTranslation(text: unknown, source: string, terms?: string[]): { ok: boolean; reason: string | null };
  planLocale(en: Record<string, string>, prev: Record<string, string>, options?: PlanOptions): Plan;
  resolveOverrides(raw: unknown, args: { en: Record<string, string>; locales: string[]; protectedTerms?: string[]; file?: string }): Overrides;
  mergeLocale(args: {
    en: Record<string, string>;
    plan: Plan;
    translated?: Record<string, string>;
    tokensByKey: Record<string, Token[]>;
    failedKeys?: Set<string>;
    failureMessage?: string;
  }): MergeResult;
  chunkContent(content: Record<string, string>, maxBytes?: number): Record<string, string>[];
  retryDelayMs(res: { headers: { get(name: string): string | null } } | null, attempt: number, cap?: number): number;
  fetchWithRetry(args: { fetchImpl: FetchLike; url: string; init?: RequestInit; sleep: (ms: number) => Promise<void>; maxAttempts?: number }): Promise<Response>;
  translateContent(args: {
    content: Record<string, string>;
    targetNames: string[];
    reference: string;
    fetchImpl: FetchLike;
    base: string;
    apiKey: string;
    extraHeaders?: Record<string, string>;
    sleep: (ms: number) => Promise<void>;
  }): Promise<{ status: string; results: Record<string, Record<string, string>>; errors: Record<string, string>; failedKeys: Record<string, Set<string>> }>;
  parseBase(raw: string): string;
  readServiceToken(env: Env): Record<string, string>;
  readEnv(env: Env): {
    locales: string[];
    dryRun: boolean;
    languageNames: Map<string, string>;
    apiKey: string;
    extraHeaders: Record<string, string>;
    base: string;
    reference: string;
    fallbackEnvironment: string | null;
    fallbackMode: string;
    overridesFile: string | null;
  };
  buildSummary(args: {
    project: string;
    environment: string;
    reference: string;
    status: string;
    perLocale: {
      locale: string;
      reused: number;
      added: number;
      pruned: number;
      keptBack: KeptBack[];
      fromFallback?: number;
      overridden?: number;
      rejectedFallback?: KeptBack[];
      note?: string;
    }[];
    rosettaErrors: Record<string, string>;
    dryRun: boolean;
    fallbackEnvironment?: string | null;
    fallbackMode?: string;
    overrides?: Overrides | null;
  }): string;
  main(
    env: Env,
    io: { fetch: FetchLike; sleep: (ms: number) => Promise<void>; log: (m: string) => void },
  ): Promise<{ status: string; keptBackTotal: number; fromFallbackTotal: number; overriddenTotal: number }>;
  testSupport: {
    makeTempDir(prefix?: string): string;
    writeJson(file: string, value: unknown): void;
    readJson(file: string): unknown;
    readText(file: string): string;
    join(...parts: string[]): string;
  };
}

// The script is plain CommonJS (it ships as a bin next to the extractor), so
// it has no type declarations; Vite's interop exposes module.exports as the
// default export.
// @ts-expect-error -- untyped .cjs module, typed locally through SyncModule
const loaded: unknown = await import("../scripts/deriv-rosetta-sync.cjs");
const sync = (((loaded as { default?: unknown }).default ?? loaded) as SyncModule);

const byteLength = (text: string): number => new TextEncoder().encode(text).length;
const noSleep = () => Promise.resolve();
const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

describe("locale mapping", () => {
  it("maps the project's locale codes to Rosetta language names", () => {
    expect(sync.languageNameFor("es")).toBe("Spanish");
    expect(sync.languageNameFor("FR")).toBe("French");
    expect(sync.languageNameFor("pt")).toBe("Portuguese");
    expect(sync.LANGUAGES).toHaveLength(39);
  });

  it("rejects an unknown code and lower-cases the file name", () => {
    expect(() => sync.languageNameFor("xx")).toThrow(/Unknown locale "xx"/);
    expect(sync.localeFileName("ES")).toBe("es.json");
  });

  it("accepts the runtime's zh_cn / zh_tw spellings and keeps them as the file name", () => {
    expect(sync.languageNameFor("zh_cn")).toBe("Simplified Chinese");
    expect(sync.languageNameFor("ZH_TW")).toBe("Traditional Chinese");
    expect(sync.languageNameFor("zh-CN")).toBe("Simplified Chinese");
    expect(sync.languageNameFor("zh-Hant-TW")).toBe("Traditional Chinese");
    expect(sync.localeFileName("ZH_CN")).toBe("zh_cn.json");
    expect(() => sync.languageNameFor("xx")).toThrow(/zh-CN, zh_cn, zh-Hant-TW, zh_tw/);
  });
});

describe("token protection", () => {
  it("hides placeholders, markers and protected terms behind HTML tokens and restores them", () => {
    const source = "Build your {{name}} app with <0>Deriv MCP</0> in {{count}} steps.";
    const { text, tokens } = sync.protect(source, ["Deriv MCP"]);
    expect(text).not.toContain("{{");
    expect(text).not.toContain("<0>");
    expect(text).not.toContain("Deriv MCP");
    expect(text).toContain('<x-ph i="0"></x-ph>');
    expect(text).toContain("<x-c0>");
    expect(tokens.map((t) => t.original)).toEqual(["{{name}}", "{{count}}", "Deriv MCP"]);

    const translated = text.replace("Build your", "Construye tu").replace("app with", "app con").replace("steps.", "pasos.");
    const result = sync.restore(translated, tokens, source);
    expect(result.ok).toBe(true);
    expect(result.text).toBe("Construye tu {{name}} app con <0>Deriv MCP</0> in {{count}} pasos.");
  });

  it("protects every i18next interpolation shape, not only {{name}}", () => {
    const source = "{{count, number}} items, {{- raw}} and $t(common.ok)";
    const { text, tokens } = sync.protect(source);
    expect(text).toBe('<x-ph i="0"></x-ph> items, <x-ph i="1"></x-ph> and <x-ph i="2"></x-ph>');
    expect(tokens.map((t) => t.original)).toEqual(["{{count, number}}", "{{- raw}}", "$t(common.ok)"]);
    expect(sync.restore(text.replace("items", "elementos"), tokens, source)).toMatchObject({ ok: true, text: "{{count, number}} elementos, {{- raw}} and $t(common.ok)" });
  });

  it("accepts the self-closing and spaced forms Rosetta may emit", () => {
    const source = "Hello {{name}}";
    const { tokens } = sync.protect(source);
    expect(sync.restore('Hola <x-ph i="0"/>', tokens, source).ok).toBe(true);
    expect(sync.restore('Hola <x-ph i="0" />', tokens, source).ok).toBe(true);
    expect(sync.restore('Hola <x-ph i="0"> </x-ph>', tokens, source).ok).toBe(true);
  });

  it("decodes HTML entities the translator added, but only when the source had none", () => {
    expect(sync.restore("Pares &amp; opciones &lt;rápido&gt;", [], "Pairs & options <fast>")).toMatchObject({ ok: true, text: "Pares & opciones <rápido>" });
    expect(sync.restore("Les éléments ne sont pas prêts&nbsp;: c&#x27;est &#8216;ok&#8217;", [], "Items aren't ready: it's 'ok'")).toMatchObject({ ok: true, text: "Les éléments ne sont pas prêts\u00a0: c'est \u2018ok\u2019" });
    // An entity the source has is kept; one the translator added is still decoded.
    expect(sync.restore("Frais&nbsp;: bas &amp; rapide", [], "Fees:&nbsp;low & fast")).toMatchObject({ ok: true, text: "Frais&nbsp;: bas & rapide" });
  });

  it.each([
    ["an unsupported named entity", "c&rsquo;est prêt", "it's ready", "&rsquo;"],
    ["a lone surrogate", "Hola &#xD83D;", "Hello", "&#xD83D;"],
    ["a control character", "Hola&#1;", "Hello", "&#1;"],
  ])("holds back a translation with %s the source did not have", (_label, translated, source, entity) => {
    expect(sync.restore(translated, [], source)).toMatchObject({ ok: false, reason: `an HTML entity was left in the translation (${entity})` });
    // A source that already carries an entity is left exactly as returned.
    expect(sync.restore("Tom &amp; Jerry", [], "Tom &amp; Jerry")).toMatchObject({ ok: true, text: "Tom &amp; Jerry" });
  });

  it("fails closed when a token is lost, duplicated or translated", () => {
    const source = "Copy {{value}} to <0>clipboard</0> with Claude Code";
    const { text, tokens } = sync.protect(source, ["Claude Code"]);
    expect(sync.restore(text.replace('<x-ph i="0"></x-ph>', ""), tokens, source)).toMatchObject({ ok: false, reason: /placeholders/ });
    expect(sync.restore(text.replace("</x-c0>", ""), tokens, source)).toMatchObject({ ok: false, reason: /markers|token/ });
    expect(sync.restore(text.replace('<x-pt i="1"></x-pt>', "Código Claude"), tokens, source)).toMatchObject({ ok: false, reason: /protected term/ });
  });

  it.each([
    ["a marker", "<0>symbol</0> is renamed to <1>underlying_symbol</1>.", []],
    ["a placeholder", "{{count}} items selected", []],
    ["a protected term", "Deriv MCP connects your assistant", ["Deriv MCP"]],
  ])("starts the protected text with a custom element when the source starts with %s", (_label, source, terms) => {
    // Rosetta rejects a string that starts with a non-HTML tag without a hyphen
    // as malformed XML (HTTP 422), which fails the whole batch. Custom elements
    // (a hyphen in the name) are treated as HTML, so the string goes through.
    const { text, tokens } = sync.protect(source, terms);
    const firstTag = /^<([A-Za-z_][\w.:-]*)/.exec(text);
    expect(firstTag?.[1]).toContain("-");
    expect(sync.restore(text, tokens, source)).toMatchObject({ ok: true, text: source });
  });

  it.each([
    ["a placeholder", "Open {{name}}", [], 'Abrir <ph i="0"></ph>'],
    ["a protected term", "Open Deriv MCP", ["Deriv MCP"], 'Abrir <pt i="0"></pt>'],
    ["a marker", "Open <0>docs</0>", [], "Abrir <c0>docs</c0>"],
  ])("fails closed on %s left without its x- prefix", (_label, source, terms, translated) => {
    const { tokens } = sync.protect(source, terms);
    expect(sync.restore(translated, tokens, source)).toMatchObject({ ok: false, reason: /protected token/ });
  });

  it("does not protect a term inside a longer word", () => {
    const { text, tokens } = sync.protect("Bots and Bot", ["Bot"]);
    expect(text).toBe('Bots and <x-pt i="0"></x-pt>');
    expect(tokens).toHaveLength(1);
  });

  it("handles a protected term that contains another protected term", () => {
    const source = "Deriv MCP and Deriv";
    const { text, tokens } = sync.protect(source, ["Deriv", "Deriv MCP"]);
    expect(tokens.map((t) => t.original)).toEqual(["Deriv MCP", "Deriv"]);
    expect(sync.countTerms(source, ["Deriv", "Deriv MCP"])).toEqual({ "Deriv MCP": 1, Deriv: 1 });
    const result = sync.restore(text.replace("and", "y"), tokens, source);
    expect(result).toMatchObject({ ok: true, text: "Deriv MCP y Deriv" });
  });
});

describe("delta and merge", () => {
  const en = { a: "Alpha", b: "Beta {{n}}", c: "Gamma" };

  it("reuses what the CDN has, translates only missing keys, and prunes removed ones", () => {
    const plan = sync.planLocale(en, { a: "Alfa", z: "Zeta (removed)" });
    expect(plan).toEqual({ reuse: { a: "Alfa" }, fromFallback: {}, overridden: {}, missing: ["b", "c"], pruned: ["z"], rejectedFallback: [] });
  });

  it("writes passing translations, leaves failures out, and reports them", () => {
    const plan = sync.planLocale(en, { a: "Alfa" });
    const tokensByKey = { b: sync.protect(en.b).tokens, c: [] };
    const merged = sync.mergeLocale({ en, plan, translated: { b: "Beta rota", c: "Gama" }, tokensByKey });
    expect(merged.catalogue).toEqual({ a: "Alfa", c: "Gama" });
    expect(merged.added).toBe(1);
    expect(merged.reused).toBe(1);
    expect(merged.keptBack).toEqual([{ key: "b", english: "Beta {{n}}", reason: expect.stringMatching(/placeholders/) }]);
  });

  it("keeps back a key Rosetta did not return, and a key whose chunk failed", () => {
    const plan = sync.planLocale(en, {});
    const merged = sync.mergeLocale({
      en,
      plan,
      translated: { a: "Alfa", c: "Gama" },
      tokensByKey: { a: [], b: [], c: [] },
      failedKeys: new Set(["c"]),
      failureMessage: "upstream 500",
    });
    expect(Object.keys(merged.catalogue)).toEqual(["a"]);
    expect(merged.keptBack).toEqual([
      { key: "b", english: "Beta {{n}}", reason: "not returned by Rosetta" },
      { key: "c", english: "Gamma", reason: "language failed in Rosetta: upstream 500" },
    ]);
  });
});

describe("checking a value that is already translated", () => {
  const terms = ["Deriv", "Deriv MCP"];

  it("accepts a value with the source's placeholders, markers and protected terms", () => {
    expect(sync.checkTranslation("Abrir {{ name }} en <0>Deriv MCP</0>", "Open {{name}} in <0>Deriv MCP</0>", terms)).toEqual({ ok: true, reason: null });
    expect(sync.checkTranslation("Hola", "Hello", terms).ok).toBe(true);
  });

  it("rejects a lost placeholder or marker, a translated or repeated term, and an empty value", () => {
    expect(sync.checkTranslation("Abrir en Deriv", "Open {{name}} in Deriv", terms).reason).toMatch(/placeholders/);
    expect(sync.checkTranslation("Abrir {{name}}", "Open <0>{{name}}</0>", terms).reason).toMatch(/markers/);
    expect(sync.checkTranslation("Abrir Dériv", "Open Deriv", terms).reason).toMatch(/"Deriv"/);
    expect(sync.checkTranslation("Deriv y Deriv", "Deriv", terms).reason).toMatch(/"Deriv"/);
    expect(sync.checkTranslation("  ", "Hello", terms).ok).toBe(false);
    expect(sync.checkTranslation(42, "Hello", terms).ok).toBe(false);
  });

  it("ignores a protected term the source does not contain", () => {
    expect(sync.checkTranslation("Deriv te saluda", "Hello", terms).ok).toBe(true);
  });
});

describe("fallback environment and overrides in the plan", () => {
  const en = { a: "Alpha", b: "Beta {{n}}", c: "Gamma", d: "Delta" };

  it("missing mode: keeps this environment's value and fills only its gaps from the fallback", () => {
    const plan = sync.planLocale(en, { a: "Alfa-prod", z: "Pruned" }, { fallback: { a: "Alfa-stg", b: "Beta-stg {{n}}", y: "Staging only" } });
    expect(plan.reuse).toEqual({ a: "Alfa-prod" });
    expect(plan.fromFallback).toEqual({ b: "Beta-stg {{n}}" });
    expect(plan.missing).toEqual(["c", "d"]);
    expect(plan.pruned).toEqual(["z"]);
  });

  it("prefer mode: the fallback replaces a differing value, and an equal one counts as reused", () => {
    const plan = sync.planLocale(en, { a: "Alfa-prod", c: "Gama" }, { fallback: { a: "Alfa-stg", c: "Gama", d: "Delta-stg" }, fallbackMode: "prefer" });
    expect(plan.fromFallback).toEqual({ a: "Alfa-stg", d: "Delta-stg" });
    expect(plan.reuse).toEqual({ c: "Gama" });
    expect(plan.missing).toEqual(["b"]);
  });

  it("does not use a fallback value that fails the token check, and reports it", () => {
    const options = { fallback: { b: "Beta sin n", c: "Gama Deriv" }, protectedTerms: ["Deriv"] };
    const missing = sync.planLocale(en, {}, options);
    expect(missing.fromFallback).toEqual({ c: "Gama Deriv" });
    expect(missing.missing).toEqual(["a", "b", "d"]);
    expect(missing.rejectedFallback).toEqual([{ key: "b", english: "Beta {{n}}", reason: expect.stringMatching(/placeholders/) }]);
    // In prefer mode a rejected fallback falls through to this environment's own value.
    const prefer = sync.planLocale(en, { b: "Beta-prod {{n}}" }, { ...options, fallbackMode: "prefer" });
    expect(prefer.reuse).toEqual({ b: "Beta-prod {{n}}" });
    expect(prefer.rejectedFallback).toHaveLength(1);
  });

  it("applies an override over both this environment's value and the fallback", () => {
    const plan = sync.planLocale(en, { a: "Alfa-prod" }, { fallback: { a: "Alfa-stg", b: "Beta-stg {{n}}" }, fallbackMode: "prefer", overrides: { a: "Alfa-fixed", c: "Gama-fixed" } });
    expect(plan.overridden).toEqual({ a: "Alfa-fixed", c: "Gama-fixed" });
    expect(plan.fromFallback).toEqual({ b: "Beta-stg {{n}}" });
    expect(plan.reuse).toEqual({});
    expect(plan.missing).toEqual(["d"]);
  });

  it("counts an override this environment already has as reused, and still lets it win over the fallback", () => {
    const plan = sync.planLocale(en, { a: "Alfa", b: "Beta-prod {{n}}" }, { fallback: { a: "Alfa-stg" }, fallbackMode: "prefer", overrides: { a: "Alfa", b: "Beta-fixed {{n}}" } });
    expect(plan.reuse).toEqual({ a: "Alfa" });
    expect(plan.overridden).toEqual({ b: "Beta-fixed {{n}}" });
    expect(plan.fromFallback).toEqual({});
  });

  it("merges reused, fallback, overridden and new values into one catalogue and counts each", () => {
    const plan = sync.planLocale(en, { a: "Alfa" }, { fallback: { b: "Beta-stg {{n}}" }, overrides: { c: "Gama-fixed" } });
    const merged = sync.mergeLocale({ en, plan, translated: { d: "Delta-new" }, tokensByKey: { d: [] } });
    expect(merged.catalogue).toEqual({ a: "Alfa", b: "Beta-stg {{n}}", c: "Gama-fixed", d: "Delta-new" });
    expect(merged).toMatchObject({ reused: 1, fromFallback: 1, overridden: 1, added: 1, keptBack: [] });
  });
});

describe("resolving the overrides file", () => {
  const en = { k1: "1 Change", k2: "Edited {{time}} ago", k3: "Open Deriv" };
  const locales = ["es", "fr", "zh_cn"];

  it("maps English text to its key per targeted locale, whatever spelling of the locale code it uses", () => {
    const out = sync.resolveOverrides(
      { FR: { "1 Change": "1 modification" }, es: { "Edited {{time}} ago": "Editado hace {{time}}" }, "zh-CN": { "Open Deriv": "打开 Deriv" } },
      { en, locales, protectedTerms: ["Deriv"] },
    );
    expect(out.byLocale).toEqual({ es: { k2: "Editado hace {{time}}" }, fr: { k1: "1 modification" }, zh_cn: { k3: "打开 Deriv" } });
    expect(out.stale).toEqual([]);
    expect(out.ignoredLocales).toEqual([]);
  });

  it("reports an entry whose English is no longer extracted, and a known locale this run does not target", () => {
    const out = sync.resolveOverrides({ fr: { "Old wording": "Ancien" }, pt: { "1 Change": "1 alteração" } }, { en, locales });
    expect(out.stale).toEqual([{ locale: "fr", english: "Old wording" }]);
    expect(out.ignoredLocales).toEqual(["pt"]);
    expect(out.byLocale.fr).toEqual({});
  });

  it("fails on a malformed file, an unknown locale, and every value that fails the token check", () => {
    expect(() => sync.resolveOverrides([], { en, locales })).toThrow(/must be a JSON object/);
    expect(() => sync.resolveOverrides({ sp: {} }, { en, locales })).toThrow(/Unknown locale "sp"/);
    const run = () =>
      sync.resolveOverrides(
        { es: { "Edited {{time}} ago": "Editado hace poco", "Open Deriv": "Abrir Dériv" }, fr: ["not", "a map"] },
        { en, locales, protectedTerms: ["Deriv"], file: "translations.overrides.json" },
      );
    expect(run).toThrow(/translations\.overrides\.json has 3 invalid entries/);
    expect(run).toThrow(/es "Edited \{\{time\}\} ago": placeholders do not match/);
    expect(run).toThrow(/es "Open Deriv": protected term "Deriv"/);
    expect(run).toThrow(/"fr" must map English text/);
  });

  it("checks the entries of a locale this run does not target", () => {
    const run = () => sync.resolveOverrides({ pt: { "Edited {{time}} ago": "Editado há pouco" } }, { en, locales });
    expect(run).toThrow(/pt "Edited \{\{time\}\} ago": placeholders do not match/);
  });

  it("fails when two codes in the file name the same language", () => {
    const run = () => sync.resolveOverrides({ "zh-CN": { "1 Change": "1 个更改" }, zh_cn: { "1 Change": "1 处更改" } }, { en, locales });
    expect(run).toThrow(/"zh-CN" and "zh_cn" both name Simplified Chinese/);
  });
});

describe("chunking and retry delays", () => {
  it("splits content so every chunk serialises under the limit", () => {
    const content = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, "x".repeat(100)]));
    const chunks = sync.chunkContent(content, 1200);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flatMap((c) => Object.keys(c))).toHaveLength(50);
    for (const chunk of chunks) expect(byteLength(JSON.stringify(chunk))).toBeLessThanOrEqual(1200);
  });

  it("honours Retry-After and otherwise backs off exponentially up to the cap", () => {
    expect(sync.retryDelayMs({ headers: { get: () => "7" } }, 0)).toBe(7000);
    expect(sync.retryDelayMs(null, 0)).toBe(3000);
    expect(sync.retryDelayMs(null, 1)).toBe(6000);
    expect(sync.retryDelayMs(null, 10)).toBe(30000);
  });

  it("retries a thrown network error with backoff and gives up with a clear message", async () => {
    const sleep = vi.fn(() => Promise.resolve());
    let calls = 0;
    const flaky: FetchLike = async () => {
      calls += 1;
      if (calls < 3) throw new Error("ECONNRESET");
      return jsonResponse(200, { ok: true });
    };
    const res = await sync.fetchWithRetry({ fetchImpl: flaky, url: "https://x.test/a", sleep });
    expect(res.status).toBe(200);
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);

    const dead: FetchLike = async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    };
    await expect(sync.fetchWithRetry({ fetchImpl: dead, url: "https://x.test/b", sleep, maxAttempts: 2 })).rejects.toThrow(/Network error calling https:\/\/x\.test\/b after 3 attempts: getaddrinfo ENOTFOUND/);
  });

  it("passes an abort signal so a hung socket cannot stall the job", async () => {
    let seen: RequestInit | undefined;
    const spy: FetchLike = async (_url, init) => {
      seen = init;
      return jsonResponse(200, {});
    };
    await sync.fetchWithRetry({ fetchImpl: spy, url: "https://x.test", sleep: noSleep });
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("submit → poll", () => {
  it("submits once per chunk, polls through queued and running, and merges completed results", async () => {
    const calls: string[] = [];
    let polls = 0;
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push(`${init?.method || "GET"} ${url}`);
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { target_languages: string[]; content: Record<string, string> };
        expect(body.target_languages).toEqual(["Spanish", "French"]);
        expect(body.content).toEqual({ k1: "Hello" });
        return jsonResponse(202, { job_id: "job-1", status: "queued" });
      }
      polls += 1;
      if (polls === 1) return jsonResponse(200, { job_id: "job-1", status: "queued" });
      if (polls === 2) return jsonResponse(200, { job_id: "job-1", status: "running" });
      return jsonResponse(200, { job_id: "job-1", status: "completed", results: { Spanish: { k1: "Hola" }, French: { k1: "Bonjour" } }, errors: null });
    };
    const out = await sync.translateContent({ content: { k1: "Hello" }, targetNames: ["Spanish", "French"], reference: "proj/staging/abc", fetchImpl, base: "https://rosetta.test", apiKey: "secret", sleep: noSleep });
    expect(out.status).toBe("completed");
    expect(out.results).toEqual({ Spanish: { k1: "Hola" }, French: { k1: "Bonjour" } });
    expect(out.failedKeys).toEqual({});
    expect(calls[0]).toBe("POST https://rosetta.test/v1/translate");
    expect(calls.filter((c) => c.startsWith("GET"))).toHaveLength(3);
  });

  it("surfaces a partial job with its per-language errors and the keys that failed", async () => {
    const fetchImpl: FetchLike = async (_url, init) =>
      init?.method === "POST"
        ? jsonResponse(202, { job_id: "job-2", status: "queued" })
        : jsonResponse(200, { job_id: "job-2", status: "partial", results: { Spanish: { k1: "Hola" } }, errors: { French: "No valid JSON translation produced" } });
    const out = await sync.translateContent({ content: { k1: "Hello" }, targetNames: ["Spanish", "French"], reference: "r", fetchImpl, base: "https://rosetta.test", apiKey: "secret", sleep: noSleep });
    expect(out.status).toBe("partial");
    expect(out.results.French).toBeUndefined();
    expect(out.errors).toEqual({ French: "No valid JSON translation produced" });
    expect([...out.failedKeys.French]).toEqual(["k1"]);
  });

  it("keeps a language's good chunks when only a later chunk fails for it", async () => {
    let posts = 0;
    const fetchImpl: FetchLike = async (url, init) => {
      if (init?.method === "POST") {
        posts += 1;
        return jsonResponse(202, { job_id: `job-${posts}`, status: "queued" });
      }
      const jobId = url.split("/").pop();
      return jobId === "job-1"
        ? jsonResponse(200, { status: "completed", results: { French: { a: "A-fr", b: "B-fr" } }, errors: null })
        : jsonResponse(200, { status: "partial", results: {}, errors: { French: "boom" } });
    };
    // Values of 300 KB each push the content past the 400 KB chunk limit, so
    // translateContent submits two jobs: {a, b} → job-1 (ok) and {c} → job-2 (fails).
    const big = (ch: string) => ch.repeat(150 * 1024);
    const content = { a: big("a"), b: big("b"), c: big("c") };
    const out = await sync.translateContent({ content, targetNames: ["French"], reference: "r", fetchImpl, base: "https://rosetta.test", apiKey: "s", sleep: noSleep });
    expect(posts).toBe(2);
    expect(out.status).toBe("partial");
    expect(out.results.French).toEqual({ a: "A-fr", b: "B-fr" }); // chunk 1 kept
    expect([...out.failedKeys.French]).toEqual(["c"]); // only chunk 2's key retried next run
    expect(out.errors).toEqual({ French: "boom" });
  });

  it("reports a Cloudflare block in one line with the Ray ID, not the HTML page", async () => {
    const page = "<!DOCTYPE html><title>Attention Required! | Cloudflare</title><p>Sorry, you have been blocked</p>" + "x".repeat(5000);
    const blocked: FetchLike = async () =>
      new Response(page, { status: 403, headers: { "Content-Type": "text/html; charset=UTF-8", "cf-ray": "0f0f0f0f0f0f0f0f-FRA" } });
    const run = sync.translateContent({ content: { k: "x" }, targetNames: ["Spanish"], reference: "r", fetchImpl: blocked, base: "https://rosetta.test", apiKey: "s", sleep: noSleep });
    const error = await run.then(() => null, (e: Error) => e);
    expect(error?.message).toBe(
      "Rosetta submit was blocked by Cloudflare (HTTP 403, Ray ID 0f0f0f0f0f0f0f0f): if the API requires a Cloudflare Access service token, set ROSETTA_CF_ACCESS_CLIENT_ID / _SECRET; otherwise share the Ray ID with the Rosetta team (see the README)."
    );
  });

  it("sends the Cloudflare Access service token on submit and poll, and never follows a redirect", async () => {
    const seen: { url: string; headers: Record<string, string>; redirect?: string }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      seen.push({ url, headers: { ...(init?.headers as Record<string, string>) }, redirect: init?.redirect });
      if (init?.method === "POST") return jsonResponse(202, { job_id: "job-cf", status: "queued" });
      return jsonResponse(200, { status: "completed", results: { Spanish: { k: "x-es" } }, errors: null });
    };
    const extraHeaders = { "CF-Access-Client-Id": "id.access", "CF-Access-Client-Secret": "shh" };
    await sync.translateContent({ content: { k: "x" }, targetNames: ["Spanish"], reference: "r", fetchImpl, base: "https://rosetta.test", apiKey: "s", extraHeaders, sleep: noSleep });
    expect(seen).toHaveLength(2);
    for (const call of seen) {
      expect(call.headers).toMatchObject({ ...extraHeaders, Authorization: "Bearer s" });
      expect(call.redirect).toBe("manual");
    }
  });

  it("works without a service token, as before", async () => {
    const seen: Record<string, string>[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      seen.push({ ...(init?.headers as Record<string, string>) });
      if (init?.method === "POST") return jsonResponse(202, { job_id: "job-plain", status: "queued" });
      return jsonResponse(200, { status: "completed", results: { Spanish: { k: "x-es" } }, errors: null });
    };
    await sync.translateContent({ content: { k: "x" }, targetNames: ["Spanish"], reference: "r", fetchImpl, base: "https://rosetta.test", apiKey: "s", sleep: noSleep });
    for (const headers of seen) expect(Object.keys(headers).filter((h) => h.startsWith("CF-Access"))).toEqual([]);
  });

  it("tells a rejected service token apart from a missing one, and names any other redirect without its query", async () => {
    const run = (fetchImpl: FetchLike, extraHeaders?: Record<string, string>) =>
      sync
        .translateContent({ content: { k: "x" }, targetNames: ["Spanish"], reference: "r", fetchImpl, base: "https://rosetta.test", apiKey: "s", extraHeaders, sleep: noSleep })
        .then(() => null, (e: Error) => e);
    const token = { "CF-Access-Client-Id": "id.access", "CF-Access-Client-Secret": "shh" };
    const redirectTo = (location: string, status = 302): FetchLike => async () => new Response(null, { status, headers: { Location: location } });
    // Same-host, relative and team-domain Access login redirects all count.
    for (const location of ["https://rosetta.test/cdn-cgi/access/login?redirect_url=%2Fv1", "/cdn-cgi/access/login", "https://example.cloudflareaccess.com/cdn-cgi/access/login/rosetta.test?kid=abc"]) {
      expect((await run(redirectTo(location)))?.message).toBe(
        "Rosetta submit was redirected to Cloudflare Access login (HTTP 302): set ROSETTA_CF_ACCESS_CLIENT_ID and ROSETTA_CF_ACCESS_CLIENT_SECRET to a valid service token (see the README)."
      );
      expect((await run(redirectTo(location), token))?.message).toMatch(/redirected to Cloudflare Access login \(HTTP 302\): the service token was not accepted/);
    }
    // Header-name casing does not matter for telling a rejected token from a missing one.
    const lower = { "cf-access-client-id": "id.access", "cf-access-client-secret": "shh" };
    expect((await run(redirectTo("/cdn-cgi/access/login"), lower))?.message).toMatch(/the service token was not accepted/);
    // Only the redirect's host and path decide: Access named in a query string is an ordinary redirect.
    expect((await run(redirectTo("https://new.rosetta.test/v1/translate?next=https://x.cloudflareaccess.com/login", 307)))?.message).toBe(
      "Rosetta submit was redirected (HTTP 307) to https://new.rosetta.test/v1/translate; Rosetta requests do not follow redirects, so check ROSETTA_API_BASE."
    );
    // A relative Location is resolved against the request URL.
    expect((await run(redirectTo("/v2/translate", 308)))?.message).toBe(
      "Rosetta submit was redirected (HTTP 308) to https://rosetta.test/v2/translate; Rosetta requests do not follow redirects, so check ROSETTA_API_BASE."
    );
    const blocked: FetchLike = async () =>
      new Response("<html>Sorry, you have been blocked</html>", { status: 403, headers: { "Content-Type": "text/html", "cf-ray": "abcdef0123456789-FRA" } });
    expect((await run(blocked, token))?.message).toMatch(/blocked by Cloudflare \(HTTP 403, Ray ID abcdef0123456789\) although a service token was sent: the token may be wrong, or another Cloudflare rule blocked the request/);
    const moved: FetchLike = async () => new Response(null, { status: 308, headers: { Location: "https://new.rosetta.test/v1/translate?sig=secret-sig" } });
    const error = await run(moved);
    expect(error?.message).toBe(
      "Rosetta submit was redirected (HTTP 308) to https://new.rosetta.test/v1/translate; Rosetta requests do not follow redirects, so check ROSETTA_API_BASE."
    );
  });

  it("does not blame Cloudflare Access or the service token for an outage page, a wrong host, or a response without headers", async () => {
    const run = (fetchImpl: FetchLike) =>
      sync
        .translateContent({ content: { k: "x" }, targetNames: ["Spanish"], reference: "r", fetchImpl, base: "https://rosetta.test", apiKey: "s", sleep: noSleep })
        .then(() => null, (e: Error) => e);
    const page = "<!DOCTYPE html><title>rosetta.test | 522: Connection timed out</title>" + "z".repeat(5000);
    const outage = await run(async () => new Response(page, { status: 522, headers: { "Content-Type": "text/html", "cf-ray": "8f00aa11bb22cc33-FRA" } }));
    expect(outage?.message).toMatch(/^Rosetta submit failed with HTTP 522 \(Ray ID 8f00aa11bb22cc33\): \{"raw":"<!DOCTYPE html>.*…"\}$/);
    expect(outage?.message).not.toMatch(/service token|Cloudflare Access/);
    const wrongHost = await run(async () => new Response("<html>Not found</html>", { status: 404, headers: { "Content-Type": "text/html", "cf-ray": "1234567890abcdef-AMS" } }));
    expect(wrongHost?.message).toMatch(/failed with HTTP 404 \(Ray ID 1234567890abcdef\)/);
    const bare = await run(async () => ({ status: 400, text: async () => "bad request" }) as unknown as Response);
    expect(bare?.message).toBe('Rosetta submit failed with HTTP 400: {"raw":"bad request"}');
  });

  it("keeps Rosetta's JSON error as it is, and cuts any other non-JSON body short", async () => {
    const json: FetchLike = async () => jsonResponse(401, { error: { code: "UNAUTHENTICATED", message: "Invalid API key." } });
    await expect(sync.translateContent({ content: { k: "x" }, targetNames: ["Spanish"], reference: "r", fetchImpl: json, base: "https://rosetta.test", apiKey: "s", sleep: noSleep })).rejects.toThrow(
      'Rosetta submit failed with HTTP 401: {"error":{"code":"UNAUTHENTICATED","message":"Invalid API key."}}'
    );
    const text: FetchLike = async () => new Response("y".repeat(1000), { status: 400, headers: { "Content-Type": "text/plain" } });
    const error = await sync
      .translateContent({ content: { k: "x" }, targetNames: ["Spanish"], reference: "r", fetchImpl: text, base: "https://rosetta.test", apiKey: "s", sleep: noSleep })
      .then(() => null, (e: Error) => e);
    expect(error?.message.length).toBeLessThan(400);
    expect(error?.message).toMatch(/failed with HTTP 400: \{"raw":"y+…"\}/);
  });

  it("retries a 429 on submit and fails loudly on a failed job", async () => {
    const sleep = vi.fn(() => Promise.resolve());
    let posts = 0;
    const fetchImpl: FetchLike = async (_url, init) => {
      if (init?.method === "POST") {
        posts += 1;
        return posts === 1 ? jsonResponse(429, {}, { "Retry-After": "1" }) : jsonResponse(202, { job_id: "job-3", status: "queued" });
      }
      return jsonResponse(200, { job_id: "job-3", status: "failed", error: "upstream down" });
    };
    await expect(sync.translateContent({ content: { k: "x" }, targetNames: ["Spanish"], reference: "r", fetchImpl, base: "https://rosetta.test", apiKey: "s", sleep })).rejects.toThrow(/job job-3 failed: "upstream down"/);
    expect(posts).toBe(2);
    expect(sleep).toHaveBeenCalledWith(1000);
  });
});

describe("configuration and summary", () => {
  const baseEnv: Env = { PROJECT_NAME: "deriv-blox", ENVIRONMENT: "staging", TARGET_LOCALES: " es, fr ,pt ", ROSETTA_API_TOKEN: "k", ROSETTA_API_BASE: "https://rosetta.test/", GITHUB_SHA: "abc123" };

  it("reads the action's environment and derives the defaults", () => {
    const cfg = sync.readEnv(baseEnv);
    expect(cfg.locales).toEqual(["es", "fr", "pt"]);
    expect(cfg.dryRun).toBe(false);
    expect(cfg.base).toBe("https://rosetta.test");
    expect(cfg.reference).toBe("deriv-blox/staging/abc123");
  });

  it("requires the key and the base URL, and rejects an unknown environment", () => {
    expect(() => sync.readEnv({ ...baseEnv, ROSETTA_API_TOKEN: undefined })).toThrow(/ROSETTA_API_TOKEN is required/);
    expect(() => sync.readEnv({ ...baseEnv, ROSETTA_API_BASE: undefined })).toThrow(/ROSETTA_API_BASE is required/);
    expect(() => sync.readEnv({ ...baseEnv, ENVIRONMENT: "qa" })).toThrow(/ENVIRONMENT must be/);
  });

  it("does not read the retired MAKIMA_* names", () => {
    // The action passes "" for an input the caller left out.
    const retired = { ...baseEnv, ROSETTA_API_TOKEN: "", ROSETTA_API_BASE: "", MAKIMA_API_KEY: "old", MAKIMA_API_BASE: "https://old.test" };
    expect(() => sync.readEnv(retired)).toThrow(/ROSETTA_API_TOKEN is required/);
    expect(() => sync.readEnv({ ...retired, ROSETTA_API_TOKEN: "k" })).toThrow(/ROSETTA_API_BASE is required/);
  });

  it("accepts only an https host as the base, and never echoes the value", () => {
    const bad = (base: string, message: RegExp) => {
      let error: unknown;
      try {
        sync.readEnv({ ...baseEnv, ROSETTA_API_BASE: base });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(message);
      expect((error as Error).message).not.toContain(base.trim());
    };
    bad("https://gw.test/api/makima", /must be the Rosetta API host only/);
    bad("http://rosetta.test", /must be an https URL: the Rosetta API host/);
    bad("rosetta.test:443", /must be an https URL: the Rosetta API host/); // parses with protocol "rosetta.test:"
    bad("sk-not-a-url-token", /must be an https URL: the Rosetta API host/);
    bad("https://rosetta.test/v1", /must be the Rosetta API host only/);
    bad("https://rosetta.test/?x=1", /must be the Rosetta API host only/);
    bad("https://user:pw@rosetta.test", /must be the Rosetta API host only/);
    // The origin is used, so trailing slashes never double up in the request URL.
    expect(sync.readEnv({ ...baseEnv, ROSETTA_API_BASE: " https://rosetta.test// " }).base).toBe("https://rosetta.test");
  });

  it("reads the optional Cloudflare Access service token, both settings or neither, trimmed, and never echoed", () => {
    expect(sync.readEnv(baseEnv).extraHeaders).toEqual({});
    expect(sync.readEnv({ ...baseEnv, ROSETTA_CF_ACCESS_CLIENT_ID: "", ROSETTA_CF_ACCESS_CLIENT_SECRET: "" }).extraHeaders).toEqual({});
    expect(sync.readEnv({ ...baseEnv, ROSETTA_CF_ACCESS_CLIENT_ID: " id.access\n", ROSETTA_CF_ACCESS_CLIENT_SECRET: " shh\n" }).extraHeaders).toEqual({
      "CF-Access-Client-Id": "id.access",
      "CF-Access-Client-Secret": "shh",
    });
    for (const half of [{ ROSETTA_CF_ACCESS_CLIENT_ID: "id-only-value" }, { ROSETTA_CF_ACCESS_CLIENT_SECRET: "secret-only-value" }]) {
      let error: unknown;
      try {
        sync.readEnv({ ...baseEnv, ...half });
      } catch (e) {
        error = e;
      }
      expect((error as Error).message).toMatch(/must be set together/);
      expect((error as Error).message).not.toMatch(/only-value/);
    }
  });

  it("exports parseBase and readServiceToken for callers that load the script directly", () => {
    expect(sync.parseBase(" https://rosetta.test// ")).toBe("https://rosetta.test");
    expect(() => sync.parseBase("http://rosetta.test")).toThrow(/must be an https URL: the Rosetta API host/);
    expect(sync.readServiceToken({ ROSETTA_CF_ACCESS_CLIENT_ID: "id", ROSETTA_CF_ACCESS_CLIENT_SECRET: "sec" })).toEqual({ "CF-Access-Client-Id": "id", "CF-Access-Client-Secret": "sec" });
    expect(sync.readServiceToken({})).toEqual({});
  });

  it("rejects a credential with a space or control character inside, without echoing it", () => {
    const cases: Env[] = [
      { ROSETTA_API_TOKEN: "tok\nleaked-api-part" },
      { ROSETTA_CF_ACCESS_CLIENT_ID: "id.access", ROSETTA_CF_ACCESS_CLIENT_SECRET: "sec\u0000leaked-cf-part" },
      { ROSETTA_CF_ACCESS_CLIENT_ID: "id with leaked-id-part", ROSETTA_CF_ACCESS_CLIENT_SECRET: "shh" },
    ];
    for (const overrides of cases) {
      let error: unknown;
      try {
        sync.readEnv({ ...baseEnv, ...overrides });
      } catch (e) {
        error = e;
      }
      expect((error as Error).message).toMatch(/contains a space, a line break or another character/);
      expect((error as Error).message).not.toMatch(/leaked/);
    }
  });

  it("resolves each locale code to its language name once, and rejects an unknown code before anything runs", () => {
    expect(() => sync.readEnv({ ...baseEnv, TARGET_LOCALES: "es,ptbr" })).toThrow(/Unknown locale "ptbr"/);
    expect([...sync.readEnv(baseEnv).languageNames]).toEqual([["es", "Spanish"], ["fr", "French"], ["pt", "Portuguese"]]);
  });

  it("trims the token, so a secret pasted with a trailing newline still works", () => {
    expect(sync.readEnv({ ...baseEnv, ROSETTA_API_TOKEN: " k\n" }).apiKey).toBe("k");
  });

  it("reads the fallback and overrides settings and rejects inconsistent ones", () => {
    expect(sync.readEnv(baseEnv)).toMatchObject({ fallbackEnvironment: null, fallbackMode: "missing", overridesFile: null });
    // The action passes an empty string for an input the caller left out.
    expect(sync.readEnv({ ...baseEnv, FALLBACK_ENVIRONMENT: "", FALLBACK_MODE: "", OVERRIDES_FILE: "" })).toMatchObject({ fallbackEnvironment: null, fallbackMode: "missing" });
    const prod = { ...baseEnv, ENVIRONMENT: "production", FALLBACK_ENVIRONMENT: " staging ", FALLBACK_MODE: "prefer", OVERRIDES_FILE: "o.json" };
    expect(sync.readEnv(prod)).toMatchObject({ fallbackEnvironment: "staging", fallbackMode: "prefer", overridesFile: expect.stringMatching(/o\.json$/) });
    expect(() => sync.readEnv({ ...baseEnv, FALLBACK_ENVIRONMENT: "staging" })).toThrow(/must differ from ENVIRONMENT/);
    expect(() => sync.readEnv({ ...baseEnv, FALLBACK_ENVIRONMENT: "qa" })).toThrow(/FALLBACK_ENVIRONMENT must be/);
    expect(() => sync.readEnv({ ...prod, FALLBACK_MODE: "always" })).toThrow(/FALLBACK_MODE must be/);
    expect(() => sync.readEnv({ ...baseEnv, FALLBACK_MODE: "prefer" })).toThrow(/needs FALLBACK_ENVIRONMENT/);
  });

  it("writes a summary table and lists kept-back strings", () => {
    const text = sync.buildSummary({
      project: "deriv-blox",
      environment: "staging",
      reference: "deriv-blox/staging/abc",
      status: "partial",
      perLocale: [
        { locale: "es", reused: 10, added: 2, pruned: 1, keptBack: [{ key: "k9", english: "Hi {{x}}", reason: "placeholders do not match the source" }] },
        { locale: "fr", reused: 10, added: 0, pruned: 1, keptBack: [], note: "Rosetta failed this language" },
      ],
      rosettaErrors: { French: "boom" },
      dryRun: true,
    });
    expect(text).toContain("(dry run)");
    expect(text).toContain("| es | 10 | 2 | 1 | 1 |");
    expect(text).toContain("`k9` — placeholders do not match the source");
    expect(text).toContain("**French**: boom");
    expect(text).not.toContain("From ");
    expect(text).not.toContain("Overridden");
  });

  it("adds fallback and override columns, rejected fallback values and unapplied overrides when they are used", () => {
    const text = sync.buildSummary({
      project: "deriv-api-v2",
      environment: "production",
      reference: "ref",
      status: "completed",
      perLocale: [
        { locale: "fr", reused: 7, added: 1, pruned: 0, keptBack: [], fromFallback: 3, overridden: 2, rejectedFallback: [{ key: "k5", english: "Hi {{x}}", reason: "placeholders do not match the source" }] },
      ],
      rosettaErrors: {},
      dryRun: false,
      fallbackEnvironment: "staging",
      fallbackMode: "missing",
      overrides: { byLocale: {}, stale: [{ locale: "fr", english: "Old wording" }], ignoredLocales: ["de"] },
    });
    expect(text).toContain("| Locale | Reused | New | Pruned | Kept back | From staging | Overridden | Note |");
    expect(text).toContain("| fr | 7 | 1 | 0 | 0 | 3 | 2 |  |");
    expect(text).toContain("keys production lacks are taken from **staging**");
    expect(text).toContain("### staging values not used");
    expect(text).toContain("`k5` — placeholders do not match the source");
    expect(text).toContain('**fr** "Old wording" — this English text is no longer extracted');
    expect(text).toContain("**de** — not in TARGET_LOCALES");
  });
});

describe("main(): end to end against a temp directory and a mocked gateway", () => {
  const { makeTempDir, writeJson, readJson, readText, join } = sync.testSupport;
  const dirOf = () => makeTempDir("rosetta-overrides-");

  function setup(en: Record<string, string>, terms?: string[]) {
    const dir = makeTempDir();
    writeJson(join(dir, "translations", "en.json"), en);
    const env: Env = {
      PROJECT_NAME: "proj",
      ENVIRONMENT: "staging",
      TARGET_LOCALES: "es,fr",
      ROSETTA_API_TOKEN: "secret",
      ROSETTA_API_BASE: "https://rosetta.test",
      CDN_BASE_URL: "https://cdn.test",
      TRANSLATIONS_DIR: join(dir, "translations"),
      GITHUB_OUTPUT: join(dir, "output.txt"),
      GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
      REFERENCE: "proj/staging/test",
    };
    if (terms) {
      writeJson(join(dir, "terms.json"), terms);
      env.PROTECTED_TERMS_FILE = join(dir, "terms.json");
    }
    return { dir, env };
  }

  it("reuses the CDN, translates only the delta, protects terms, writes files and outputs", async () => {
    const en = { a: "Alpha", b: "Open {{name}} in Deriv MCP", c: "Gamma" };
    const { dir, env } = setup(en, ["Deriv MCP"]);
    const logs: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      if (url.startsWith("https://cdn.test/")) {
        if (url.endsWith("/es.json")) return jsonResponse(200, { a: "Alfa", gone: "Pruned" });
        return new Response("not found", { status: 404 }); // fr starts empty
      }
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { content: Record<string, string>; target_languages: string[] };
        // The union of both locales' deltas, protected.
        expect(Object.keys(body.content).sort()).toEqual(["a", "b", "c"]);
        expect(body.content.b).toBe('Open <x-ph i="0"></x-ph> in <x-pt i="1"></x-pt>');
        expect(body.target_languages).toEqual(["Spanish", "French"]);
        return jsonResponse(202, { job_id: "job-9", status: "queued" });
      }
      return jsonResponse(200, {
        status: "completed",
        results: {
          Spanish: { a: "Alfa", b: 'Abrir <x-ph i="0"></x-ph> en <x-pt i="1"></x-pt>', c: "Gama" },
          French: { a: "Alpha-fr", b: 'Ouvrir <x-ph i="0"/> dans <x-pt i="1"/>', c: "Gamma-fr" },
        },
        errors: null,
      });
    };
    const result = await sync.main(env, { fetch: fetchImpl, sleep: noSleep, log: (m) => logs.push(m) });
    expect(result.status).toBe("completed");
    expect(result.keptBackTotal).toBe(0);
    expect(readJson(join(dir, "translations", "es.json"))).toEqual({ a: "Alfa", b: "Abrir {{name}} en Deriv MCP", c: "Gama" }); // reused a, pruned "gone"
    expect(readJson(join(dir, "translations", "fr.json"))).toEqual({ a: "Alpha-fr", b: "Ouvrir {{name}} dans Deriv MCP", c: "Gamma-fr" });
    expect(readText(join(dir, "output.txt"))).toBe("status=completed\nkept_back=0\ntranslated=3\nfrom_fallback=0\noverridden=0\n");
    expect(readText(join(dir, "summary.md"))).toContain("| es | 1 | 2 | 1 | 0 |");
    expect(logs.join("\n")).not.toContain("secret");
  });

  it("sends the service token from the environment on every Rosetta request, and not to the CDN", async () => {
    const { env } = setup({ a: "Alpha" });
    env.ROSETTA_CF_ACCESS_CLIENT_ID = "id.access";
    env.ROSETTA_CF_ACCESS_CLIENT_SECRET = "cf-secret-value";
    const logs: string[] = [];
    const sent: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      sent.push({ url, headers: { ...((init?.headers as Record<string, string>) || {}) } });
      if (url.startsWith("https://cdn.test/")) return new Response("", { status: 404 });
      if (init?.method === "POST") return jsonResponse(202, { job_id: "job-12", status: "queued" });
      return jsonResponse(200, { status: "completed", results: { Spanish: { a: "Alfa" }, French: { a: "Alpha-fr" } }, errors: null });
    };
    await sync.main(env, { fetch: fetchImpl, sleep: noSleep, log: (m) => logs.push(m) });
    const rosetta = sent.filter((c) => c.url.startsWith("https://rosetta.test/"));
    expect(rosetta).toHaveLength(2);
    for (const call of rosetta) expect(call.headers["CF-Access-Client-Secret"]).toBe("cf-secret-value");
    const cdn = sent.filter((c) => c.url.startsWith("https://cdn.test/"));
    expect(cdn.length).toBeGreaterThan(0);
    for (const call of cdn) expect(call.headers["CF-Access-Client-Secret"]).toBeUndefined();
    expect(logs.join("\n")).not.toContain("cf-secret-value");
  });

  it("submits to /v1/translate and polls /v1/translate/{job_id} on the configured base", async () => {
    const { env } = setup({ a: "Alpha" });
    const logs: string[] = [];
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      if (url.startsWith("https://cdn.test/")) return new Response("", { status: 404 });
      calls.push(`${init?.method || "GET"} ${url}`);
      if (init?.method === "POST") return jsonResponse(202, { job_id: "job-11", status: "queued" });
      return jsonResponse(200, { status: "completed", results: { Spanish: { a: "Alfa" }, French: { a: "Alpha-fr" } }, errors: null });
    };
    const result = await sync.main(env, { fetch: fetchImpl, sleep: noSleep, log: (m) => logs.push(m) });
    expect(result.status).toBe("completed");
    expect(calls).toEqual(["POST https://rosetta.test/v1/translate", "GET https://rosetta.test/v1/translate/job-11"]);
    expect(logs.join("\n")).not.toContain("secret");
  });

  it("reads and writes zh_cn / zh_tw catalogues under the runtime's file names", async () => {
    const en = { a: "Alpha", b: "Beta" };
    const { dir, env } = setup(en);
    env.TARGET_LOCALES = "zh_cn,zh_tw";
    const cdnUrls: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      if (url.startsWith("https://cdn.test/")) {
        cdnUrls.push(url);
        return jsonResponse(200, { a: url.endsWith("/zh_cn.json") ? "阿尔法" : "阿爾法" });
      }
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { content: Record<string, string>; target_languages: string[] };
        expect(Object.keys(body.content)).toEqual(["b"]);
        expect(body.target_languages).toEqual(["Simplified Chinese", "Traditional Chinese"]);
        return jsonResponse(202, { job_id: "job-zh", status: "queued" });
      }
      return jsonResponse(200, {
        status: "completed",
        results: { "Simplified Chinese": { b: "贝塔" }, "Traditional Chinese": { b: "貝塔" } },
        errors: null,
      });
    };
    const result = await sync.main(env, { fetch: fetchImpl, sleep: noSleep, log: () => {} });
    expect(result.status).toBe("completed");
    expect(cdnUrls).toEqual([
      "https://cdn.test/proj/staging/translations/zh_cn.json",
      "https://cdn.test/proj/staging/translations/zh_tw.json",
    ]);
    expect(readJson(join(dir, "translations", "zh_cn.json"))).toEqual({ a: "阿尔法", b: "贝塔" });
    expect(readJson(join(dir, "translations", "zh_tw.json"))).toEqual({ a: "阿爾法", b: "貝塔" });
  });

  it("keeps back broken and failed strings, warns, and still writes every locale", async () => {
    const en = { a: "Alpha", b: "Hi {{name}}" };
    const { dir, env } = setup(en);
    const logs: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      if (url.startsWith("https://cdn.test/")) return new Response("", { status: 404 });
      if (init?.method === "POST") return jsonResponse(202, { job_id: "job-10", status: "queued" });
      return jsonResponse(200, {
        status: "partial",
        results: { Spanish: { a: "Alfa", b: "Hola" } }, // b lost its placeholder
        errors: { French: "model rejected" },
      });
    };
    const result = await sync.main(env, { fetch: fetchImpl, sleep: noSleep, log: (m) => logs.push(m) });
    expect(result.status).toBe("partial");
    expect(readJson(join(dir, "translations", "es.json"))).toEqual({ a: "Alfa" });
    expect(readJson(join(dir, "translations", "fr.json"))).toEqual({});
    expect(result.keptBackTotal).toBe(3); // es:b broken, fr:a and fr:b failed
    expect(readText(join(dir, "output.txt"))).toContain("status=partial\nkept_back=3\n");
    expect(logs.some((l) => l.startsWith("::warning::Rosetta returned a partial result"))).toBe(true);
    expect(logs.some((l) => l.startsWith("::warning::3 string(s) were kept out"))).toBe(true);
  });

  it("does nothing but rewrite the files when the CDN already has every key", async () => {
    const en = { a: "Alpha" };
    const { dir, env } = setup(en);
    let posts = 0;
    const fetchImpl: FetchLike = async (url, init) => {
      if (init?.method === "POST") posts += 1;
      return jsonResponse(200, { a: url.includes("/es.json") ? "Alfa" : "Alpha-fr" });
    };
    const result = await sync.main(env, { fetch: fetchImpl, sleep: noSleep, log: () => {} });
    expect(result.status).toBe("noop");
    expect(posts).toBe(0);
    expect(readJson(join(dir, "translations", "es.json"))).toEqual({ a: "Alfa" });
    expect(readText(join(dir, "output.txt"))).toBe("status=noop\nkept_back=0\ntranslated=0\nfrom_fallback=0\noverridden=0\n");
  });

  it("reports completed, not noop, when pruning, the fallback or an override changes a catalogue with nothing to translate", async () => {
    const en = { a: "Alpha" };
    const run = async ({ es, staging, overrides }: { es: Record<string, string>; staging?: Record<string, string>; overrides?: unknown }) => {
      const { dir, env } = setup(en);
      env.TARGET_LOCALES = "es";
      if (staging) Object.assign(env, { ENVIRONMENT: "production", FALLBACK_ENVIRONMENT: "staging" });
      if (overrides) {
        env.OVERRIDES_FILE = join(dir, "overrides.json");
        writeJson(env.OVERRIDES_FILE, overrides);
      }
      let posts = 0;
      const fetchImpl: FetchLike = async (url, init) => {
        if (init?.method === "POST") posts += 1;
        return jsonResponse(200, staging && url.includes("/staging/") ? staging : es);
      };
      const result = await sync.main(env, { fetch: fetchImpl, sleep: noSleep, log: () => {} });
      expect(posts).toBe(0);
      return { ...result, output: readText(join(dir, "output.txt")) };
    };
    expect(await run({ es: { a: "Alfa", gone: "Pruned" } })).toMatchObject({ status: "completed" });
    expect(await run({ es: {}, staging: { a: "Alfa" } })).toMatchObject({
      status: "completed",
      output: "status=completed\nkept_back=0\ntranslated=0\nfrom_fallback=1\noverridden=0\n",
    });
    expect(await run({ es: { a: "Alfa" }, overrides: { es: { Alpha: "Alfa corregido" } } })).toMatchObject({ status: "completed", overriddenTotal: 1 });
    // An override that is already published changes nothing.
    expect(await run({ es: { a: "Alfa" }, overrides: { es: { Alpha: "Alfa" } } })).toMatchObject({ status: "noop", overriddenTotal: 0 });
  });

  it("rejects a protected-terms file that is not a JSON array of strings", async () => {
    const { dir, env } = setup({ a: "Alpha" });
    writeJson(join(dir, "terms.json"), { not: "an array" });
    env.PROTECTED_TERMS_FILE = join(dir, "terms.json");
    await expect(sync.main(env, { fetch: async () => jsonResponse(404, {}), sleep: noSleep, log: () => {} })).rejects.toThrow(/must be a JSON array of strings/);
  });

  describe("a production sync with staging as the fallback", () => {
    const en = { a: "Alpha", b: "Beta", c: "Gamma {{n}}", d: "1 Change" };
    const cdn: Record<string, Record<string, Record<string, string>>> = {
      production: { es: { a: "Alfa-prod" }, fr: { a: "Alpha-prod" } },
      staging: { es: { a: "Alfa-stg", b: "Beta-stg", c: "Gama sin n" }, fr: { a: "Alpha-stg", b: "Beta-stg-fr", c: "Gamma-fr {{n}}" } },
    };

    function productionSetup(extra: Env = {}) {
      const { dir, env } = setup(en);
      Object.assign(env, { ENVIRONMENT: "production", FALLBACK_ENVIRONMENT: "staging", REFERENCE: "proj/production/test" }, extra);
      const cdnUrls: string[] = [];
      const sent: string[][] = [];
      const fetchImpl: FetchLike = async (url, init) => {
        const hit = url.match(/^https:\/\/cdn\.test\/proj\/(\w+)\/translations\/(\w+)\.json$/);
        if (hit) {
          cdnUrls.push(url);
          return jsonResponse(200, cdn[hit[1]][hit[2]]);
        }
        if (init?.method === "POST") {
          sent.push(Object.keys((JSON.parse(String(init.body)) as { content: Record<string, string> }).content).sort());
          return jsonResponse(202, { job_id: "job-p", status: "queued" });
        }
        return jsonResponse(200, {
          status: "completed",
          results: { Spanish: { c: "Gama {{n}}", d: "1 Cambio" }, French: { d: "1 Modifier" } },
          errors: null,
        });
      };
      return { dir, env, fetchImpl, cdnUrls, sent };
    }

    it("takes the keys production lacks from staging, checks them, and sends only the rest to Rosetta", async () => {
      const { dir, env, fetchImpl, cdnUrls, sent } = productionSetup();
      const logs: string[] = [];
      const result = await sync.main(env, { fetch: fetchImpl, sleep: noSleep, log: (m) => logs.push(m) });
      expect(cdnUrls).toEqual([
        "https://cdn.test/proj/production/translations/es.json",
        "https://cdn.test/proj/staging/translations/es.json",
        "https://cdn.test/proj/production/translations/fr.json",
        "https://cdn.test/proj/staging/translations/fr.json",
      ]);
      // es:c is on staging but lost its placeholder there, so Rosetta translates it.
      expect(sent).toEqual([["c", "d"]]);
      expect(readJson(join(dir, "translations", "es.json"))).toEqual({ a: "Alfa-prod", b: "Beta-stg", c: "Gama {{n}}", d: "1 Cambio" });
      expect(readJson(join(dir, "translations", "fr.json"))).toEqual({ a: "Alpha-prod", b: "Beta-stg-fr", c: "Gamma-fr {{n}}", d: "1 Modifier" });
      expect(result).toMatchObject({ status: "completed", fromFallbackTotal: 3, overriddenTotal: 0 });
      expect(readText(join(dir, "output.txt"))).toBe("status=completed\nkept_back=0\ntranslated=2\nfrom_fallback=3\noverridden=0\n");
      const summary = readText(join(dir, "summary.md"));
      expect(summary).toContain("| es | 1 | 2 | 0 | 0 | 1 |  |");
      expect(summary).toContain("| fr | 1 | 1 | 0 | 0 | 2 |  |");
      expect(summary).toContain("`" + "c` — placeholders do not match the source");
      expect(logs).toContain("es: 1 reused, 1 from staging, 2 to translate, 0 pruned");
    });

    it("prefer mode converges production on staging, and an override corrects a value in both", async () => {
      const { dir, env, fetchImpl, sent } = productionSetup({ FALLBACK_MODE: "prefer", OVERRIDES_FILE: join(dirOf(), "overrides.json") });
      writeJson(env.OVERRIDES_FILE as string, { fr: { "1 Change": "1 modification", "No longer in the source": "x" } });
      const logs: string[] = [];
      const result = await sync.main(env, { fetch: fetchImpl, sleep: noSleep, log: (m) => logs.push(m) });
      // fr:d is overridden, so only es still needs c and d.
      expect(sent).toEqual([["c", "d"]]);
      expect(readJson(join(dir, "translations", "es.json"))).toEqual({ a: "Alfa-stg", b: "Beta-stg", c: "Gama {{n}}", d: "1 Cambio" });
      expect(readJson(join(dir, "translations", "fr.json"))).toEqual({ a: "Alpha-stg", b: "Beta-stg-fr", c: "Gamma-fr {{n}}", d: "1 modification" });
      expect(result).toMatchObject({ fromFallbackTotal: 5, overriddenTotal: 1 });
      expect(readText(join(dir, "summary.md"))).toContain('**fr** "No longer in the source" — this English text is no longer extracted');
      expect(logs.some((l) => l.startsWith("::warning::1 override(s)"))).toBe(true);
    });

    it("fails before calling Rosetta when an override breaks a placeholder", async () => {
      const { env, fetchImpl, sent } = productionSetup({ OVERRIDES_FILE: join(dirOf(), "bad-overrides.json") });
      writeJson(env.OVERRIDES_FILE as string, { es: { "Gamma {{n}}": "Gama" } });
      await expect(sync.main(env, { fetch: fetchImpl, sleep: noSleep, log: () => {} })).rejects.toThrow(/placeholders do not match/);
      expect(sent).toEqual([]);
    });

    it("starts from an empty fallback when the staging catalogue does not exist", async () => {
      const { dir, env } = productionSetup();
      const fetchImpl: FetchLike = async (url, init) => {
        if (url.includes("/staging/")) return new Response("not found", { status: 404 });
        if (url.startsWith("https://cdn.test/")) return jsonResponse(200, { a: "A", b: "B", c: "C {{n}}", d: "D" });
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
      };
      const logs: string[] = [];
      const result = await sync.main(env, { fetch: fetchImpl, sleep: noSleep, log: (m) => logs.push(m) });
      expect(result).toMatchObject({ status: "noop", fromFallbackTotal: 0 });
      expect(readJson(join(dir, "translations", "fr.json"))).toEqual({ a: "A", b: "B", c: "C {{n}}", d: "D" });
      expect(logs).toContain("No fallback catalogue at https://cdn.test/proj/staging/translations/es.json (404) — es takes no values from staging");
      expect(logs.some((l) => l.startsWith("No previous catalogue"))).toBe(false);
    });

    it("names the fallback catalogue when fetching it fails", async () => {
      const { env } = productionSetup();
      const fetchImpl: FetchLike = async (url) =>
        url.includes("/staging/") ? new Response("upstream", { status: 503 }) : jsonResponse(200, { a: "A" });
      await expect(sync.main(env, { fetch: fetchImpl, sleep: noSleep, log: () => {} })).rejects.toThrow(
        "Fetching the fallback (staging) es catalogue failed: HTTP 503 for https://cdn.test/proj/staging/translations/es.json",
      );
    });
  });
});
