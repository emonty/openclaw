import type { PluginRuntime } from "openclaw/plugin-sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  CoreConfig,
  GerritStreamEvent,
  GerritCommentAddedEvent,
  ResolvedGerritAccount,
} from "./types.js";
import { formatGerritEvent, extractEventActor } from "./format.js";
import { matchesProject } from "./project-match.js";
import { postGerritReviewViaSpawn } from "./review.js";

export type GerritMonitorOpts = {
  account: ResolvedGerritAccount;
  runtime: PluginRuntime;
  abortSignal?: AbortSignal;
};

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
};

const INITIAL_RECONNECT_MS = 2_000;
const MAX_RECONNECT_MS = 60_000;

/**
 * Start monitoring Gerrit stream-events via SSH.
 * Reconnects automatically on disconnect with exponential backoff.
 */
export async function monitorGerritStreamEvents(opts: GerritMonitorOpts): Promise<void> {
  const { account, runtime, abortSignal } = opts;
  const logger = runtime.logging.getChildLogger({ module: `gerrit:${account.accountId}` });

  let reconnectMs = INITIAL_RECONNECT_MS;
  let child: ChildProcess | null = null;

  const cleanup = () => {
    if (child) {
      child.kill("SIGTERM");
      child = null;
    }
  };

  abortSignal?.addEventListener("abort", cleanup, { once: true });

  const connect = (): Promise<void> =>
    new Promise((resolve) => {
      if (abortSignal?.aborted) {
        resolve();
        return;
      }

      const sshArgs = [
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "ServerAliveInterval=30",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "BatchMode=yes",
        "-i",
        account.sshKeyPath,
        "-p",
        String(account.port),
        `${account.username}@${account.host}`,
        "gerrit",
        "stream-events",
      ];

      logger.info(`Connecting to ${account.host}:${account.port} as ${account.username}…`);
      child = spawn("ssh", sshArgs, { stdio: ["ignore", "pipe", "pipe"] });

      logger.info(
        `SSH spawned PID=${child.pid} stdout=${Boolean(child.stdout)} stderr=${Boolean(child.stderr)}`,
      );

      if (!child.stdout || !child.stderr) {
        logger.warn("SSH process has no stdout/stderr — stdio pipe failed");
        resolve();
        return;
      }

      const rl = createInterface({ input: child.stdout });

      rl.on("line", (line) => {
        try {
          const event = JSON.parse(line) as GerritStreamEvent;
          const project = event.change?.project ?? event.project ?? "(no project)";
          logger.info(`Event received: type=${event.type} project=${project}`);
          handleEvent(event, account, runtime, logger);
          // Reset backoff on successful event
          reconnectMs = INITIAL_RECONNECT_MS;
        } catch (err) {
          // Non-JSON line (SSH banner, etc.) — log if it looks interesting
          if (line.trim().length > 0) {
            logger.info(`Non-JSON line: ${line.slice(0, 100)}`);
          }
        }
      });

      child.stderr.on("data", (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) {
          logger.info(`ssh stderr: ${msg}`);
        }
      });

      child.on("close", (code) => {
        child = null;
        if (abortSignal?.aborted) {
          resolve();
          return;
        }
        logger.info(`SSH disconnected (code ${code}). Reconnecting in ${reconnectMs}ms…`);
        setTimeout(() => {
          reconnectMs = Math.min(reconnectMs * 2, MAX_RECONNECT_MS);
          connect().then(resolve);
        }, reconnectMs);
      });

      child.on("error", (err) => {
        logger.warn(`SSH error: ${err.message}`);
        child = null;
        if (abortSignal?.aborted) {
          resolve();
          return;
        }
        setTimeout(() => {
          reconnectMs = Math.min(reconnectMs * 2, MAX_RECONNECT_MS);
          connect().then(resolve);
        }, reconnectMs);
      });
    });

  await connect();
}

