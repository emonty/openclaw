import fs from "node:fs/promises";
import path from "node:path";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { ensureAuthProfileStore } from "../agents/auth-profiles.js";
import { resolveAuthStorePath } from "../agents/auth-profiles/paths.js";
import { type OpenClawConfig, writeConfigFile } from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import {
  applyAgentBindings,
  buildChannelBindings,
  describeBinding,
  parseBindingSpecs,
} from "./agents.bindings.js";
import { createQuietRuntime, requireValidConfig } from "./agents.command-shared.js";
import { applyAgentConfig, findAgentEntryIndex, listAgentEntries } from "./agents.config.js";
import { promptAuthChoiceGrouped } from "./auth-choice-prompt.js";
import { applyAuthChoice, warnIfModelConfigLooksOff } from "./auth-choice.js";
import { setupChannels } from "./onboard-channels.js";
import { ensureWorkspaceAndSessions } from "./onboard-helpers.js";
import type { ChannelChoice } from "./onboard-types.js";

type AgentsAddOptions = {
  name?: string;
  workspace?: string;
  model?: string;
  agentDir?: string;
  bind?: string[];
  room?: string;
  from?: string;
  nonInteractive?: boolean;
  json?: boolean;
};

/** Workspace files to copy when using --from to fork an existing agent. */
const WORKSPACE_TEMPLATE_FILES = [
  "SOUL.md",
  "USER.md",
  "TOOLS.md",
  "IDENTITY.md",
  "MEMORY.md",
  "HEARTBEAT.md",
];

/**
 * Copy workspace template files from a source agent's workspace.
 * Only copies files that exist in the source and don't yet exist in the target.
 */
async function copyWorkspaceTemplateFiles(
  sourceWorkspace: string,
  targetWorkspace: string,
  runtime: RuntimeEnv,
): Promise<string[]> {
  const copied: string[] = [];
  await fs.mkdir(targetWorkspace, { recursive: true });
  for (const file of WORKSPACE_TEMPLATE_FILES) {
    const src = path.join(sourceWorkspace, file);
    const dest = path.join(targetWorkspace, file);
    try {
      await fs.access(src);
      try {
        await fs.access(dest);
        // Target already exists, skip
      } catch {
        await fs.copyFile(src, dest);
        copied.push(file);
      }
    } catch {
      // Source file doesn't exist, skip
    }
  }
  // Also copy memory/ directory if it exists
  const srcMemory = path.join(sourceWorkspace, "memory");
  const destMemory = path.join(targetWorkspace, "memory");
  try {
    const stat = await fs.stat(srcMemory);
    if (stat.isDirectory()) {
      try {
        await fs.access(destMemory);
      } catch {
        await fs.cp(srcMemory, destMemory, { recursive: true });
        copied.push("memory/");
      }
    }
  } catch {
    // No memory dir, skip
  }
  return copied;
}

/**
 * Find the Matrix account config for a given accountId (or first available).
 * Returns homeserver, accessToken, encryption flag, and invite targets.
 */
function findMatrixAccount(
  cfg: OpenClawConfig,
  accountId: string | undefined,
): {
  homeserver: string;
  accessToken: string;
  encryption: boolean;
  inviteTargets: string[];
  accountKey: string;
} | null {
  const matrixConfig = (cfg as Record<string, unknown>).channels as
    | Record<string, unknown>
    | undefined;
  const matrixChannel = matrixConfig?.matrix as Record<string, unknown> | undefined;
  const accounts = matrixChannel?.accounts as
    | Record<string, Record<string, unknown>>
    | undefined;

  const accountKeys = accountId ? [accountId] : [];
  if (accounts) {
    for (const key of Object.keys(accounts)) {
      if (!accountKeys.includes(key)) {
        accountKeys.push(key);
      }
    }
  }

  for (const key of accountKeys) {
    const account = accounts?.[key];
    if (!account) continue;
    const homeserver = (account.homeserver ?? account.homeserverUrl) as string | undefined;
    const accessToken = account.accessToken as string | undefined;
    if (!homeserver || !accessToken) continue;

    const encryption = Boolean(account.encryption);
    // Collect invite targets from autoJoinAllowlist and dm.allowFrom
    const inviteTargets: string[] = [];
    const autoJoinAllowlist = account.autoJoinAllowlist as string[] | undefined;
    const dm = account.dm as Record<string, unknown> | undefined;
    const dmAllowFrom = dm?.allowFrom as string[] | undefined;
    for (const list of [autoJoinAllowlist, dmAllowFrom]) {
      if (Array.isArray(list)) {
        for (const entry of list) {
          if (typeof entry === "string" && entry.startsWith("@") && !inviteTargets.includes(entry)) {
            inviteTargets.push(entry);
          }
        }
      }
    }

    return { homeserver, accessToken, encryption, inviteTargets, accountKey: key };
  }
  return null;
}

