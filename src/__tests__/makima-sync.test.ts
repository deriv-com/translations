import { describe, expect, it, vi } from "vitest";

type Token = { kind: "ph" | "pt"; original: string };
type Plan = { reuse: Record<string, string>; missing: string[]; pruned: string[] };
type MergeResult = {
  catalogue: Record<string, string>;
  keptBack: { key: string; english: string; reason: string }[];
  added: number;
  reused: number;
  pruned: number;
};
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface SyncModule {
  LANGUAGES: { code: string; name: string }[];
  makimaNameFor(code: string): string;
  localeFileName(code: string): string;
  protect(text: string, terms?: string[]): { text: string; tokens: Token[] };
  restore(translated: string, tokens: Token[], source: string): { ok: boolean; text: string; reason: string | null };
  planLocale(en: Record<string, string>, prev: Record<string, string>): Plan;
  mergeLocale(args: {
    en: Record<string, string>;
    plan: Plan;
    translated?: Record<string, string>;
    tokensByKey: Record<string, Token[]>;
  }): MergeResult;
  chunkContent(content: Record<string, string>, maxBytes?: number): Record<string, string>[];
  retryDelayMs(res: { headers: { get(name: string): string | null } } | null, attempt: number, cap?: number): number;
  translateContent(args: {
    content: Record<string, string>;
    targetNames: string[];
    reference: string;
    fetchImpl: FetchLike;
    base: string;
    apiKey: string;
    sleep: (ms: number) => Promise<void>;
  }): Promise<{ status: string; results: Record<string, Record<string, string>>; errors: Record<string, string> }>;
  readEnv(env: Record<string, string | undefined>): { locales: string[]; dryRun: boolean; base: string; reference: string };
  buildSummary(args: {
    project: string;
    environment: string;
    reference: string;
    status: string;
    perLocale: { locale: string; reused: number; added: number; pruned: number; keptBack: { key: string; english: string; reason: string }[]; note?: string }[];
    makimaErrors: Record<string, string>;
    dryRun: boolean;
  }): string;
}

// The script is plain CommonJS (it ships as a bin next to the extractor), so
// it has no type declarations; Vite's interop exposes module.exports as the
// default export.
// @ts-expect-error -- untyped .cjs module, typed locally through SyncModule
const loaded: unknown = await import("../scripts/deriv-makima-sync.cjs");
const sync = (((loaded as { default?: unknown }).default ?? loaded) as SyncModule);

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

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

    // A faithful "translation" that reorders the sentence but keeps every token.
    const translated = text.replace("Build your", "Construye tu").replace("app with", "app con").replace("steps.", "pasos.");
    const result = sync.restore(translated, tokens, source);
    expect(result.ok).toBe(true);
    expect(result.text).toBe("Construye tu {{name}} app con <0>Deriv MCP</0> in {{count}} pasos.");
  });

  it("accepts the self-closing and spaced forms Makima may emit", () => {
    const source = "Hello {{name}}";
    const { tokens } = sync.protect(source);
    expect(sync.restore('Hola <ph i="0"/>', tokens, source).ok).toBe(true);
    expect(sync.restore('Hola <ph i="0" />', tokens, source).ok).toBe(true);
    expect(sync.restore('Hola <ph i="0"> </ph>', tokens, source).ok).toBe(true);
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
    const merged = sync.mergeLocale({
      en,
      plan,
      translated: { b: "Beta rota", c: "Gama" }, // b lost its placeholder
      tokensByKey,
    });
    expect(merged.catalogue).toEqual({ a: "Alfa", c: "Gama" });
    expect(merged.added).toBe(1);
    expect(merged.reused).toBe(1);
    expect(merged.keptBack).toEqual([{ key: "b", english: "Beta {{n}}", reason: expect.stringMatching(/placeholders/) }]);
  });

  it("keeps back a key Makima did not return", () => {
    const plan = sync.planLocale(en, {});
    const merged = sync.mergeLocale({ en, plan, translated: { a: "Alfa" }, tokensByKey: { a: [], b: [], c: [] } });
    expect(Object.keys(merged.catalogue)).toEqual(["a"]);
    expect(merged.keptBack.map((k) => k.key).sort()).toEqual(["b", "c"]);
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
});