function handleEvent(
  event: GerritStreamEvent,
  account: ResolvedGerritAccount,
  runtime: PluginRuntime,
  logger: Logger,
): void {
  const project = event.change?.project;
  if (!project) return;

  // Filter: does this project match our watch list?
  // Safety: if no projects configured, reject all events (never watch everything)
  if (account.projects.length === 0 || !matchesProject(project, account.projects)) {
    return;
  }

  // Filter: is the actor in our allowlist?
  const actor = extractEventActor(event);

  // Never respond to our own events (prevents feedback loops)
  if (actor === account.username) {
    return;
  }

  const actorAllowed =
    account.allowFrom.length === 0 || (actor != null && account.allowFrom.includes(actor));

  // For comment-added: only dispatch if mentioned or negative vote
  if (event.type === "comment-added") {
    const commentEvent = event as GerritCommentAddedEvent;
    const hasNegativeVote = commentEvent.approvals?.some((a) => Number(a.value) < 0) ?? false;

    // Build mention names: username + configured extras
    const mentionNames = [account.username, ...account.mentionNames].map((n) => n.toLowerCase());
    const commentText = (commentEvent.comment ?? "").toLowerCase();
    const isMentioned = mentionNames.some((name) => commentText.includes(name));

    if (!hasNegativeVote && !isMentioned) {
      logger.info(
        `Gerrit comment on ${project} by ${actor ?? "unknown"} — no mention or negative vote, skipping`,
      );
      return;
    }
  }

  // Format the event
  const body = formatGerritEvent(event);
  if (!body) return;

  const cfg = runtime.config.loadConfig() as CoreConfig;

  // Resolve routing — use project as the "room" equivalent
  const route = runtime.channel.routing.resolveAgentRoute({
    cfg,
    channel: "gerrit",
    accountId: account.accountId,
    peer: { kind: "channel", id: `gerrit:${account.accountId}:${project}` },
    roomId: `gerrit:${project}`,
  });

  const changeNumber = event.change?.number;
  const patchSetNumber = (event as Record<string, unknown>).patchSet as
    | { number?: number }
    | undefined;
  const psNum = patchSetNumber?.number ?? 0;
  const messageId = `gerrit:${changeNumber ?? "unknown"}:${psNum}:${event.type}`;

  if (!actorAllowed) {
    // Log but don't trigger agent turn
    logger.info(
      `Gerrit event from ${actor ?? "unknown"} on ${project} — not in allowFrom, skipping`,
    );
    runtime.system.enqueueSystemEvent(
      `[Gerrit] ${event.type} on ${project} by ${actor ?? "unknown"} (not in allowFrom)`,
      { sessionKey: route.sessionKey, contextKey: `gerrit:${messageId}` },
    );
    return;
  }

  logger.info(`Gerrit ${event.type} on ${project} by ${actor ?? "unknown"} — dispatching`);

  // Build inbound context and dispatch
  const storePath = runtime.channel.session.resolveStorePath(
    (cfg as Record<string, unknown>).session as Record<string, unknown> | undefined,
    { agentId: route.agentId },
  );
  const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const formattedBody = runtime.channel.reply.formatAgentEnvelope({
    channel: "Gerrit",
    from: actor ?? "unknown",
    timestamp: event.eventCreatedOn ? event.eventCreatedOn * 1000 : undefined,
    envelope: envelopeOptions,
    body,
  });

  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: formattedBody,
    RawBody: body,
    CommandBody: body,
    From: `gerrit:${account.accountId}:${actor ?? "unknown"}`,
    To: `gerrit:${project}`,
    SessionKey: route.sessionKey,
    AccountId: account.accountId,
    ChatType: "channel" as const,
    ConversationLabel: `${project} (Gerrit)`,
    SenderName: actor ?? "unknown",
    SenderId: actor ?? "unknown",
    SenderUsername: actor,
    GroupSubject: project,
    GroupChannel: project,
    Provider: "gerrit" as const,
    Surface: "gerrit" as const,
    MessageSid: messageId,
    Timestamp: event.eventCreatedOn ? event.eventCreatedOn * 1000 : undefined,
    CommandAuthorized: true,
    CommandSource: "text" as const,
    OriginatingChannel: "gerrit" as const,
    OriginatingTo: `gerrit:${project}`,
  });

  // Record session
  runtime.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
  });

  // Extract patchset number for review posting
  const patchSetNum = (event as Record<string, unknown>).patchSet as
    | { number?: number }
    | undefined;
  const currentPatchSet = patchSetNum?.number ?? 1;

  // Dispatch reply
  const { dispatcher, replyOptions, markDispatchIdle } =
    runtime.channel.reply.createReplyDispatcherWithTyping({
      deliver: async (_payload) => {
        const text = String(_payload.text ?? "").trim();
        if (!text || !changeNumber) {
          logger.info(`[reply] Skipping empty reply or missing change number`);
          return;
        }

        logger.info(
          `[reply] Posting to Gerrit ${project} change ${changeNumber},${currentPatchSet}: ${text.slice(0, 100)}…`,
        );

        const result = await postGerritReviewViaSpawn({
          account,
          changeNumber,
          patchSetNumber: currentPatchSet,
          message: text,
        });

        if (result.success) {
          logger.info(`[reply] Posted review to ${changeNumber},${currentPatchSet}`);
        } else {
          logger.warn(`[reply] Failed to post review: ${result.error}`);
        }
      },
      onError: (err, info) => {
        logger.warn(`gerrit reply (${String(info.kind)}) failed: ${String(err)}`);
      },
    });

  runtime.channel.reply
    .dispatchReplyFromConfig({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions,
    })
    .then(() => {
      markDispatchIdle();
    })
    .catch((err: unknown) => {
      logger.warn(`gerrit dispatch failed: ${String(err)}`);
      markDispatchIdle();
    });
}
