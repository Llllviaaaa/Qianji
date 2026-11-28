/**
 * Standard CLI & Official MCP Connector Bridge (`packages/host/src/bot/connectors/standard-cli-mcp.ts`).
 *
 * Adopts mature ecosystem CLIs and official MCP endpoints instead of custom browser scraping:
 * 1. Google Workspace Official CLI (`@googleworkspace/cli` / `gws mcp -s gmail|calendar|drive`)
 * 2. GitHub CLI (`gh auth token`) + Official GitHub Remote MCP (`https://api.githubcopilot.com/mcp/`)
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Credentials } from "@qianji/llm";
import type { McpServerConfig } from "@qianji/mcp";
import { fetchGitHubViewerLogin } from "./cloud-connectors.ts";

export type GoogleWorkspaceServiceId = "gmail" | "calendar" | "drive";

export const GWS_CLIENT_ID_KEY = "gws/client-id";
export const GWS_CLIENT_SECRET_KEY = "gws/secret";

export interface GwsProbeResult {
  readonly gwsInstalled: boolean;
  readonly npxAvailable: boolean;
  readonly hasClientConfig: boolean;
  readonly authenticated: boolean;
  readonly accountEmail?: string;
  readonly command: string;
  readonly baseArgs: string[];
}

interface ExecResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function execCommand(
  command: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const shell = process.platform === "win32" && (/\.(cmd|bat|ps1)$/i.test(command) || !/[\\/]/.test(command));
    const child = spawn(command, args, {
      env: options?.env ?? process.env,
      shell,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr });
    };
    const onAbort = () => {
      child.kill();
      finish(null);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, options?.timeoutMs ?? 8_000);
    timer.unref?.();
    options?.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.once("error", (err) => {
      stderr += err.message;
      finish(null);
    });
    child.once("close", (code) => finish(code));
  });
}

function resolveGwsConfigCandidates(): string[] {
  const home = homedir();
  const appData = process.env.APPDATA;
  const explicit = process.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR;
  return [
    ...(explicit ? [explicit] : []),
    join(home, ".config", "gws"),
    ...(appData ? [join(appData, "gws")] : []),
  ];
}

export async function readStoredGwsClientEnv(credentials?: Credentials): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  const cid = process.env.GOOGLE_WORKSPACE_CLI_CLIENT_ID || (await credentials?.get(GWS_CLIENT_ID_KEY).catch(() => undefined));
  const csec = process.env.GOOGLE_WORKSPACE_CLI_CLIENT_SECRET || (await credentials?.get(GWS_CLIENT_SECRET_KEY).catch(() => undefined));
  if (cid?.trim()) env.GOOGLE_WORKSPACE_CLI_CLIENT_ID = cid.trim();
  if (csec?.trim()) env.GOOGLE_WORKSPACE_CLI_CLIENT_SECRET = csec.trim();
  return env;
}

export async function saveGwsClientCredentials(
  credentials: Credentials | undefined,
  clientId?: string,
  clientSecret?: string,
): Promise<void> {
  if (!credentials?.writable) return;
  if (typeof clientId === "string" && clientId.trim() !== "") {
    await credentials.set(GWS_CLIENT_ID_KEY, clientId.trim()).catch(() => undefined);
  }
  if (typeof clientSecret === "string" && clientSecret.trim() !== "") {
    await credentials.set(GWS_CLIENT_SECRET_KEY, clientSecret.trim()).catch(() => undefined);
  }
}

export async function probeGwsCli(credentials?: Credentials): Promise<GwsProbeResult> {
  const clientEnv = await readStoredGwsClientEnv(credentials);
  const gwsVer = await execCommand("gws", ["--version"], { timeoutMs: 4_000 });
  const gwsInstalled = gwsVer.code === 0;
  const npxVer = gwsInstalled ? { code: 0 } : await execCommand("npx", ["--version"], { timeoutMs: 4_000 });
  const npxAvailable = npxVer.code === 0;

  const configDirs = resolveGwsConfigCandidates();
  const hasSecretFile =
    Boolean(process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE) ||
    configDirs.some((d) => existsSync(join(d, "client_secret.json")));
  const hasTokenFile = configDirs.some(
    (d) =>
      existsSync(join(d, "credentials.enc")) ||
      existsSync(join(d, "credentials.json")) ||
      existsSync(join(d, "token_cache.json")),
  );
  const hasClientConfig = Boolean(clientEnv.GOOGLE_WORKSPACE_CLI_CLIENT_ID) || hasSecretFile || hasTokenFile;

  const command = gwsInstalled ? "gws" : "npx";
  const baseArgs = gwsInstalled ? [] : ["-y", "@googleworkspace/cli"];

  let authenticated = false;
  let accountEmail: string | undefined;

  if (gwsInstalled || (npxAvailable && hasTokenFile)) {
    const authRes = await execCommand(command, [...baseArgs, "auth", "status"], {
      env: { ...process.env, ...clientEnv },
      timeoutMs: 8_000,
    });
    const combined = `${authRes.stdout}\n${authRes.stderr}`;
    try {
      const parsed = JSON.parse(authRes.stdout.trim()) as Record<string, unknown>;
      if (
        parsed.authenticated === true ||
        parsed.has_token === true ||
        parsed.token_valid === true ||
        typeof parsed.user === "string"
      ) {
        authenticated = true;
      }
      const userField = parsed.user ?? parsed.email ?? parsed.account;
      if (typeof userField === "string" && userField.includes("@")) {
        accountEmail = userField.trim();
      }
    } catch {
      if (/authenticated\s*:\s*true|valid|logged in/i.test(combined) && !/not authenticated|none|false/i.test(combined)) {
        authenticated = true;
      }
    }
    if (!accountEmail) {
      const m = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/.exec(combined);
      if (m?.[1]) accountEmail = m[1];
    }
  }

  return {
    gwsInstalled,
    npxAvailable,
    hasClientConfig,
    authenticated,
    ...(accountEmail ? { accountEmail } : {}),
    command,
    baseArgs,
  };
}

export function connectorToGwsService(connectorId: string): GoogleWorkspaceServiceId {
  if (connectorId === "calendar") return "calendar";
  if (connectorId === "google_drive") return "drive";
  return "gmail";
}

export function buildGwsStdioMcpConfig(
  connectorId: "gmail" | "calendar" | "google_drive",
  probe: Pick<GwsProbeResult, "command" | "baseArgs">,
  extraEnv: Record<string, string> = {},
): McpServerConfig {
  const service = connectorToGwsService(connectorId);
  const names: Record<"gmail" | "calendar" | "google_drive", string> = {
    gmail: "Gmail (Google Workspace MCP)",
    calendar: "Google Calendar (Google Workspace MCP)",
    google_drive: "Google Drive (Google Workspace MCP)",
  };
  return {
    id: `preset-mcp-${connectorId}`,
    name: names[connectorId],
    enabled: true,
    transport: "stdio",
    command: probe.command,
    args: [...probe.baseArgs, "mcp", "-s", service],
    cwd: "",
    env: extraEnv,
    inheritEnvironment: true,
    url: "",
    headers: {},
    trustedReadOnly: connectorId !== "gmail",
  };
}

export async function runGwsInteractiveLogin(options: {
  services: readonly GoogleWorkspaceServiceId[];
  credentials?: Credentials;
  clientId?: string;
  clientSecret?: string;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; accountEmail?: string; probe: GwsProbeResult }> {
  await saveGwsClientCredentials(options.credentials, options.clientId, options.clientSecret);
  const initialProbe = await probeGwsCli(options.credentials);
  if (!initialProbe.gwsInstalled && !initialProbe.npxAvailable) {
    throw new Error("未检测到 gws 或 Node.js npx 环境，请先安装 Node.js 或执行 npm i -g @googleworkspace/cli");
  }
  const clientEnv = await readStoredGwsClientEnv(options.credentials);
  if (!initialProbe.hasClientConfig && !clientEnv.GOOGLE_WORKSPACE_CLI_CLIENT_ID) {
    throw new Error(
      "首次通过官方 gws CLI 登录 Google，需要提供 Google Cloud OAuth Client ID/Secret（或改用免配置的 Remote MCP 网关）",
    );
  }

  const svcList = [...new Set(options.services)].join(",");
  const loginRes = await execCommand(
    initialProbe.command,
    [...initialProbe.baseArgs, "auth", "login", "-s", svcList],
    {
      env: { ...process.env, ...clientEnv },
      timeoutMs: 180_000,
      signal: options.signal,
    },
  );
  if (loginRes.code !== 0) {
    const detail = (loginRes.stderr || loginRes.stdout).trim().slice(0, 260);
    throw new Error(`Google 官方 CLI (gws) OAuth 登录未完成：${detail || `exit ${loginRes.code}`}`);
  }
  const updatedProbe = await probeGwsCli(options.credentials);
  return {
    ok: true,
    ...(updatedProbe.accountEmail ? { accountEmail: updatedProbe.accountEmail } : {}),
    probe: updatedProbe,
  };
}

export async function detectGitHubCliToken(): Promise<{ token: string; login?: string } | null> {
  const res = await execCommand("gh", ["auth", "token"], { timeoutMs: 4_000 });
  const token = res.stdout.trim();
  if (res.code !== 0 || !token) return null;
  const login = await fetchGitHubViewerLogin("https://api.github.com", token).catch(() => undefined);
  return { token, ...(login ? { login } : {}) };
}
