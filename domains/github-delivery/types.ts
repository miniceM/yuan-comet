export type Workflow = 'classic' | 'native';
export type Action = 'issue:create' | 'issue:update' | 'push' | 'pull-request:create';
export interface AcceptanceItem {
  key: string;
  internalRef: string;
  source: string;
  sourceHash: string;
  text: string;
  revision: number;
  retired: boolean;
}
export interface ScopeInput {
  confirmation: string;
  items: Array<{
    key?: string;
    internalRef: string;
    source: string;
    text: string;
    retired?: boolean;
  }>;
  committedKeys?: string[];
}
export interface Evidence {
  key: string;
  revision: number;
  status: 'passed' | 'failed' | 'not-run';
  evidence: string[];
  reason: string;
}
export interface Verification {
  hash: string;
  head: string;
  manifest: string;
  items: Evidence[];
  carry?: { parent: string; diff: string; evidence: string };
}
export interface ReviewFinding {
  id: string;
  severity: 'critical' | 'important' | 'suggestion';
  resolved: boolean;
  text: string;
}
export interface Review {
  id: string;
  kind: 'full' | 'delta';
  parent: string | null;
  base: string;
  head: string;
  diff: string;
  manifest: string;
  verification: string;
  reviewer: string;
  builder: string;
  evidence: string;
  findings: ReviewFinding[];
  resolves?: string[];
}
export interface RemoteIssue {
  number: number;
  html_url: string;
  state: string;
  body: string | null;
  pull_request?: unknown;
}
export interface RemotePr extends RemoteIssue {
  merged_at: string | null;
  base: { ref: string; repo: { full_name: string } };
  head: { ref: string; sha: string; repo: { full_name: string } | null };
}
export interface Operation {
  id: string;
  kind: 'issue:create' | 'issue:update' | 'push' | 'pull-request:create' | 'pull-request:update';
  status: 'prepared' | 'completed' | 'uncertain' | 'failed';
  head: string;
  body: string;
  remoteRef?: number;
  resolution?: 'full' | 'partial';
}
export interface DeliveryRecord {
  schema: 'comet.github-delivery.v1';
  id: string;
  revision: number;
  binding: {
    repository: string;
    workflow: Workflow;
    change: string;
    base: string;
    head: string;
    remote: string;
    baseSha: string;
  };
  summary: {
    title: string;
    background: string;
    changes: string;
    impact: string;
    nonGoals: string;
    compatibility: string;
  };
  scope: {
    revision: number;
    confirmation: string;
    items: AcceptanceItem[];
    committedKeys: string[];
    hash: string;
  };
  issue: {
    number: number;
    url: string;
    state: string;
    scopeHash: string | null;
    bodyHash: string;
    scopeConfirmation?: string;
    confirmedBodyHash?: string;
  } | null;
  verifications: Verification[];
  reviews: Review[];
  grants: Array<{ action: Action; source: string; grantedAt: string; issueNumber: number | null }>;
  operations: Operation[];
  push: { sha: string; observedAt: string } | null;
  pr: {
    number: number;
    url: string;
    state: 'open' | 'merged' | 'closed-unmerged';
    /** Immutable HEAD covered by verification and review when PR creation was prepared. */
    sha: string;
    observedSha: string;
    drifted: boolean;
    driftReason: string | null;
    resolution: 'full' | 'partial';
  } | null;
  observedAt: string | null;
  issueClosure: 'pending' | 'closed' | 'not-applicable';
}
export interface BindInput {
  repository: string;
  workflow: Workflow;
  change: string;
  base: string;
  head: string;
  remote: string;
  summary: DeliveryRecord['summary'];
  scope: ScopeInput;
}
