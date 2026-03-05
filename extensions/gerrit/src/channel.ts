import type { ChannelPlugin } from "openclaw/plugin-sdk";
import type { ResolvedGerritAccount } from "./types.js";
import { defaultGerritAccountId, listGerritAccountIds, resolveGerritAccount } from "./accounts.js";
import { monitorGerritStreamEvents } from "./monitor.js";
import { getGerritRuntime } from "./runtime.js";

export const gerritPlugin: ChannelPlugin<ResolvedGerritAccount> = {
  id: "gerrit",
  meta: {
    id: "gerrit",
    label: "Gerrit",
    selectionLabel: "Gerrit (code review)",
    docsPath: "/channels/gerrit",
    docsLabel: "gerrit",
    blurb: "Gerrit code review via SSH stream-events.",
    order: 90,
  },
  capabilities: {
    chatTypes: ["channel"],
  },
  config: {
    listAccountIds: listGerritAccountIds,
    resolveAccount: resolveGerritAccount,
    defaultAccountId: defaultGerritAccountId,
    isEnabled: (account) => account.enabled,
    isConfigured: (account) => Boolean(account.host && account.username),
    unconfiguredReason: (account) => {
      if (!account.host) return "Missing host";
      if (!account.username) return "Missing username";
      return "Unknown";
    },
    describeAccount: (account) => ({
      accountId: account.accountId,
      baseUrl: `ssh://${account.username}@${account.host}:${account.port}`,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        baseUrl: `ssh://${account.username}@${account.host}:${account.port}`,
      });
      ctx.log?.info(
        `[${account.accountId}] starting Gerrit stream-events (${account.host}:${account.port})`,
      );
      return monitorGerritStreamEvents({
        account,
        runtime: getGerritRuntime(),
        abortSignal: ctx.abortSignal,
      });
    },
  },
};

export const gerritDock = {
  capabilities: {
    chatTypes: ["channel"],
  },
};
