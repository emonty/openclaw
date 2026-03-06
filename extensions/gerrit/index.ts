import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { resolveGerritAccount, listGerritAccountIds } from "./src/accounts.js";
import { gerritPlugin, gerritDock } from "./src/channel.js";
import { setGerritRuntime } from "./src/runtime.js";
import { GerritToolSchema, executeGerritTool, registerGerritToolAccount } from "./src/tools.js";

const plugin = {
  id: "gerrit",
  name: "Gerrit",
  description: "OpenClaw Gerrit code review channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setGerritRuntime(api.runtime);
    api.registerChannel({ plugin: gerritPlugin, dock: gerritDock });

    // Register all enabled Gerrit accounts for the tool
    for (const accountId of listGerritAccountIds(api.config)) {
      const account = resolveGerritAccount(api.config, accountId);
      if (account.enabled && account.host) {
        registerGerritToolAccount(account);
      }
    }

    // Register agent tool
    api.registerTool({
      name: "gerrit",
      label: "Gerrit Code Review",
      description: [
        "Interact with Gerrit code review. Actions:",
        "- fetch_diff: Get the full diff for a change (specify change number, optionally patchset)",
        "- fetch_file: Get file content at a revision (specify change, file path, optionally patchset)",
        "- fetch_change: Get change details — status, labels, recent messages",
        "- inline_comment: Post an inline comment on a specific file and line",
        "- review: Post a top-level review comment on a change, optionally with Code-Review +1/-1 vote",
      ].join("\n"),
      parameters: GerritToolSchema,
      execute: executeGerritTool,
    } as AnyAgentTool);
  },
};

export default plugin;
