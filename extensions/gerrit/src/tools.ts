import { Type } from "@sinclair/typebox";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { ResolvedGerritAccount } from "./types.js";
import { postGerritReviewViaSpawn } from "./review.js";

const execFileAsync = promisify(execFile);

type AgentToolResult = {
  content: Array<{ type: string; text: string }>;
  details?: unknown;
};

function text(msg: string): AgentToolResult {
  return { content: [{ type: "text", text: msg }] };
}

function json(payload: unknown): AgentToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

// ---------- SSH helpers ----------

function sshArgs(account: ResolvedGerritAccount): string[] {
  return [
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "BatchMode=yes",
    "-i",
    account.sshKeyPath,
    "-p",
    String(account.port),
    `${account.username}@${account.host}`,
  ];
}

function restUrl(account: ResolvedGerritAccount, path: string): string {
  // OpenDev Gerrit REST API — public endpoint (no auth needed for reads)
  return `https://${account.host}/${path.replace(/^\//, "")}`;
}

async function gerritRest(account: ResolvedGerritAccount, path: string): Promise<string> {
  // Gerrit REST responses have a )]}' prefix for XSSI protection
  const url = restUrl(account, path);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Gerrit REST ${res.status}: ${await res.text()}`);
  }
  const body = await res.text();
  // Strip XSSI prefix
  return body.replace(/^\)\]\}'\n/, "");
}

// ---------- Tool schemas ----------

const ACTIONS = ["fetch_diff", "fetch_file", "fetch_change", "inline_comment", "review"] as const;

function stringEnum<T extends readonly string[]>(
  values: T,
  options: { description?: string } = {},
) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    ...options,
  });
}

export const GerritToolSchema = Type.Object(
  {
    action: stringEnum(ACTIONS, {
      description: [
        "Action to perform:",
        "  fetch_diff — Get the diff for a change/patchset",
        "  fetch_file — Get file content at a specific revision",
        "  fetch_change — Get change details (status, labels, messages)",
        "  inline_comment — Post an inline comment on a specific file/line",
        "  review — Post a top-level review comment",
      ].join("\n"),
    }),
    change: Type.Optional(Type.Number({ description: "Gerrit change number (e.g. 979001)" })),
    patchset: Type.Optional(Type.Number({ description: "Patchset number (defaults to latest)" })),
    file: Type.Optional(
      Type.String({ description: "File path (for fetch_file or inline_comment)" }),
    ),
    line: Type.Optional(Type.Number({ description: "Line number for inline_comment" })),
    message: Type.Optional(
      Type.String({ description: "Comment text (for review or inline_comment)" }),
    ),
    labels: Type.Optional(
      Type.Object(
        {
          "Code-Review": Type.Optional(
            Type.Number({
              description: "Code-Review vote: +1 (looks good) or -1 (needs work). Never +2.",
            }),
          ),
        },
        {
          description: "Vote labels to set (only Code-Review ±1 allowed)",
          additionalProperties: false,
        },
      ),
    ),
  },
  { additionalProperties: false },
);

type ToolParams = {
  action: (typeof ACTIONS)[number];
  change?: number;
  patchset?: number;
  file?: string;
  line?: number;
  message?: string;
  labels?: { "Code-Review"?: number };
};

// ---------- Tool implementation ----------

const _accounts = new Map<string, ResolvedGerritAccount>();
let _defaultAccountId: string | null = null;

export function registerGerritToolAccount(account: ResolvedGerritAccount): void {
  _accounts.set(account.accountId, account);
  if (!_defaultAccountId) {
    _defaultAccountId = account.accountId;
  }
}

// Keep old API for compat
export function setGerritToolAccount(account: ResolvedGerritAccount): void {
  registerGerritToolAccount(account);
}

function getAccount(): ResolvedGerritAccount {
  if (_accounts.size === 0) {
    throw new Error("Gerrit tool not configured — no account available");
  }
  // Return first/default account
  return _accounts.get(_defaultAccountId!)!;
}

export async function executeGerritTool(
  _toolCallId: string,
  params: ToolParams,
  _signal?: AbortSignal,
  _onUpdate?: unknown,
): Promise<AgentToolResult> {
  const account = getAccount();

  try {
    switch (params.action) {
      case "fetch_diff":
        return await fetchDiff(account, params);
      case "fetch_file":
        return await fetchFile(account, params);
      case "fetch_change":
        return await fetchChange(account, params);
      case "inline_comment":
        return await inlineComment(account, params);
      case "review":
        return await postReview(account, params);
      default:
        return text(`Unknown action: ${params.action}`);
    }
  } catch (err) {
    return text(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------- Actions ----------

async function fetchDiff(
  account: ResolvedGerritAccount,
  params: ToolParams,
): Promise<AgentToolResult> {
  if (!params.change) {
    return text("Missing required parameter: change");
  }

  const revision = params.patchset ? String(params.patchset) : "current";
  const path = `changes/${params.change}/revisions/${revision}/patch`;

  const raw = await gerritRest(account, path);
  // Patch is base64 encoded
  const decoded = Buffer.from(raw.trim(), "base64").toString("utf-8");

  // Truncate very large diffs
  const maxLen = 50_000;
  if (decoded.length > maxLen) {
    return text(
      `Diff for change ${params.change} PS${revision} (truncated to ${maxLen} chars):\n\n${decoded.slice(0, maxLen)}\n\n… (${decoded.length - maxLen} chars truncated)`,
    );
  }

  return text(`Diff for change ${params.change} PS${revision}:\n\n${decoded}`);
}

async function fetchFile(
  account: ResolvedGerritAccount,
  params: ToolParams,
): Promise<AgentToolResult> {
  if (!params.change) {
    return text("Missing required parameter: change");
  }
  if (!params.file) {
    return text("Missing required parameter: file");
  }

  const revision = params.patchset ? String(params.patchset) : "current";
  const encodedFile = encodeURIComponent(params.file);
  const path = `changes/${params.change}/revisions/${revision}/files/${encodedFile}/content`;

  const raw = await gerritRest(account, path);
  // File content is base64 encoded
  const decoded = Buffer.from(raw.trim(), "base64").toString("utf-8");

  const maxLen = 50_000;
  if (decoded.length > maxLen) {
    return text(
      `${params.file} (change ${params.change} PS${revision}, truncated):\n\n${decoded.slice(0, maxLen)}\n\n… (${decoded.length - maxLen} chars truncated)`,
    );
  }

  return text(`${params.file} (change ${params.change} PS${revision}):\n\n${decoded}`);
}

async function fetchChange(
  account: ResolvedGerritAccount,
  params: ToolParams,
): Promise<AgentToolResult> {
  if (!params.change) {
    return text("Missing required parameter: change");
  }

  const path = `changes/${params.change}/detail`;
  const raw = await gerritRest(account, path);
  const data = JSON.parse(raw);

  // Extract useful fields
  const summary = {
    project: data.project,
    branch: data.branch,
    subject: data.subject,
    status: data.status,
    owner: data.owner?.name ?? data.owner?.username,
    created: data.created,
    updated: data.updated,
    url: `https://${account.host}/c/${data.project}/+/${params.change}`,
    current_revision: data.current_revision,
    labels: Object.fromEntries(
      Object.entries(data.labels ?? {}).map(([k, v]: [string, unknown]) => {
        const label = v as Record<string, unknown>;
        return [
          k,
          {
            approved: (label.approved as Record<string, unknown>)?.name,
            rejected: (label.rejected as Record<string, unknown>)?.name,
            value: label.value,
          },
        ];
      }),
    ),
    messages: (data.messages ?? []).slice(-10).map((m: Record<string, unknown>) => ({
      author: (m.author as Record<string, unknown>)?.name,
      date: m.date,
      message: String(m.message ?? "").slice(0, 500),
    })),
  };

  return json(summary);
}