/**
 * Resolve a Matrix room alias (#name:server) to an internal room ID (!abc:server).
 * If the alias doesn't exist, creates a new private room with that alias.
 * If the account has encryption enabled, the room will be encrypted.
 */
async function resolveMatrixRoomAlias(
  alias: string,
  cfg: OpenClawConfig,
  accountId: string | undefined,
  runtime: RuntimeEnv,
): Promise<string> {
  if (!alias.startsWith("#")) {
    return alias; // Already an internal ID or not an alias
  }

  const account = findMatrixAccount(cfg, accountId);
  if (!account) {
    runtime.error(`No Matrix account found to resolve room alias "${alias}". Using as-is.`);
    return alias;
  }

  const { homeserver, accessToken } = account;
  const headers = { Authorization: `Bearer ${accessToken}` };

  // Try to resolve existing alias
  const encodedAlias = encodeURIComponent(alias);
  const resolveUrl = `${homeserver}/_matrix/client/v3/directory/room/${encodedAlias}`;
  try {
    const res = await fetch(resolveUrl, { headers });
    if (res.ok) {
      const data = (await res.json()) as { room_id?: string };
      if (data.room_id) {
        runtime.log(`Resolved ${alias} → ${data.room_id}`);
        return data.room_id;
      }
    }
  } catch {
    // Resolution failed, we'll try to create
  }

  // Alias doesn't exist — create the room
  runtime.log(`Room "${alias}" not found. Creating private room…`);

  // Parse alias to extract local part and server for room_alias_name
  // #agent-foo:waterwanders.com → room_alias_name: "agent-foo"
  const aliasMatch = alias.match(/^#([^:]+):(.+)$/);
  const roomAliasName = aliasMatch?.[1];
  const roomName = roomAliasName ?? alias;

  // Build initial_state for encryption if needed
  const initialState: Array<Record<string, unknown>> = [];
  if (account.encryption) {
    initialState.push({
      type: "m.room.encryption",
      state_key: "",
      content: { algorithm: "m.megolm.v1.aes-sha2" },
    });
  }

  const createBody: Record<string, unknown> = {
    visibility: "private",
    preset: "private_chat",
    name: roomName,
    ...(roomAliasName ? { room_alias_name: roomAliasName } : {}),
    invite: account.inviteTargets,
    initial_state: initialState,
  };

  try {
    const createRes = await fetch(`${homeserver}/_matrix/client/v3/createRoom`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(createBody),
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      runtime.error(`Failed to create room "${alias}": ${errText}`);
      return alias;
    }

    const createData = (await createRes.json()) as { room_id?: string };
    if (createData.room_id) {
      const features = [
        "private",
        ...(account.encryption ? ["encrypted"] : []),
        ...(account.inviteTargets.length > 0
          ? [`invited: ${account.inviteTargets.join(", ")}`]
          : []),
      ];
      runtime.log(`Created room ${alias} → ${createData.room_id} (${features.join(", ")})`);
      return createData.room_id;
    }

    runtime.error(`Room creation for "${alias}" returned no room_id.`);
    return alias;
  } catch (err) {
    runtime.error(`Error creating room "${alias}": ${err}`);
    return alias;
  }
}

/**
 * Initialize a git repository in the workspace and push to the same remote
 * as the source agent's workspace, on a branch named after the new agent.
 */
async function initWorkspaceGit(
  workspaceDir: string,
  sourceWorkspace: string,
  agentId: string,
  runtime: RuntimeEnv,
): Promise<{ branch: string; remote: string } | null> {
  const { execSync } = await import("node:child_process");
  const run = (cmd: string, cwd: string) =>
    execSync(cmd, { cwd, encoding: "utf-8", stdio: "pipe" }).trim();

  // Check if source workspace has a git remote
  let remoteUrl: string;
  try {
    remoteUrl = run("git remote get-url origin", sourceWorkspace);
  } catch {
    return null; // Source has no git remote
  }

  // Check if target already has git with a remote configured
  let alreadyHasGit = false;
  try {
    run("git rev-parse --git-dir", workspaceDir);
    alreadyHasGit = true;
    // Check if it already has an origin remote
    try {
      run("git remote get-url origin", workspaceDir);
      return null; // Already fully set up
    } catch {
      // Has git but no origin — we'll add the remote
    }
  } catch {
    // Not a git repo yet
  }

  const branch = `agent-${agentId}`;
  try {
    if (!alreadyHasGit) {
      run("git init", workspaceDir);
    }
    run(`git remote add origin ${remoteUrl}`, workspaceDir);
    run(`git checkout -b ${branch}`, workspaceDir);
    run("git add -A", workspaceDir);
    run('git commit -m "Initial workspace for agent ' + agentId + '"', workspaceDir);
    try {
      run(`git push -u origin ${branch}`, workspaceDir);
    } catch {
      // Push may fail if no SSH key etc — non-fatal
      runtime.log(`Note: git push failed for branch ${branch} — you can push manually later.`);
    }
    return { branch, remote: remoteUrl };
  } catch {
    return null;
  }
}

async function fileExists(pathname: string): Promise<boolean> {
  try {
    await fs.stat(pathname);
    return true;
  } catch {
    return false;
  }
}

export async function agentsAddCommand(
  opts: AgentsAddOptions,
  runtime: RuntimeEnv = defaultRuntime,
  params?: { hasFlags?: boolean },
) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) {
    return;
  }

  const workspaceFlag = opts.workspace?.trim();
  const nameInput = opts.name?.trim();
  const hasFlags = params?.hasFlags === true;
  const nonInteractive = Boolean(opts.nonInteractive || hasFlags);

  if (nonInteractive && !workspaceFlag) {
    runtime.error(
      "Non-interactive mode requires --workspace. Re-run without flags to use the wizard.",
    );
    runtime.exit(1);
    return;
  }

  if (nonInteractive) {
    if (!nameInput) {
      runtime.error("Agent name is required in non-interactive mode.");
      runtime.exit(1);
      return;
    }
    if (!workspaceFlag) {
      runtime.error(
        "Non-interactive mode requires --workspace. Re-run without flags to use the wizard.",
      );
      runtime.exit(1);
      return;
    }
    const agentId = normalizeAgentId(nameInput);
    if (agentId === DEFAULT_AGENT_ID) {
      runtime.error(`"${DEFAULT_AGENT_ID}" is reserved. Choose another name.`);
      runtime.exit(1);
      return;
    }
    if (agentId !== nameInput) {
      runtime.log(`Normalized agent id to "${agentId}".`);
    }
    if (findAgentEntryIndex(listAgentEntries(cfg), agentId) >= 0) {
      runtime.error(`Agent "${agentId}" already exists.`);
      runtime.exit(1);
      return;
    }

    const workspaceDir = resolveUserPath(workspaceFlag);
    const agentDir = opts.agentDir?.trim()
      ? resolveUserPath(opts.agentDir.trim())
      : resolveAgentDir(cfg, agentId);
    const model = opts.model?.trim();
    const nextConfig = applyAgentConfig(cfg, {
      agentId,
      name: nameInput,
      workspace: workspaceDir,
      agentDir,
      ...(model ? { model } : {}),
    });

    // Resolve Matrix room alias (#name:server) to internal ID (!abc:server)
    let roomId = opts.room?.trim();
    if (roomId && roomId.startsWith("#")) {
      // Extract accountId from first --bind spec if it has one (e.g. "matrix:coder" → "coder")
      const firstBind = opts.bind?.[0];
      const bindAccountId = firstBind?.includes(":") ? firstBind.split(":")[1] : undefined;
      roomId = await resolveMatrixRoomAlias(roomId, nextConfig, bindAccountId, runtime);
    }

    const bindingParse = parseBindingSpecs({
      agentId,
      specs: opts.bind,
      config: nextConfig,
      roomId,
    });
    if (bindingParse.errors.length > 0) {
      runtime.error(bindingParse.errors.join("\n"));
      runtime.exit(1);
      return;
    }
    const bindingResult =
      bindingParse.bindings.length > 0
        ? applyAgentBindings(nextConfig, bindingParse.bindings)
        : { config: nextConfig, added: [], updated: [], skipped: [], conflicts: [] };

    await writeConfigFile(bindingResult.config);
    if (!opts.json) {
      logConfigUpdated(runtime);
    }
    const quietRuntime = opts.json ? createQuietRuntime(runtime) : runtime;
    await ensureWorkspaceAndSessions(workspaceDir, quietRuntime, {
      skipBootstrap: Boolean(bindingResult.config.agents?.defaults?.skipBootstrap),
      agentId,
    });

    // --from: copy workspace template files from source agent
    const fromAgent = opts.from?.trim();
    let copiedFiles: string[] = [];
    let gitResult: { branch: string; remote: string } | null = null;
    if (fromAgent) {
      const fromAgentId = normalizeAgentId(fromAgent);
      const fromEntry = listAgentEntries(bindingResult.config).find(
        (a) => normalizeAgentId(a.id) === fromAgentId,
      );
      if (!fromEntry) {
        runtime.error(`Source agent "${fromAgent}" not found.`);
      } else {
        const sourceWorkspace = fromEntry.workspace
          ? resolveUserPath(fromEntry.workspace)
          : resolveAgentWorkspaceDir(bindingResult.config, fromAgentId);
        copiedFiles = await copyWorkspaceTemplateFiles(sourceWorkspace, workspaceDir, runtime);
        if (copiedFiles.length > 0 && !opts.json) {
          runtime.log(`Copied from ${fromAgentId}: ${copiedFiles.join(", ")}`);
        }
        // Also copy auth profiles from source agent
        const sourceAgentDir = resolveAgentDir(bindingResult.config, fromAgentId);
        const sourceAuthPath = resolveAuthStorePath(sourceAgentDir);
        const destAuthPath = resolveAuthStorePath(agentDir);
        if (await fileExists(sourceAuthPath)) {
          await fs.mkdir(path.dirname(destAuthPath), { recursive: true });
          await fs.copyFile(sourceAuthPath, destAuthPath);
          if (!opts.json) {
            runtime.log(`Copied auth profiles from ${fromAgentId}.`);
          }
        }
        // Initialize git with branch named after the agent
        gitResult = await initWorkspaceGit(workspaceDir, sourceWorkspace, agentId, runtime);
        if (gitResult && !opts.json) {
          runtime.log(`Git initialized: branch ${gitResult.branch} → ${gitResult.remote}`);
        }
      }
    }

    const payload = {
      agentId,
      name: nameInput,
      workspace: workspaceDir,
      agentDir,
      model,
      bindings: {
        added: bindingResult.added.map(describeBinding),
        updated: bindingResult.updated.map(describeBinding),
        skipped: bindingResult.skipped.map(describeBinding),
        conflicts: bindingResult.conflicts.map(
          (conflict) => `${describeBinding(conflict.binding)} (agent=${conflict.existingAgentId})`,
        ),
      },
    };
    if (opts.json) {
      runtime.log(JSON.stringify(payload, null, 2));
    } else {
      runtime.log(`Agent: ${agentId}`);
      runtime.log(`Workspace: ${shortenHomePath(workspaceDir)}`);
      runtime.log(`Agent dir: ${shortenHomePath(agentDir)}`);
      if (model) {
        runtime.log(`Model: ${model}`);
      }
      if (bindingResult.conflicts.length > 0) {
        runtime.error(
          [
            "Skipped bindings already claimed by another agent:",
            ...bindingResult.conflicts.map(
              (conflict) =>
                `- ${describeBinding(conflict.binding)} (agent=${conflict.existingAgentId})`,
            ),
          ].join("\n"),
        );
      }
    }
    return;
  }

  const prompter = createClackPrompter();
  try {
    await prompter.intro("Add OpenClaw agent");
    const name =
      nameInput ??
      (await prompter.text({
        message: "Agent name",
        validate: (value) => {
          if (!value?.trim()) {
            return "Required";
          }
          const normalized = normalizeAgentId(value);
          if (normalized === DEFAULT_AGENT_ID) {
            return `"${DEFAULT_AGENT_ID}" is reserved. Choose another name.`;
          }
          return undefined;
        },
      }));

    const agentName = String(name ?? "").trim();
    const agentId = normalizeAgentId(agentName);
    if (agentName !== agentId) {
      await prompter.note(`Normalized id to "${agentId}".`, "Agent id");
    }

    const existingAgent = listAgentEntries(cfg).find(
      (agent) => normalizeAgentId(agent.id) === agentId,
    );
    if (existingAgent) {
      const shouldUpdate = await prompter.confirm({
        message: `Agent "${agentId}" already exists. Update it?`,
        initialValue: false,
      });
      if (!shouldUpdate) {
        await prompter.outro("No changes made.");
        return;
      }
    }

    const workspaceDefault = resolveAgentWorkspaceDir(cfg, agentId);
    const workspaceInput = await prompter.text({
      message: "Workspace directory",
      initialValue: workspaceDefault,
      validate: (value) => (value?.trim() ? undefined : "Required"),
    });
    const workspaceDir = resolveUserPath(String(workspaceInput ?? "").trim() || workspaceDefault);
    const agentDir = resolveAgentDir(cfg, agentId);

    let nextConfig = applyAgentConfig(cfg, {
      agentId,
      name: agentName,
      workspace: workspaceDir,
      agentDir,
    });

    const defaultAgentId = resolveDefaultAgentId(cfg);
    if (defaultAgentId !== agentId) {
      const sourceAuthPath = resolveAuthStorePath(resolveAgentDir(cfg, defaultAgentId));
      const destAuthPath = resolveAuthStorePath(agentDir);
      const sameAuthPath =
        path.resolve(sourceAuthPath).toLowerCase() === path.resolve(destAuthPath).toLowerCase();
      if (
        !sameAuthPath &&
        (await fileExists(sourceAuthPath)) &&
        !(await fileExists(destAuthPath))
      ) {
        const shouldCopy = await prompter.confirm({
          message: `Copy auth profiles from "${defaultAgentId}"?`,
          initialValue: false,
        });
        if (shouldCopy) {
          await fs.mkdir(path.dirname(destAuthPath), { recursive: true });
          await fs.copyFile(sourceAuthPath, destAuthPath);
          await prompter.note(`Copied auth profiles from "${defaultAgentId}".`, "Auth profiles");
        }
      }
    }

    const wantsAuth = await prompter.confirm({
      message: "Configure model/auth for this agent now?",
      initialValue: false,
    });
    if (wantsAuth) {
      const authStore = ensureAuthProfileStore(agentDir, {
        allowKeychainPrompt: false,
      });
      const authChoice = await promptAuthChoiceGrouped({
        prompter,
        store: authStore,
        includeSkip: true,
      });

      const authResult = await applyAuthChoice({
        authChoice,
        config: nextConfig,
        prompter,
        runtime,
        agentDir,
        setDefaultModel: false,
        agentId,
      });
      nextConfig = authResult.config;
      if (authResult.agentModelOverride) {
        nextConfig = applyAgentConfig(nextConfig, {
          agentId,
          model: authResult.agentModelOverride,
        });
      }
    }

    await warnIfModelConfigLooksOff(nextConfig, prompter, {
      agentId,
      agentDir,
    });

    let selection: ChannelChoice[] = [];
    const channelAccountIds: Partial<Record<ChannelChoice, string>> = {};
    nextConfig = await setupChannels(nextConfig, runtime, prompter, {
      allowSignalInstall: true,
      onSelection: (value) => {
        selection = value;
      },
      promptAccountIds: true,
      onAccountId: (channel, accountId) => {
        channelAccountIds[channel] = accountId;
      },
    });

    if (selection.length > 0) {
      const wantsBindings = await prompter.confirm({
        message: "Route selected channels to this agent now? (bindings)",
        initialValue: false,
      });
      if (wantsBindings) {
        const desiredBindings = buildChannelBindings({
          agentId,
          selection,
          config: nextConfig,
          accountIds: channelAccountIds,
        });
        const result = applyAgentBindings(nextConfig, desiredBindings);
        nextConfig = result.config;
        if (result.conflicts.length > 0) {
          await prompter.note(
            [
              "Skipped bindings already claimed by another agent:",
              ...result.conflicts.map(
                (conflict) =>
                  `- ${describeBinding(conflict.binding)} (agent=${conflict.existingAgentId})`,
              ),
            ].join("\n"),
            "Routing bindings",
          );
        }
      } else {
        await prompter.note(
          [
            "Routing unchanged. Add bindings when you're ready.",
            "Docs: https://docs.openclaw.ai/concepts/multi-agent",
          ].join("\n"),
          "Routing",
        );
      }
    }

    await writeConfigFile(nextConfig);
    logConfigUpdated(runtime);
    await ensureWorkspaceAndSessions(workspaceDir, runtime, {
      skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
      agentId,
    });

    const payload = {
      agentId,
      name: agentName,
      workspace: workspaceDir,
      agentDir,
    };
    if (opts.json) {
      runtime.log(JSON.stringify(payload, null, 2));
    }
    await prompter.outro(`Agent "${agentId}" ready.`);
  } catch (err) {
    if (err instanceof WizardCancelledError) {
      runtime.exit(1);
      return;
    }
    throw err;
  }
}
