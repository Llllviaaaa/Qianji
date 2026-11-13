import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileSecretStore, type SecretCodec } from "../src/secrets.ts";

const xorCodec: SecretCodec = {
  protect: (plaintext) => Buffer.from(plaintext.map((b) => b ^ 0x5a)),
  unprotect: (protectedData) => Buffer.from(protectedData.map((b) => b ^ 0x5a)),
};

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("fileSecretStore", () => {
  it("writes, reads, deletes, and serializes concurrent updates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qj-secrets-test-"));
    dirs.push(dir);
    const file = join(dir, "secrets.dat");
    const store = fileSecretStore(file, xorCodec);

    await Promise.all([
      store.set?.("im/feishu", "secret-a"),
      store.set?.("im/dingtalk", "secret-b"),
      store.set?.("im/qq", "secret-c"),
    ]);

    expect(await store.resolve("im/feishu")).toBe("secret-a");
    expect(await store.resolve("im/dingtalk")).toBe("secret-b");
    expect(await store.resolve("im/qq")).toBe("secret-c");

    expect(await store.delete?.("im/dingtalk")).toBe(true);
    expect(await store.delete?.("im/dingtalk")).toBe(false);
    expect(await store.resolve("im/dingtalk")).toBeUndefined();
    expect(await store.resolve("im/feishu")).toBe("secret-a");
    expect(await store.resolve("im/qq")).toBe("secret-c");
  });
});
