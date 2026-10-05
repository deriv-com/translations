/// <reference types="node" />
import { existsSync, readFileSync } from "fs";
import { builtinModules } from "module";
import { resolve } from "path";
import { cwd } from "process";
import { describe, expect, it } from "vitest";

// A consumer pins a sync action by commit SHA. That pin only covers the code
// the job runs with its secrets if the action runs the scripts from its own
// commit, with dependencies from that commit's lockfile, rather than whatever
// `@deriv-com/translations` release is newest on npm.

// `npm test` runs from the repo root. (Under jsdom, import.meta.url is not a
// file: URL, so it cannot locate the repo.)
const repoFile = (path: string) => resolve(cwd(), path);
const read = (path: string) => readFileSync(repoFile(path), "utf8");

// The YAML without its comments, which are allowed to name what not to do.
const stepsOf = (action: string) =>
  read(`.github/actions/${action}/action.yml`)
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

const requiresOf = (script: string) =>
  [...read(`src/scripts/${script}`).matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);

// The climb from github.action_path (.github/actions/<action>) to the repo root,
// where the scripts and the lockfile are. The YAML must use exactly this.
const UP_TO_ROOT = "../../..";
const ACTION_ROOT = `\${{ github.action_path }}/${UP_TO_ROOT}`;
const scriptRun = (bin: string) => `node "$GITHUB_ACTION_PATH/${UP_TO_ROOT}/src/scripts/${bin}.cjs"`;

// Runtime dependencies only, and no lifecycle scripts: without --ignore-scripts,
// npm ci runs this repo's prepublish (npm test && npm run build).
const NPM_CI_FLAGS = ["--omit=dev", "--omit=peer", "--omit=optional", "--ignore-scripts"];

describe.each(["extract_and_sync_translations", "extract_and_sync_translations_makima"])("the %s action", (action) => {
  const steps = stepsOf(action);

  it("never installs @deriv-com/translations from the registry", () => {
    expect(steps).not.toMatch(/npm\s+(i|install|add)\b[^\n]*@deriv-com\/translations/);
  });

  it("never runs a bin through npx, which would fetch a missing one from the registry", () => {
    expect(steps).not.toMatch(/\bnpx\b/);
  });

  it("installs the extractor's runtime dependencies from its own lockfile, without install scripts", () => {
    // A whole-line match: a deeper climb would still contain this one as a substring.
    expect(steps.split("\n").map((line) => line.trim())).toContain(`working-directory: ${ACTION_ROOT}`);
    const install = steps.match(/^\s*run: (npm ci\b.*)$/m)?.[1].split(/\s+/) ?? [];
    expect(install).toEqual(expect.arrayContaining(NPM_CI_FLAGS));
  });

  it("runs the extractor from its own commit", () => {
    expect(steps).toContain(scriptRun("deriv-extract-translations"));
  });

  it(`reaches the repo root from the action folder by ${UP_TO_ROOT}`, () => {
    // Resolve from the real action folder, so a folder that moves deeper fails here.
    const actionDir = repoFile(`.github/actions/${action}`);
    expect(existsSync(resolve(actionDir, "action.yml"))).toBe(true);
    const root = resolve(actionDir, UP_TO_ROOT);
    expect(root).toBe(repoFile("."));
    expect(existsSync(resolve(root, "package-lock.json"))).toBe(true);
    expect(existsSync(resolve(root, "src/scripts/deriv-extract-translations.cjs"))).toBe(true);
  });
});

describe("the Makima action", () => {
  it("runs the sync from its own commit", () => {
    expect(stepsOf("extract_and_sync_translations_makima")).toContain(scriptRun("deriv-makima-sync"));
    expect(existsSync(repoFile("src/scripts/deriv-makima-sync.cjs"))).toBe(true);
  });
});

describe("what the scripts need installed", () => {
  it("the sync needs only Node built-ins, so it runs with nothing installed", () => {
    const external = requiresOf("deriv-makima-sync.cjs").filter(
      (name) => !builtinModules.includes(name.replace(/^node:/, "")),
    );
    expect(external).toEqual([]);
  });

  it("the extractor needs only runtime dependencies, which `npm ci --omit=dev` installs", () => {
    const { dependencies } = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    const missing = requiresOf("deriv-extract-translations.cjs").filter(
      (name) => !builtinModules.includes(name.replace(/^node:/, "")) && !(name in dependencies),
    );
    expect(missing).toEqual([]);
  });
});
