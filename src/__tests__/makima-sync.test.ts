import { describe, expect, it, vi } from "vitest";

type Token = { kind: "ph" | "pt"; original: string };
type Plan = { reuse: Record<string, string>; missing: string[]; pruned: string[] };
type KeptBack = { key: string; english: string; reason: string };
type MergeResult = { catalogue: Record<string, string>; keptBack: KeptBack[]; added: number; reused: number; pruned: number };
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
type Env = Record<string, string | undefined>;

interface SyncModule {
  LANGUAGES: { code: string; name: string }[];
  makimaNameFor(code: string): string;
  localeFileName(code: string): string;
  protect(text: string, terms?: string[]): { text: string; tokens: Token[] };
  restore(translated: string, tokens: Token[], source: string): { ok: boolean; text: string; reason: string | null };
  countTerms(text: string, terms: string[]): Record<string, number>;
  planLocale(en: Record<string, string>, prev: Record<string, string>): Plan;
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
  readEnv(env: Env): { locales: string[]; dryRun: boolean; base: string; reference: string };
  buildSummary(args: {
    project: string;
    environment: string;
    reference: string;
    status: string;
    perLocale: { locale: string; reused: number; added: number; pruned: number; keptBack: KeptBack[]; note?: string }[];
    makimaErrors: Record<string, string>;
    dryRun: boolean;
  }): string;
  main(env: Env, io: { fetch: FetchLike; sleep: (ms: number) => Promise<void>; log: (m: string) => void }): Promise<{ status: string; keptBackTotal: number }>;
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
    expect(plan).toEqual({ reuse: { a: "Alfa" }, missing: ["b", "c"], pruned: ["z"] });
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
  });
});

describe("main(): end to end against a temp directory and a mocked gateway", () => {
  const { makeTempDir, writeJson, readJson, readText, join } = sync.testSupport;

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
    expect(readText(join(dir, "output.txt"))).toBe("status=completed\nkept_back=0\ntranslated=3\n");
    expect(readText(join(dir, "summary.md"))).toContain("| es | 1 | 2 | 1 | 0 |");
    expect(logs.join("\n")).not.toContain("secret");
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
    expect(readText(join(dir, "output.txt"))).toBe("status=noop\nkept_back=0\ntranslated=0\n");
  });

  it("rejects a protected-terms file that is not a JSON array of strings", async () => {
    const { dir, env } = setup({ a: "Alpha" });
    writeJson(join(dir, "terms.json"), { not: "an array" });
    env.PROTECTED_TERMS_FILE = join(dir, "terms.json");
    await expect(sync.main(env, { fetch: async () => jsonResponse(404, {}), sleep: noSleep, log: () => {} })).rejects.toThrow(/must be a JSON array of strings/);
  });
});
