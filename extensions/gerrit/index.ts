import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { gerritPlugin, gerritDock } from "./src/channel.js";
import { setGerritRuntime } from "./src/runtime.js";

const plugin = {
  id: "gerrit",
  name: "Gerrit",
  description: "OpenClaw Gerrit code review channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setGerritRuntime(api.runtime);
    api.registerChannel({ plugin: gerritPlugin, dock: gerritDock });
  },
};

export default plugin;
