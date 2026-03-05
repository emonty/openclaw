import type { OpenClawConfig } from "openclaw/plugin-sdk";

export type CoreConfig = OpenClawConfig & {
  channels?: {
    gerrit?: GerritChannelConfig;
  };
};

export type GerritChannelConfig = {
  accounts?: Record<string, GerritAccountConfig>;
};

export type GerritAccountConfig = {
  enabled?: boolean;
  host: string;
  port?: number;
  username: string;
  sshKeyPath?: string;
  /** Only events from these Gerrit usernames trigger agent turns. Default: [] (none). */
  allowFrom?: string[];
  /** Gerrit projects to watch. Supports glob patterns like "wandertracks/*". */
  projects?: string[];
};

export type ResolvedGerritAccount = {
  accountId: string;
  config: GerritAccountConfig;
  host: string;
  port: number;
  username: string;
  sshKeyPath: string;
  allowFrom: string[];
  projects: string[];
  enabled: boolean;
};

// Gerrit stream-events types

export type GerritStreamEvent =
  | GerritPatchsetCreatedEvent
  | GerritCommentAddedEvent
  | GerritChangeMergedEvent
  | GerritReviewerAddedEvent
  | GerritChangeAbandonedEvent;

export type GerritAccount = {
  name?: string;
  email?: string;
  username?: string;
};

export type GerritChange = {
  project: string;
  branch: string;
  id: string;
  number: number;
  subject: string;
  owner: GerritAccount;
  url: string;
  commitMessage?: string;
  status?: string;
};

export type GerritPatchSet = {
  number: number;
  revision: string;
  ref: string;
  uploader: GerritAccount;
  createdOn: number;
  author: GerritAccount;
  kind?: string;
  sizeInsertions?: number;
  sizeDeletions?: number;
};

export type GerritApproval = {
  type: string;
  description?: string;
  value: string;
  oldValue?: string;
  by?: GerritAccount;
};

export type GerritComment = {
  file?: string;
  line?: number;
  reviewer: GerritAccount;
  message: string;
};

export type GerritPatchsetCreatedEvent = {
  type: "patchset-created";
  change: GerritChange;
  patchSet: GerritPatchSet;
  uploader: GerritAccount;
  eventCreatedOn: number;
};

export type GerritCommentAddedEvent = {
  type: "comment-added";
  change: GerritChange;
  patchSet: GerritPatchSet;
  author: GerritAccount;
  approvals?: GerritApproval[];
  comment: string;
  eventCreatedOn: number;
};

export type GerritChangeMergedEvent = {
  type: "change-merged";
  change: GerritChange;
  patchSet: GerritPatchSet;
  submitter: GerritAccount;
  eventCreatedOn: number;
};

export type GerritReviewerAddedEvent = {
  type: "reviewer-added";
  change: GerritChange;
  patchSet: GerritPatchSet;
  reviewer: GerritAccount;
  eventCreatedOn: number;
};

export type GerritChangeAbandonedEvent = {
  type: "change-abandoned";
  change: GerritChange;
  patchSet: GerritPatchSet;
  abandoner: GerritAccount;
  reason?: string;
  eventCreatedOn: number;
};