describe("submit → poll", () => {
  const noSleep = () => Promise.resolve();

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
      return jsonResponse(200, {
        job_id: "job-1",
        status: "completed",
        results: { Spanish: { k1: "Hola" }, French: { k1: "Bonjour" } },
        errors: null,
      });
    };
    const out = await sync.translateContent({
      content: { k1: "Hello" },
      targetNames: ["Spanish", "French"],
      reference: "proj/staging/abc",
      fetchImpl,
      base: "https://makima.test",
      apiKey: "secret",
      sleep: noSleep,
    });
    expect(out.status).toBe("completed");
    expect(out.results).toEqual({ Spanish: { k1: "Hola" }, French: { k1: "Bonjour" } });
    expect(calls[0]).toBe("POST https://makima.test/api/makima/translate");
    expect(calls.filter((c) => c.startsWith("GET"))).toHaveLength(3);
  });

  it("surfaces a partial job with its per-language errors", async () => {
    const fetchImpl: FetchLike = async (_url, init) =>
      init?.method === "POST"
        ? jsonResponse(202, { job_id: "job-2", status: "queued" })
        : jsonResponse(200, { job_id: "job-2", status: "partial", results: { Spanish: { k1: "Hola" } }, errors: { French: "No valid JSON translation produced" } });
    const out = await sync.translateContent({
      content: { k1: "Hello" },
      targetNames: ["Spanish", "French"],
      reference: "r",
      fetchImpl,
      base: "https://makima.test",
      apiKey: "secret",
      sleep: noSleep,
    });
    expect(out.status).toBe("partial");
    expect(out.results.French).toBeUndefined();
    expect(out.errors).toEqual({ French: "No valid JSON translation produced" });
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
    await expect(
      sync.translateContent({ content: { k: "x" }, targetNames: ["Spanish"], reference: "r", fetchImpl, base: "https://makima.test", apiKey: "s", sleep })
    ).rejects.toThrow(/job job-3 failed: "upstream down"/);
    expect(posts).toBe(2);
    expect(sleep).toHaveBeenCalledWith(1000);
  });
});

describe("configuration and summary", () => {
  it("reads the action's environment and derives the defaults", () => {
    const cfg = sync.readEnv({
      PROJECT_NAME: "deriv-blox",
      ENVIRONMENT: "staging",
      TARGET_LOCALES: " es, fr ,pt ",
      MAKIMA_API_KEY: "k",
      GITHUB_SHA: "abc123",
    });
    expect(cfg.locales).toEqual(["es", "fr", "pt"]);
    expect(cfg.dryRun).toBe(false);
    expect(cfg.base).toBe("https://pedro-api-dev.deriv.ai");
    expect(cfg.reference).toBe("deriv-blox/staging/abc123");
  });

  it("rejects a missing key and an unknown environment", () => {
    expect(() => sync.readEnv({ PROJECT_NAME: "p", ENVIRONMENT: "staging", TARGET_LOCALES: "es" })).toThrow(/MAKIMA_API_KEY is required/);
    expect(() => sync.readEnv({ PROJECT_NAME: "p", ENVIRONMENT: "qa", TARGET_LOCALES: "es", MAKIMA_API_KEY: "k" })).toThrow(/ENVIRONMENT must be/);
  });

  it("writes a summary table and lists kept-back strings", () => {
    const text = sync.buildSummary({
      project: "deriv-blox",
      environment: "staging",
      reference: "deriv-blox/staging/abc",
      status: "partial",
      perLocale: [
        { locale: "es", reused: 10, added: 2, pruned: 1, keptBack: [{ key: "k9", english: "Hi {{x}}", reason: "placeholders do not match the source" }] },
        { locale: "fr", reused: 10, added: 0, pruned: 1, keptBack: [], note: "language failed — file unchanged apart from pruning" },
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