async function inlineComment(
  account: ResolvedGerritAccount,
  params: ToolParams,
): Promise<AgentToolResult> {
  if (!params.change) return text("Missing required parameter: change");
  if (!params.file) return text("Missing required parameter: file");
  if (!params.message) return text("Missing required parameter: message");

  const patchset = params.patchset ?? 1;

  const result = await postGerritReviewViaSpawn({
    account,
    changeNumber: params.change,
    patchSetNumber: patchset,
    message: "",
    comments: {
      [params.file]: [
        {
          ...(params.line != null ? { line: params.line } : {}),
          message: params.message,
        },
      ],
    },
  });

  if (result.success) {
    const location = params.line != null ? `${params.file}:${params.line}` : params.file;
    return text(`Inline comment posted on ${location} (change ${params.change},${patchset})`);
  }
  return text(`Failed to post inline comment: ${result.error}`);
}

async function postReview(
  account: ResolvedGerritAccount,
  params: ToolParams,
): Promise<AgentToolResult> {
  if (!params.change) return text("Missing required parameter: change");
  if (!params.message) return text("Missing required parameter: message");

  const patchset = params.patchset ?? 1;

  const result = await postGerritReviewViaSpawn({
    account,
    changeNumber: params.change,
    patchSetNumber: patchset,
    message: params.message,
    labels: params.labels as Record<string, number> | undefined,
  });

  if (result.success) {
    const voteStr =
      params.labels?.["Code-Review"] != null
        ? ` (Code-Review ${params.labels["Code-Review"] > 0 ? "+" : ""}${params.labels["Code-Review"]})`
        : "";
    return text(`Review posted on change ${params.change},${patchset}${voteStr}`);
  }
  return text(`Failed to post review: ${result.error}`);
}
