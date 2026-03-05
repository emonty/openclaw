import type { OpenClawConfig } from "openclaw/plugin-sdk";
import os from "node:os";
import path from "node:path";
import type { CoreConfig, GerritAccountConfig, ResolvedGerritAccount } from "./types.js";

function resolveGerritSection(cfg: OpenClawConfig): Record<string, GerritAccountConfig> {
  const core = cfg as CoreConfig;
  return core.channels?.gerrit?.accounts ?? {};
}

export function listGerritAccountIds(cfg: OpenClawConfig): string[] {
  return Object.keys(resolveGerritSection(cfg));
}

export function resolveGerritAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedGerritAccount {
  const accounts = resolveGerritSection(cfg);
  const id = accountId ?? Object.keys(accounts)[0] ?? "default";
  const raw = accounts[id];

  if (!raw) {
    return {
      accountId: id,
      config: { host: "", username: "" },
      host: "",
      port: 29418,
      username: "",
      sshKeyPath: path.join(os.homedir(), ".ssh", "id_ed25519"),
      allowFrom: [],
      projects: [],
      enabled: false,
    };
  }

  return {
    accountId: id,
    config: raw,
    host: raw.host,
    port: raw.port ?? 29418,
    username: raw.username,
    sshKeyPath: raw.sshKeyPath ?? path.join(os.homedir(), ".ssh", "id_ed25519"),
    allowFrom: raw.allowFrom ?? [],
    projects: raw.projects ?? [],
    enabled: raw.enabled !== false,
  };
}

export function defaultGerritAccountId(cfg: OpenClawConfig): string {
  const ids = listGerritAccountIds(cfg);
  return ids[0] ?? "default";
}
