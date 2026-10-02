export type ComponentStatus = 'draft' | 'review' | 'published';
export type PreviewTheme = 'light' | 'dark';
export type PreviewDensity = 'compact' | 'regular' | 'spacious';

/** 三个责任小组 */
export type TeamId = 'spec' | 'a11y' | 'platform';

/** 可归属的编辑区：组件、属性、无障碍说明、示例 */
export type SectionKey = 'component' | 'properties' | 'accessibility' | 'examples';

export interface SectionOwners {
  component: TeamId;
  properties: TeamId;
  accessibility: TeamId;
  examples: TeamId;
}

export interface PropertySpec {
  id: string;
  name: string;
  type: string;
  required: boolean;
  defaultValue: string;
  description: string;
}

export interface ComponentExample {
  id: string;
  title: string;
  code: string;
  propertyIds: string[];
  stale: boolean;
  staleReason: string;
  createdFromRevision: number;
}

export interface ComponentSpec {
  id: string;
  name: string;
  category: string;
  status: ComponentStatus;
  purpose: string;
  usage: string;
  properties: PropertySpec[];
  states: string;
  keyboardBehavior: string;
  screenReader: string;
  disabledScenarios: string;
  interactionSignature: string;
  examples: ComponentExample[];
  revision: number;
  updatedAt: string;
  /** 各编辑区的责任组；旧数据缺失时补默认归属 */
  owners: SectionOwners;
  /** 跨组改动形成的待审修订；发布前组件内容保持不变 */
  pendingRevision: PendingRevision | null;
  snapshots: ComponentSnapshot[];
}

/** 组件内容（不含快照与待审修订），即修订草稿与快照承载的部分 */
export type ComponentContent = Omit<ComponentSpec, 'snapshots' | 'pendingRevision'>;

export interface ComponentSnapshot {
  revision: number;
  savedAt: string;
  reason: string;
  component: ComponentContent;
}

/** 一次小组确认，与当时的属性契约哈希绑定；契约更新即失效 */
export interface Confirmation {
  team: TeamId;
  at: string;
  contractHash: string;
}

export interface RevisionChange {
  section: SectionKey;
  field: string;
  before: string;
  after: string;
}

/** 待审修订：跨组改动的草稿，需两个责任组确认后才能发布 */
export interface PendingRevision {
  id: string;
  proposer: TeamId;
  createdAt: string;
  updatedAt: string;
  /** 发起时组件的修订号，用于检测基线漂移 */
  baseRevision: number;
  /** 草稿当前的属性契约哈希；确认以其为准 */
  contractHash: string;
  /** 需要确认的责任组（发起组 + 涉及区的责任组，至少两个） */
  requiredTeams: TeamId[];
  changes: RevisionChange[];
  confirmations: Confirmation[];
  draft: ComponentContent;
}

export type AuditAction =
  | 'propose'
  | 'confirm'
  | 'invalidate'
  | 'publish'
  | 'discard'
  | 'direct-edit'
  | 'rollback'
  | 'migrate-owner';

export interface AuditEntry {
  id: string;
  at: string;
  team: TeamId | 'system';
  action: AuditAction;
  componentId: string;
  componentName: string;
  detail: string;
}

export interface WorkspaceState {
  components: ComponentSpec[];
  selectedId: string;
  currentTeam: TeamId;
  auditLog: AuditEntry[];
}

export interface ValidationIssue {
  id: string;
  level: 'error' | 'warning' | 'info';
  componentId: string;
  target: string;
  message: string;
  field: 'properties' | 'examples' | 'keyboard' | 'screenReader';
}

export interface DiffRow {
  field: string;
  before: string;
  after: string;
}
