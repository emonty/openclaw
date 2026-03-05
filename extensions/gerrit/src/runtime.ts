import type { PluginRuntime } from "openclaw/plugin-sdk";

let _runtime: PluginRuntime | null = null;

export function setGerritRuntime(runtime: PluginRuntime): void {
  _runtime = runtime;
}

export function getGerritRuntime(): PluginRuntime {
  if (!_runtime) {
    throw new Error("Gerrit runtime not initialized — register plugin first.");
  }
  return _runtime;
}
