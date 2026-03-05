import type {
  GerritStreamEvent,
  GerritAccount,
  GerritChange,
  GerritPatchSet,
  GerritApproval,
  GerritCommentAddedEvent,
  GerritPatchsetCreatedEvent,
  GerritChangeMergedEvent,
  GerritChangeAbandonedEvent,
} from "./types.js";

function fmtUser(account: GerritAccount): string {
  if (account.name && account.username) {
    return `${account.name} (${account.username})`;
  }
  return account.name ?? account.username ?? account.email ?? "unknown";
}

function fmtChange(change: GerritChange, patchSet: GerritPatchSet): string {
  return `${change.project} — Change ${change.number} (PS${patchSet.number})`;
}

function fmtApprovals(approvals: GerritApproval[]): string {
  return approvals
    .map((a) => {
      const val = Number(a.value);
      const sign = val > 0 ? `+${val}` : `${val}`;
      return `${a.description ?? a.type}: ${sign}`;
    })
    .join(", ");
}

export function formatPatchsetCreated(event: GerritPatchsetCreatedEvent): string {
  const { change, patchSet } = event;
  const lines = [
    `[Gerrit] New patchset: ${fmtChange(change, patchSet)}`,
    `Subject: ${change.subject}`,
    `Author: ${fmtUser(patchSet.uploader)}`,
    `Branch: ${change.branch}`,
    `URL: ${change.url}`,
  ];
  if (patchSet.sizeInsertions != null || patchSet.sizeDeletions != null) {
    lines.push(`Size: +${patchSet.sizeInsertions ?? 0}, -${patchSet.sizeDeletions ?? 0}`);
  }
  if (change.commitMessage) {
    const msg = change.commitMessage.trim();
    // Show first ~500 chars of commit message
    const preview = msg.length > 500 ? `${msg.slice(0, 500)}…` : msg;
    lines.push("", "Commit message:", preview);
  }
  return lines.join("\n");
}

export function formatCommentAdded(event: GerritCommentAddedEvent): string {
  const { change, patchSet, author, approvals, comment } = event;
  const lines = [
    `[Gerrit] Review on ${fmtChange(change, patchSet)}`,
    `Subject: ${change.subject}`,
    `Reviewer: ${fmtUser(author)}`,
  ];
  if (approvals && approvals.length > 0) {
    lines.push(`Votes: ${fmtApprovals(approvals)}`);
  }
  if (comment) {
    lines.push("", comment.trim());
  }
  return lines.join("\n");
}

export function formatChangeMerged(event: GerritChangeMergedEvent): string {
  const { change, patchSet, submitter } = event;
  return [
    `[Gerrit] Merged: ${fmtChange(change, patchSet)}`,
    `Subject: ${change.subject}`,
    `Submitter: ${fmtUser(submitter)}`,
    `URL: ${change.url}`,
  ].join("\n");
}

export function formatChangeAbandoned(event: GerritChangeAbandonedEvent): string {
  const { change, patchSet, abandoner, reason } = event;
  const lines = [
    `[Gerrit] Abandoned: ${fmtChange(change, patchSet)}`,
    `Subject: ${change.subject}`,
    `By: ${fmtUser(abandoner)}`,
  ];
  if (reason) {
    lines.push(`Reason: ${reason}`);
  }
  return lines.join("\n");
}

export function formatGerritEvent(event: GerritStreamEvent): string | null {
  switch (event.type) {
    case "patchset-created":
      return formatPatchsetCreated(event);
    case "comment-added":
      return formatCommentAdded(event);
    case "change-merged":
      return formatChangeMerged(event);
    case "change-abandoned":
      return formatChangeAbandoned(event);
    case "reviewer-added":
      // Low noise — skip unless we want this later
      return null;
    default:
      return null;
  }
}

/**
 * Extract the Gerrit username from the event's "actor" (the person who caused the event).
 */
export function extractEventActor(event: GerritStreamEvent): string | undefined {
  switch (event.type) {
    case "patchset-created":
      return event.uploader?.username;
    case "comment-added":
      return event.author?.username;
    case "change-merged":
      return event.submitter?.username;
    case "change-abandoned":
      return event.abandoner?.username;
    case "reviewer-added":
      return event.reviewer?.username;
    default:
      return undefined;
  }
}
