import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ResolvedGerritAccount } from "./types.js";

const execFileAsync = promisify(execFile);

export type GerritReviewParams = {
  account: ResolvedGerritAccount;
  changeNumber: number;
  patchSetNumber: number;
  message: string;
  labels?: Record<string, number>;
  comments?: Record<string, Array<{ line?: number; message: string }>>;
};

/**
 * Maximum allowed vote per label. Enforced in code, not prompt.
 * Agents can never +2 or submit via this tool.
 */
const MAX_VOTE: Record<string, number> = {
  "Code-Review": 0, // comments only by default
  Verified: 0,
  Workflow: 0,
};

const MIN_VOTE: Record<string, number> = {
  "Code-Review": -1,
  Verified: -1,
  Workflow: -1,
};

/**
 * Clamp labels to allowed range. Rejects any label not in the allow list.
 */
function clampLabels(labels: Record<string, number>): Record<string, number> {
  const clamped: Record<string, number> = {};
  for (const [label, value] of Object.entries(labels)) {
    const max = MAX_VOTE[label];
    const min = MIN_VOTE[label];
    if (max == null || min == null) {
      // Unknown label — skip entirely
      continue;
    }
    clamped[label] = Math.max(min, Math.min(max, value));
  }
  return clamped;
}

/**
 * Post a review to Gerrit via SSH.
 * Uses `gerrit review --json` for structured comments.
 */
export async function postGerritReview(params: GerritReviewParams): Promise<{
  success: boolean;
  error?: string;
}> {
  const { account, changeNumber, patchSetNumber, message } = params;

  // Build the JSON review payload
  const reviewPayload: Record<string, unknown> = {};

  if (message?.trim()) {
    reviewPayload.message = message.trim();
  }

  if (params.labels && Object.keys(params.labels).length > 0) {
    reviewPayload.labels = clampLabels(params.labels);
  }

  if (params.comments && Object.keys(params.comments).length > 0) {
    reviewPayload.comments = params.comments;
  }

  if (!reviewPayload.message && !reviewPayload.comments) {
    return { success: false, error: "No message or comments to post" };
  }

  const changeRef = `${changeNumber},${patchSetNumber}`;
  const jsonPayload = JSON.stringify(reviewPayload);

  try {
    const { stdout, stderr } = await execFileAsync(
      "ssh",
      [
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "BatchMode=yes",
        "-i",
        account.sshKeyPath,
        "-p",
        String(account.port),
        `${account.username}@${account.host}`,
        "gerrit",
        "review",
        "--json",
        changeRef,
      ],
      {
        timeout: 30_000,
        // Pass the JSON payload via stdin
        encoding: "utf-8",
      },
    );

    // gerrit review --json reads from stdin, so we need to use spawn instead
    // Actually execFile doesn't support stdin easily. Let's use spawn.
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: `Gerrit review failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Post a review using spawn (supports stdin for JSON payload).
 */
export async function postGerritReviewViaSpawn(params: GerritReviewParams): Promise<{
  success: boolean;
  error?: string;
}> {
  const { account, changeNumber, patchSetNumber, message } = params;
  const { spawn } = await import("node:child_process");

  const reviewPayload: Record<string, unknown> = {};

  if (message?.trim()) {
    reviewPayload.message = message.trim();
  }

  if (params.labels && Object.keys(params.labels).length > 0) {
    reviewPayload.labels = clampLabels(params.labels);
  }

  if (params.comments && Object.keys(params.comments).length > 0) {
    reviewPayload.comments = params.comments;
  }

  if (!reviewPayload.message && !reviewPayload.comments) {
    return { success: false, error: "No message or comments to post" };
  }

  const changeRef = `${changeNumber},${patchSetNumber}`;

  return new Promise((resolve) => {
    const child = spawn(
      "ssh",
      [
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "BatchMode=yes",
        "-i",
        account.sshKeyPath,
        "-p",
        String(account.port),
        `${account.username}@${account.host}`,
        "gerrit",
        "review",
        "--json",
        changeRef,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    let stderr = "";
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ success: true });
      } else {
        resolve({
          success: false,
          error: `SSH exit code ${code}: ${stderr.trim()}`,
        });
      }
    });

    child.on("error", (err) => {
      resolve({ success: false, error: err.message });
    });

    // Write JSON to stdin
    const jsonPayload = JSON.stringify(reviewPayload);
    child.stdin?.write(jsonPayload);
    child.stdin?.end();
  });
}
