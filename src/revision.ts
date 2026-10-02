import type {
  ComponentContent,
  ComponentSpec,
  Confirmation,
  PendingRevision,
  RevisionChange,
  SectionKey,
  SectionOwners,
  TeamId
} from './types';

export const TEAM_LABELS: Record<TeamId, string> = {
  spec: '规范组',
  a11y: '无障碍组',
  platform: '平台组'
};

export const SECTION_LABELS: Record<SectionKey, string> = {
  component: '组件',
  properties: '属性',
  accessibility: '无障碍说明',
  examples: '示例'
};

/** 默认责任归属：组件→规范组，属性→平台组，无障碍说明→无障碍组，示例→平台组 */
export const DEFAULT_OWNERS: SectionOwners = {
  component: 'spec',
  properties: 'platform',
  accessibility: 'a11y',
  examples: 'platform'
};

export const FIELD_SECTION: Record<string, SectionKey> = {
  name: 'component',
  category: 'component',
  purpose: 'component',
  usage: 'component',
  states: 'component',
  status: 'component',
  properties: 'properties',
  interactionSignature: 'properties',
  keyboardBehavior: 'accessibility',
  screenReader: 'accessibility',
  disabledScenarios: 'accessibility',
  examples: 'examples'
};

export const FIELD_LABELS: Record<string, string> = {
  name: '组件名称',
  category: '分类',
  purpose: '用途',
  usage: '使用规则',
  states: '状态说明',
  status: '组件状态',
  properties: '属性契约',
  interactionSignature: '交互签名',
  keyboardBehavior: '键盘行为',
  screenReader: '读屏说明',
  disabledScenarios: '禁用场景',
  examples: '关联示例'
};

export const sectionOfField = (field: string): SectionKey => FIELD_SECTION[field] ?? 'component';

export const fieldLabel = (field: string): string => FIELD_LABELS[field] ?? field;

/** 属性契约 = 属性的 name/type/required/defaultValue + 交互签名；描述性文字不参与 */
const contractSource = (content: Pick<ComponentContent, 'properties' | 'interactionSignature'>) =>
  JSON.stringify({
    properties: content.properties.map((item) => [item.name, item.type, item.required, item.defaultValue]),
    interactionSignature: content.interactionSignature
  });

/** 稳定的短哈希（djb2），用于把确认绑定到契约版本 */
export const contractHashOf = (content: Pick<ComponentContent, 'properties' | 'interactionSignature'>): string => {
  const source = contractSource(content);
  let hash = 5381;
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) + hash + source.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

const formatValue = (value: unknown): string => {
  if (Array.isArray(value)) return value.map((item) => JSON.stringify(item)).join('\n');
  return String(value ?? '');
};

const SCALAR_FIELDS = [
  'name',
  'category',
  'status',
  'purpose',
  'usage',
  'states',
  'keyboardBehavior',
  'screenReader',
  'disabledScenarios',
  'interactionSignature'
] as const;

/** 计算基线内容与草稿之间的字段级差异 */
export function diffContent(base: ComponentContent, draft: ComponentContent): RevisionChange[] {
  const changes: RevisionChange[] = [];
  for (const field of SCALAR_FIELDS) {
    const before = formatValue(base[field]);
    const after = formatValue(draft[field]);
    if (before !== after) changes.push({ section: sectionOfField(field), field, before, after });
  }
  for (const field of ['properties', 'examples'] as const) {
    const before = formatValue(base[field]);
    const after = formatValue(draft[field]);
    if (before !== after) changes.push({ section: sectionOfField(field), field, before, after });
  }
  return changes;
}

const unique = <T>(values: T[]): T[] => [...new Set(values)];

/** 需要确认的责任组：发起组 + 涉及编辑区的责任组，至少两个 */
export function requiredTeamsFor(proposer: TeamId, changes: RevisionChange[], owners: SectionOwners): TeamId[] {
  const teams = unique([proposer, ...changes.map((change) => owners[change.section])]);
  return teams;
}

/** 当前仍有效的确认：与草稿最新契约哈希一致 */
export function validConfirmations(revision: PendingRevision): Confirmation[] {
  return revision.confirmations.filter((item) => item.contractHash === revision.contractHash);
}

/** 发布条件：有实际改动、所需责任组全部有效确认、且有效确认覆盖至少两个责任组 */
export function canPublish(revision: PendingRevision): boolean {
  if (!revision.changes.length) return false;
  const confirmed = new Set(validConfirmations(revision).map((item) => item.team));
  if (confirmed.size < 2) return false;
  return revision.requiredTeams.every((team) => confirmed.has(team));
}

const uid = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

export const contentOf = (component: ComponentSpec): ComponentContent => {
  const { snapshots: _snapshots, pendingRevision: _pendingRevision, ...content } = component;
  return structuredClone(content);
};

/** 基于组件当前内容创建待审修订，发起组即时确认当前契约 */
export function createRevision(component: ComponentSpec, proposer: TeamId): PendingRevision {
  const draft = contentOf(component);
  const now = new Date().toISOString();
  const contractHash = contractHashOf(draft);
  return {
    id: uid('revision'),
    proposer,
    createdAt: now,
    updatedAt: now,
    baseRevision: component.revision,
    contractHash,
    requiredTeams: [proposer],
    changes: [],
    confirmations: [{ team: proposer, at: now, contractHash }],
    draft
  };
}

export interface SyncResult {
  /** 因契约更新而失效的其他责任组 */
  invalidatedTeams: TeamId[];
  contractChanged: boolean;
}

/**
 * 重算修订：差异、契约哈希、所需确认组。
 * 属性契约一旦更新，已有确认立即失效；发起组视为认可自己刚提交的内容，
 * 其确认按新哈希重记，其余责任组必须重新确认。契约变化时草稿内的依赖示例
 * 全部标记失效，不沿用旧结论。
 */
export function syncRevision(revision: PendingRevision, component: ComponentSpec): SyncResult {
  const nextHash = contractHashOf(revision.draft);
  const contractChanged = nextHash !== revision.contractHash;
  let invalidatedTeams: TeamId[] = [];
  if (contractChanged) {
    invalidatedTeams = unique(revision.confirmations.map((item) => item.team)).filter((team) => team !== revision.proposer);
    const now = new Date().toISOString();
    revision.confirmations = [{ team: revision.proposer, at: now, contractHash: nextHash }];
    revision.contractHash = nextHash;
    revision.draft.examples.forEach((example) => {
      example.stale = true;
      example.staleReason = '属性契约已更新，示例不能沿用旧结论，需要重新验证。';
    });
  }
  revision.changes = diffContent(contentOf(component), revision.draft);
  revision.requiredTeams = requiredTeamsFor(revision.proposer, revision.changes, component.owners);
  revision.updatedAt = new Date().toISOString();
  return { invalidatedTeams, contractChanged };
}
