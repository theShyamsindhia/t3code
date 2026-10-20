import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const AgentSessionSource = Schema.Literals(["claudeAgent", "codex"]);
export type AgentSessionSource = typeof AgentSessionSource.Type;

export const AgentSessionImportSource = Schema.Struct({
  provider: AgentSessionSource,
  providerInstanceId: ProviderInstanceId,
  providerSessionId: TrimmedNonEmptyString,
  filePath: TrimmedNonEmptyString,
  size: NonNegativeInt,
  mtimeMs: Schema.NullOr(Schema.Number),
  device: Schema.Number,
  // A decimal string keeps file IDs above 2^53 (common on NTFS) exact. Older
  // records stored a number.
  inode: Schema.NullOr(Schema.Union([Schema.String, Schema.Number])),
  birthtimeMs: Schema.NullOr(Schema.Number),
});
export type AgentSessionImportSource = typeof AgentSessionImportSource.Type;

export const AgentSessionScanInput = Schema.Struct({});
export type AgentSessionScanInput = typeof AgentSessionScanInput.Type;

export const AgentSessionProjectGit = Schema.Struct({
  remoteKey: Schema.NullOr(Schema.String),
  repository: Schema.NullOr(Schema.String),
});
export type AgentSessionProjectGit = typeof AgentSessionProjectGit.Type;

export const AgentSessionProjectCandidate = Schema.Struct({
  path: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  projectId: Schema.optional(ProjectId),
  sources: Schema.Array(AgentSessionSource),
  threadCount: NonNegativeInt,
  lastActiveAt: Schema.NullOr(IsoDateTime),
  alreadyImported: Schema.Boolean,
  git: Schema.optionalKey(Schema.NullOr(AgentSessionProjectGit)),
});
export type AgentSessionProjectCandidate = typeof AgentSessionProjectCandidate.Type;

export const AgentSessionScanResult = Schema.Struct({
  candidates: Schema.Array(AgentSessionProjectCandidate),
  scannedAt: IsoDateTime,
  truncated: Schema.optional(Schema.Boolean),
});
export type AgentSessionScanResult = typeof AgentSessionScanResult.Type;

export const AgentSessionImportInput = Schema.Struct({
  projectId: ProjectId,
  expectedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
  takeOverThreadId: Schema.optional(ThreadId),
});
export type AgentSessionImportInput = typeof AgentSessionImportInput.Type;

export class AgentSessionImportProjectNotFoundError extends Schema.TaggedError<AgentSessionImportProjectNotFoundError>()(
  "AgentSessionImportProjectNotFoundError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project '${this.projectId}' does not exist.`;
  }
}

export class AgentSessionImportProjectChangedError extends Schema.TaggedError<AgentSessionImportProjectChangedError>()(
  "AgentSessionImportProjectChangedError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project '${this.projectId}' changed directories. Scan for projects again before importing history.`;
  }
}

export const AgentSessionImportResult = Schema.Struct({
  importedCount: NonNegativeInt,
  skippedCount: NonNegativeInt,
  threadId: Schema.optional(ThreadId),
});
export type AgentSessionImportResult = typeof AgentSessionImportResult.Type;

export class AgentSessionScanError extends Schema.TaggedError<AgentSessionScanError>()(
  "AgentSessionScanError",
  {
    operation: Schema.Literals(["read-settings", "read-projects"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to scan agent sessions during ${this.operation}.`;
  }
}

/** External mirrors never own a provider session; their source remains the only writer. */
export function externalSessionSource(threadId: string): "Codex" | "Claude Code" | null {
  if (threadId.startsWith("external:codex:")) return "Codex";
  if (threadId.startsWith("external:claudeAgent:")) return "Claude Code";
  return null;
}

export function externalSessionIdentity(threadId: string) {
  const parts = threadId.split(":");
  if (
    parts.length !== 4 ||
    parts[0] !== "external" ||
    (parts[1] !== "codex" && parts[1] !== "claudeAgent") ||
    !parts[2] ||
    !parts[3]
  )
    return null;
  try {
    return {
      provider: parts[1],
      providerInstanceId: ProviderInstanceId.make(decodeURIComponent(parts[2])),
      providerSessionId: decodeURIComponent(parts[3]),
    };
  } catch {
    return null;
  }
}

export class AgentSessionTakeoverError extends Schema.TaggedError<AgentSessionTakeoverError>()(
  "AgentSessionTakeoverError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export const ExternalSessionCandidate = Schema.Struct({
  workspaceRoot: Schema.String,
  threadId: ThreadId,
  projectId: ProjectId,
  projectTitle: Schema.String,
  title: Schema.String,
  source: AgentSessionSource,
  updatedAt: IsoDateTime,
  tracked: Schema.Boolean,
});
export type ExternalSessionCandidate = typeof ExternalSessionCandidate.Type;

export const ExternalSessionsInput = Schema.Struct({
  threadIds: Schema.optional(Schema.Array(ThreadId)),
});
export const ExternalSessionsResult = Schema.Struct({
  candidates: Schema.Array(ExternalSessionCandidate),
});
export class ExternalSessionsError extends Schema.TaggedError<ExternalSessionsError>()(
  "ExternalSessionsError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
