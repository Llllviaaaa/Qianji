/**
 * Regression guard for vendored picomatch (CVE-2026-112366 / GHSA-fc5q-39xc-vjpf):
 * single-branch and nested repeated extglobs must execute without catastrophic backtracking
 * while standard glob and extglob matching remains intact.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

interface PicomatchScanResult {
  isGlob: boolean;
  base: string;
  glob: string;
}

interface PicomatchApi {
  (pattern: string, options?: Record<string, unknown>): (input: string) => boolean;
  scan: (pattern: string) => PicomatchScanResult;
  makeRe: (pattern: string) => RegExp;
}

interface PicomatchPkg {
  version: string;
}

const require = createRequire(import.meta.url);
const picomatch = require("picomatch") as PicomatchApi;
const picomatchPkg = require("picomatch/package.json") as PicomatchPkg;

describe("vendored picomatch ReDoS hardening", () => {
  it("resolves the patched vendored picomatch package version", () => {
    expect(picomatchPkg.version).toBe("4.0.8");
  });

  it("preserves standard glob, extglob alternation, and scan behavior", () => {
    expect(picomatch("*.+(js|ts|tsx)")("foo.tsx")).toBe(true);
    expect(picomatch("*.+(js|ts|tsx)")("foo.css")).toBe(false);
    expect(picomatch("+(src|packages)/index.ts")("src/index.ts")).toBe(true);
    expect(picomatch("+(ab|cd)")("abab")).toBe(true);
    expect(picomatch("+([a-z])")("abc")).toBe(true);
    expect(picomatch("+(a?b)")("axbayb")).toBe(true);
    expect(picomatch("+(*(a)|*(b))")("aaabbb")).toBe(true);
    expect(picomatch("**/!(*.d).ts")("src/app.ts")).toBe(true);
    expect(picomatch("**/!(*.d).ts")("src/app.d.ts")).toBe(false);

    const scanned = picomatch.scan("src/**/*.tsx");
    expect(scanned.isGlob).toBe(true);
    expect(scanned.base).toBe("src");
    expect(scanned.glob).toBe("**/*.tsx");
  });

  it("evaluates CVE-2026-112366 adversarial extglobs in linear time without backtracking hangs", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["+(*)", `${"a".repeat(32)}/`],
      ["*(*)", `${"a".repeat(32)}/`],
      ["+(**)", `${"a".repeat(32)}/`],
      ["+(*a)", `${"a".repeat(32)}b`],
      ["+(a*)", `${"a".repeat(32)}/`],
      ["+(a*b)", `${"ab".repeat(32)}c`],
      ["+(?*a)", `${"a".repeat(32)}b`],
      ["+(+(a)a)", `${"a".repeat(32)}b`],
      ["+(?(a)a)", `${"a".repeat(32)}b`],
      ["+()", "a"],
    ];

    const startedAt = performance.now();
    for (const [pattern, input] of cases) {
      const matcher = picomatch(pattern);
      expect(matcher(input)).toBe(false);
      expect(picomatch.makeRe(pattern)).toBeInstanceOf(RegExp);
    }
    const elapsedMs = performance.now() - startedAt;
    expect(elapsedMs).toBeLessThan(50);
  });
});
