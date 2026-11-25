import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateToolPermission, insideWorkspace, rulesFromConfig } from "../src/index.ts";

let rootDir = "";
let workspaceDir = "";
let outsideDir = "";

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "qianji-perm-symlink-"));
  workspaceDir = join(rootDir, "workspace");
  outsideDir = join(rootDir, "outside-secret");
  mkdirSync(join(workspaceDir, "packages", "real-pkg"), { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(outsideDir, "credentials.txt"), "top-secret", "utf8");
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

describe("insideWorkspace symlink & junction containment", () => {
  it("rejects directory junctions/symlinks inside workspace that point outside workspace (including missing trailing segments)", () => {
    const linkDir = join(workspaceDir, "escaped-dir");
    symlinkSync(outsideDir, linkDir, process.platform === "win32" ? "junction" : "dir");

    // Existing file via escaped symlink/junction
    expect(insideWorkspace("escaped-dir/credentials.txt", workspaceDir)).toBe(false);
    // Brand-new nested subdirectories/files under escaped symlink/junction
    expect(insideWorkspace("escaped-dir/new-sub/created.txt", workspaceDir)).toBe(false);
    // Absolute path through escaped symlink/junction
    expect(insideWorkspace(join(linkDir, "deep", "payload.json"), workspaceDir)).toBe(false);

    // evaluateToolPermission blocks workspace-write writes through the escaped link
    const decision = evaluateToolPermission({
      mode: "workspace-write",
      rules: rulesFromConfig({}),
      workspace: workspaceDir,
      toolName: "write",
      input: { path: "escaped-dir/new-sub/created.txt", content: "pwned" },
    });
    expect(decision).toMatchObject({ action: "block" });
  });

  it("allows internal junctions/symlinks whose resolved target stays inside workspace", () => {
    const internalLink = join(workspaceDir, "packages", "current");
    symlinkSync(
      join(workspaceDir, "packages", "real-pkg"),
      internalLink,
      process.platform === "win32" ? "junction" : "dir",
    );

    expect(insideWorkspace("packages/current/index.ts", workspaceDir)).toBe(true);
    expect(insideWorkspace("packages/current/sub/new-file.ts", workspaceDir)).toBe(true);
    expect(insideWorkspace("src/brand-new/file.ts", workspaceDir)).toBe(true);
  });

  it("rejects file symlinks (including dangling symlinks) pointing outside workspace when privileges allow file symlinks", () => {
    const danglingLink = join(workspaceDir, "dangling-escape.txt");
    try {
      symlinkSync(join(outsideDir, "not-created-yet.txt"), danglingLink, "file");
    } catch (error) {
      // Unprivileged Windows without Developer Mode may disallow file symlinks (EPERM); directory junctions above always run.
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    expect(insideWorkspace("dangling-escape.txt", workspaceDir)).toBe(false);
  });
});
