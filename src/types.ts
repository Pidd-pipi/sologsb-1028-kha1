export type ComponentStatus = 'draft' | 'review' | 'published';
export type PreviewTheme = 'light' | 'dark';
export type PreviewDensity = 'compact' | 'regular' | 'spacious';

export type GroupId = 'specs' | 'platform' | 'a11y';

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
  /** 组件内容的责任组；旧数据缺省在加载时补默认归属。 */
  ownerGroup: GroupId;
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
  snapshots: ComponentSnapshot[];
}

export interface ComponentSnapshot {
  revision: number;
  savedAt: string;
  reason: string;
  component: Omit<ComponentSpec, 'snapshots'>;
}

export interface RevisionConfirmation {
  group: GroupId;
  member: string;
  at: string;
}

export type RevisionStatus = 'pending' | 'published' | 'rejected';

/** 跨组改动不直接生效，进入待审修订；责任组与提报组共同确认后才能发布。 */
export interface PendingRevision {
  id: string;
  componentId: string;
  proposerGroup: GroupId;
  proposer: string;
  reason: string;
  changedFields: string[];
  patch: Partial<ComponentSpec>;
  confirmations: RevisionConfirmation[];
  status: RevisionStatus;
  createdAt: string;
  publishedAt?: string;
  /** 契约修订：发布后其他待审契约修订的确认立即失效、需重新确认。 */
  contractTouched: boolean;
}

export interface WorkspaceState {
  components: ComponentSpec[];
  selectedId: string;
  currentGroup: GroupId;
  currentMember: string;
  pendingRevisions: PendingRevision[];
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
