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
  makimaNameFor(code: string): string;
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
    sleep: (ms: number) => Promise<void>;
  }): Promise<{ status: string; results: Record<string, Record<string, string>>; errors: Record<string, string>; failedKeys: Record<string, Set<string>> }>;
  readEnv(env: Env): {
    locales: string[];
    dryRun: boolean;
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
    makimaErrors: Record<string, string>;
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
const loaded: unknown = await import("../scripts/deriv-makima-sync.cjs");
const sync = (((loaded as { default?: unknown }).default ?? loaded) as SyncModule);

const byteLength = (text: string): number => new TextEncoder().encode(text).length;
const noSleep = () => Promise.resolve();
const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

describe("locale mapping", () => {
  it("maps the project's locale codes to Makima language names", () => {
    expect(sync.makimaNameFor("es")).toBe("Spanish");
    expect(sync.makimaNameFor("FR")).toBe("French");
    expect(sync.makimaNameFor("pt")).toBe("Portuguese");
    expect(sync.LANGUAGES).toHaveLength(39);
  });

  it("rejects an unknown code and lower-cases the file name", () => {
    expect(() => sync.makimaNameFor("xx")).toThrow(/Unknown locale "xx"/);
    expect(sync.localeFileName("ES")).toBe("es.json");
  });

  it("accepts the runtime's zh_cn / zh_tw spellings and keeps them as the file name", () => {
    expect(sync.makimaNameFor("zh_cn")).toBe("Simplified Chinese");
    expect(sync.makimaNameFor("ZH_TW")).toBe("Traditional Chinese");
    expect(sync.makimaNameFor("zh-CN")).toBe("Simplified Chinese");
    expect(sync.makimaNameFor("zh-Hant-TW")).toBe("Traditional Chinese");
    expect(sync.localeFileName("ZH_CN")).toBe("zh_cn.json");
    expect(() => sync.makimaNameFor("xx")).toThrow(/zh-CN, zh_cn, zh-Hant-TW, zh_tw/);
  });
});

describe("token protection", () => {
  it("hides placeholders, markers and protected terms behind HTML tokens and restores them", () => {
    const source = "Build your {{name}} app with <0>Deriv MCP</0> in {{count}} steps.";
    const { text, tokens } = sync.protect(source, ["Deriv MCP"]);
    expect(text).not.toContain("{{");
    expect(text).not.toContain("<0>");
    expect(text).not.toContain("Deriv MCP");
    expect(text).toContain('<ph i="0"></ph>');
    expect(text).toContain("<c0>");
    expect(tokens.map((t) => t.original)).toEqual(["{{name}}", "{{count}}", "Deriv MCP"]);

    const translated = text.replace("Build your", "Construye tu").replace("app with", "app con").replace("steps.", "pasos.");
    const result = sync.restore(translated, tokens, source);
    expect(result.ok).toBe(true);
    expect(result.text).toBe("Construye tu {{name}} app con <0>Deriv MCP</0> in {{count}} pasos.");
  });

  it("protects every i18next interpolation shape, not only {{name}}", () => {
    const source = "{{count, number}} items, {{- raw}} and $t(common.ok)";
    const { text, tokens } = sync.protect(source);
    expect(text).toBe('<ph i="0"></ph> items, <ph i="1"></ph> and <ph i="2"></ph>');
    expect(tokens.map((t) => t.original)).toEqual(["{{count, number}}", "{{- raw}}", "$t(common.ok)"]);
    expect(sync.restore(text.replace("items", "elementos"), tokens, source)).toMatchObject({ ok: true, text: "{{count, number}} elementos, {{- raw}} and $t(common.ok)" });
  });

  it("accepts the self-closing and spaced forms Makima may emit", () => {
    const source = "Hello {{name}}";
    const { tokens } = sync.protect(source);
    expect(sync.restore('Hola <ph i="0"/>', tokens, source).ok).toBe(true);
    expect(sync.restore('Hola <ph i="0" />', tokens, source).ok).toBe(true);
    expect(sync.restore('Hola <ph i="0"> </ph>', tokens, source).ok).toBe(true);
  });

  it("decodes HTML entities the translator added, but only when the source had none", () => {
    expect(sync.restore("Pares &amp; opciones &lt;rápido&gt;", [], "Pairs & options <fast>")).toMatchObject({ ok: true, text: "Pares & opciones <rápido>" });
    // A source that already carries an entity is left exactly as returned.
    expect(sync.restore("Tom &amp; Jerry", [], "Tom &amp; Jerry")).toMatchObject({ ok: true, text: "Tom &amp; Jerry" });
  });

  it("fails closed when a token is lost, duplicated or translated", () => {
    const source = "Copy {{value}} to <0>clipboard</0> with Claude Code";
    const { text, tokens } = sync.protect(source, ["Claude Code"]);
    expect(sync.restore(text.replace('<ph i="0"></ph>', ""), tokens, source)).toMatchObject({ ok: false, reason: /placeholders/ });
    expect(sync.restore(text.replace("</c0>", ""), tokens, source)).toMatchObject({ ok: false, reason: /markers|token/ });
    expect(sync.restore(text.replace('<pt i="1"></pt>', "Código Claude"), tokens, source)).toMatchObject({ ok: false, reason: /protected term/ });
  });

  it("does not protect a term inside a longer word", () => {
    const { text, tokens } = sync.protect("Bots and Bot", ["Bot"]);
    expect(text).toBe('Bots and <pt i="0"></pt>');
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

  it("keeps back a key Makima did not return, and a key whose chunk failed", () => {
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
      { key: "b", english: "Beta {{n}}", reason: "not returned by Makima" },
      { key: "c", english: "Gamma", reason: "language failed in Makima: upstream 500" },
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
    const out = await sync.translateContent({ content: { k1: "Hello" }, targetNames: ["Spanish", "French"], reference: "proj/staging/abc", fetchImpl, base: "https://makima.test", apiKey: "secret", sleep: noSleep });
    expect(out.status).toBe("completed");
    expect(out.results).toEqual({ Spanish: { k1: "Hola" }, French: { k1: "Bonjour" } });
    expect(out.failedKeys).toEqual({});
    expect(calls[0]).toBe("POST https://makima.test/api/makima/translate");
    expect(calls.filter((c) => c.startsWith("GET"))).toHaveLength(3);
  });

  it("surfaces a partial job with its per-language errors and the keys that failed", async () => {
    const fetchImpl: FetchLike = async (_url, init) =>
      init?.method === "POST"
        ? jsonResponse(202, { job_id: "job-2", status: "queued" })
        : jsonResponse(200, { job_id: "job-2", status: "partial", results: { Spanish: { k1: "Hola" } }, errors: { French: "No valid JSON translation produced" } });
    const out = await sync.translateContent({ content: { k1: "Hello" }, targetNames: ["Spanish", "French"], reference: "r", fetchImpl, base: "https://makima.test", apiKey: "secret", sleep: noSleep });
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
    const out = await sync.translateContent({ content, targetNames: ["French"], reference: "r", fetchImpl, base: "https://makima.test", apiKey: "s", sleep: noSleep });
    expect(posts).toBe(2);
    expect(out.status).toBe("partial");
    expect(out.results.French).toEqual({ a: "A-fr", b: "B-fr" }); // chunk 1 kept
    expect([...out.failedKeys.French]).toEqual(["c"]); // only chunk 2's key retried next run
    expect(out.errors).toEqual({ French: "boom" });
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
    await expect(sync.translateContent({ content: { k: "x" }, targetNames: ["Spanish"], reference: "r", fetchImpl, base: "https://makima.test", apiKey: "s", sleep })).rejects.toThrow(/job job-3 failed: "upstream down"/);
    expect(posts).toBe(2);
    expect(sleep).toHaveBeenCalledWith(1000);
  });
});

describe("configuration and summary", () => {
  const baseEnv: Env = { PROJECT_NAME: "deriv-blox", ENVIRONMENT: "staging", TARGET_LOCALES: " es, fr ,pt ", MAKIMA_API_KEY: "k", MAKIMA_API_BASE: "https://makima.test/", GITHUB_SHA: "abc123" };

  it("reads the action's environment and derives the defaults", () => {
    const cfg = sync.readEnv(baseEnv);
    expect(cfg.locales).toEqual(["es", "fr", "pt"]);
    expect(cfg.dryRun).toBe(false);
    expect(cfg.base).toBe("https://makima.test");
    expect(cfg.reference).toBe("deriv-blox/staging/abc123");
  });

  it("requires the key and the base URL, and rejects an unknown environment", () => {
    expect(() => sync.readEnv({ ...baseEnv, MAKIMA_API_KEY: undefined })).toThrow(/MAKIMA_API_KEY is required/);
    expect(() => sync.readEnv({ ...baseEnv, MAKIMA_API_BASE: undefined })).toThrow(/MAKIMA_API_BASE is required/);
    expect(() => sync.readEnv({ ...baseEnv, ENVIRONMENT: "qa" })).toThrow(/ENVIRONMENT must be/);
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
        { locale: "fr", reused: 10, added: 0, pruned: 1, keptBack: [], note: "Makima failed this language" },
      ],
      makimaErrors: { French: "boom" },
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
      makimaErrors: {},
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
  const dirOf = () => makeTempDir("makima-overrides-");

  function setup(en: Record<string, string>, terms?: string[]) {
    const dir = makeTempDir();
    writeJson(join(dir, "translations", "en.json"), en);
    const env: Env = {
      PROJECT_NAME: "proj",
      ENVIRONMENT: "staging",
      TARGET_LOCALES: "es,fr",
      MAKIMA_API_KEY: "secret",
      MAKIMA_API_BASE: "https://makima.test",
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
        expect(body.content.b).toBe('Open <ph i="0"></ph> in <pt i="1"></pt>');
        expect(body.target_languages).toEqual(["Spanish", "French"]);
        return jsonResponse(202, { job_id: "job-9", status: "queued" });
      }
      return jsonResponse(200, {
        status: "completed",
        results: {
          Spanish: { a: "Alfa", b: 'Abrir <ph i="0"></ph> en <pt i="1"></pt>', c: "Gama" },
          French: { a: "Alpha-fr", b: 'Ouvrir <ph i="0"/> dans <pt i="1"/>', c: "Gamma-fr" },
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
    expect(logs.some((l) => l.startsWith("::warning::Makima returned a partial result"))).toBe(true);
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

    it("takes the keys production lacks from staging, checks them, and sends only the rest to Makima", async () => {
      const { dir, env, fetchImpl, cdnUrls, sent } = productionSetup();
      const logs: string[] = [];
      const result = await sync.main(env, { fetch: fetchImpl, sleep: noSleep, log: (m) => logs.push(m) });
      expect(cdnUrls).toEqual([
        "https://cdn.test/proj/production/translations/es.json",
        "https://cdn.test/proj/staging/translations/es.json",
        "https://cdn.test/proj/production/translations/fr.json",
        "https://cdn.test/proj/staging/translations/fr.json",
      ]);
      // es:c is on staging but lost its placeholder there, so Makima translates it.
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

    it("fails before calling Makima when an override breaks a placeholder", async () => {
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
