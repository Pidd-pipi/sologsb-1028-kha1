import { createInitialState } from './data';
import {
  canPublish,
  contractHashOf,
  contentOf,
  createRevision,
  DEFAULT_OWNERS,
  fieldLabel,
  sectionOfField,
  syncRevision,
  TEAM_LABELS,
  validConfirmations
} from './revision';
import type {
  AuditAction,
  ComponentContent,
  ComponentSpec,
  ComponentSnapshot,
  PendingRevision,
  TeamId,
  ValidationIssue,
  WorkspaceState
} from './types';

const STORAGE_KEY = 'sologsb-1028-workspace-v1';
const AUDIT_LIMIT = 60;

const clone = <T>(value: T): T => structuredClone(value);
const uid = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

/** 业务规则失败；auditable 表示需要写入留痕（如发布被校验拦截） */
export class StoreError extends Error {
  constructor(message: string, readonly auditable = false) {
    super(message);
  }
}

const validateComponent = (component: ComponentContent): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];
  const names = new Map<string, number>();
  component.properties.forEach((property) => names.set(property.name.trim(), (names.get(property.name.trim()) ?? 0) + 1));
  for (const [name, count] of names) {
    if (name && count > 1) {
      issues.push({ id: `${component.id}-duplicate-${name}`, level: 'error', componentId: component.id, target: component.name, message: `属性名称 ${name} 重复。`, field: 'properties' });
    }
  }
  const contractChanged = component.examples.some((example) => example.createdFromRevision < component.revision);
  component.examples.forEach((example) => {
    const missingReferences = example.propertyIds.filter((id) => !component.properties.some((property) => property.id === id));
    if (example.stale || missingReferences.length) {
      issues.push({ id: `${component.id}-${example.id}-stale`, level: 'warning', componentId: component.id, target: example.title, message: example.staleReason || '示例引用了已删除属性。', field: 'examples' });
    }
    if (!example.code.trim()) {
      issues.push({ id: `${component.id}-${example.id}-empty`, level: 'error', componentId: component.id, target: example.title, message: '示例代码不能为空。', field: 'examples' });
    }
  });
  if (!component.keyboardBehavior.trim()) {
    issues.push({ id: `${component.id}-keyboard`, level: 'error', componentId: component.id, target: component.name, message: '缺少键盘行为说明。', field: 'keyboard' });
  }
  if (!component.screenReader.trim()) {
    issues.push({ id: `${component.id}-screenreader`, level: 'error', componentId: component.id, target: component.name, message: '缺少读屏说明。', field: 'screenReader' });
  }
  if (contractChanged && component.examples.length) {
    issues.push({ id: `${component.id}-contract`, level: 'info', componentId: component.id, target: component.name, message: '属性契约或交互签名发生变化，建议创建快照并迁移示例。', field: 'properties' });
  }
  return issues;
};

export class SpecStore extends EventTarget {
  state: WorkspaceState;
  private undoStack: WorkspaceState[] = [];
  private redoStack: WorkspaceState[] = [];
  private lastAction = '';

  constructor() {
    super();
    this.state = this.load();
  }

  get selected(): ComponentSpec | undefined {
    return this.state.components.find((item) => item.id === this.state.selectedId);
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get lastUndoLabel() { return this.lastAction; }

  select(id: string) {
    if (!this.state.components.some((item) => item.id === id)) return;
    this.state = { ...this.state, selectedId: id };
    this.persistSilently();
    this.emit();
  }

  setTeam(team: TeamId) {
    if (this.state.currentTeam === team) return;
    this.state = { ...this.state, currentTeam: team };
    this.persistSilently();
    this.emit();
    this.notice(`已切换到${TEAM_LABELS[team]}，后续编辑与确认以该组身份记录。`);
  }

  addComponent() {
    const id = uid('component');
    const component: ComponentSpec = {
      id,
      name: 'Untitled component',
      category: 'Uncategorised',
      status: 'draft',
      purpose: '说明该组件解决的用户问题。',
      usage: '说明何时使用、何时不要使用。',
      properties: [],
      states: 'default、hover、focus-visible、disabled。',
      keyboardBehavior: '记录 Tab、Enter、Space、方向键和 Esc 等行为。',
      screenReader: '记录角色、名称、状态和动态播报。',
      disabledScenarios: '记录不应使用该组件的场景。',
      interactionSignature: '',
      examples: [],
      revision: 1,
      updatedAt: new Date().toISOString(),
      owners: { ...DEFAULT_OWNERS },
      pendingRevision: null,
      snapshots: []
    };
    this.commit('新建组件', (state) => {
      state.components.unshift(component);
      state.selectedId = id;
    });
  }

  /**
   * 编辑组件字段。责任组字段直接生效；跨组字段写入待审修订草稿，
   * 组件已发布内容保持不变，直到两个责任组确认后发布。
   */
  updateComponent(patch: Partial<ComponentSpec>): boolean {
    const selected = this.selected;
    if (!selected) return false;
    const team = this.state.currentTeam;
    const ownKeys: string[] = [];
    const crossKeys: string[] = [];
    for (const key of Object.keys(patch)) {
      (selected.owners[sectionOfField(key)] === team ? ownKeys : crossKeys).push(key);
    }
    if (!ownKeys.length && !crossKeys.length) return false;
    const ok = this.commit(crossKeys.length ? '提交跨组修订' : '编辑组件', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      if (!target) return;
      if (ownKeys.length) {
        this.guardRevisionConflict(target, ownKeys);
        const beforeHash = contractHashOf(target);
        const picked: Record<string, unknown> = { updatedAt: new Date().toISOString() };
        ownKeys.forEach((key) => { picked[key] = (patch as Record<string, unknown>)[key]; });
        Object.assign(target, picked);
        this.mirrorToDraft(state, target, (draft) => Object.assign(draft, picked));
        this.staleExamplesIfContractChanged(target, beforeHash);
        this.auditDirectEdit(state, target, team, `修改${ownKeys.map(fieldLabel).join('、')}。`);
      }
      if (crossKeys.length) {
        const revision = this.ensureRevision(target, team);
        const picked: Record<string, unknown> = {};
        crossKeys.forEach((key) => { picked[key] = (patch as Record<string, unknown>)[key]; });
        Object.assign(revision.draft, picked);
        this.syncDraftRevision(state, target, revision);
        this.audit(state, team, 'propose', target, `${TEAM_LABELS[team]} 提交跨组修订：${crossKeys.map(fieldLabel).join('、')}。`);
      }
    });
    if (ok && crossKeys.length) {
      this.notice(`已提交为待审修订：${crossKeys.map(fieldLabel).join('、')}，两个责任组确认后才能发布。`);
    }
    return ok;
  }

  addProperty(): boolean {
    const selected = this.selected;
    if (!selected) return false;
    const team = this.state.currentTeam;
    const property = {
      id: uid('property'),
      name: 'newProperty',
      type: 'string',
      required: false,
      defaultValue: '',
      description: '描述该属性对开发者和用户的影响。'
    };
    return this.mutateSection(selected, 'properties', '新增属性', (state, target, owner) => {
      if (owner) {
        const beforeHash = contractHashOf(target);
        target.properties.push(property);
        target.updatedAt = new Date().toISOString();
        this.mirrorToDraft(state, target, (draft) => draft.properties.push(structuredClone(property)));
        this.staleExamplesIfContractChanged(target, beforeHash);
        this.auditDirectEdit(state, target, team, `新增属性 ${property.name}。`);
      } else {
        const revision = this.ensureRevision(target, team);
        revision.draft.properties.push(structuredClone(property));
        this.syncDraftRevision(state, target, revision);
        this.audit(state, team, 'propose', target, `${TEAM_LABELS[team]} 提交跨组修订：新增属性 ${property.name}。`);
      }
    });
  }

  updateProperty(propertyId: string, patch: Partial<ComponentSpec['properties'][number]>): boolean {
    const selected = this.selected;
    if (!selected) return false;
    const team = this.state.currentTeam;
    return this.mutateSection(selected, 'properties', '编辑属性', (state, target, owner) => {
      if (owner) {
        const property = target.properties.find((item) => item.id === propertyId);
        if (!property) return;
        const beforeHash = contractHashOf(target);
        Object.assign(property, patch);
        target.updatedAt = new Date().toISOString();
        this.mirrorToDraft(state, target, (draft) => {
          const draftProperty = draft.properties.find((item) => item.id === propertyId);
          if (draftProperty) Object.assign(draftProperty, patch);
        });
        this.staleExamplesIfContractChanged(target, beforeHash);
        this.auditDirectEdit(state, target, team, `修改属性 ${property.name}。`);
      } else {
        const revision = this.ensureRevision(target, team);
        const property = revision.draft.properties.find((item) => item.id === propertyId);
        if (!property) throw new StoreError('该属性不在修订草稿中，请先撤销现有修订。');
        Object.assign(property, patch);
        this.syncDraftRevision(state, target, revision);
        this.audit(state, team, 'propose', target, `${TEAM_LABELS[team]} 提交跨组修订：属性 ${property.name}。`);
      }
    });
  }

  removeProperty(propertyId: string): boolean {
    const selected = this.selected;
    if (!selected) return false;
    const team = this.state.currentTeam;
    return this.mutateSection(selected, 'properties', '删除属性', (state, target, owner) => {
      const markReferences = (content: ComponentContent, name: string) => {
        content.examples.forEach((example) => {
          if (example.propertyIds.includes(propertyId) || example.code.includes(name)) {
            example.stale = true;
            example.staleReason = `属性 ${name} 已删除，示例代码或说明仍可能引用它。`;
          }
        });
      };
      if (owner) {
        const property = target.properties.find((item) => item.id === propertyId);
        if (!property) return;
        const beforeHash = contractHashOf(target);
        target.properties = target.properties.filter((item) => item.id !== propertyId);
        target.updatedAt = new Date().toISOString();
        this.mirrorToDraft(state, target, (draft) => {
          draft.properties = draft.properties.filter((item) => item.id !== propertyId);
        });
        this.staleExamplesIfContractChanged(target, beforeHash);
        markReferences(target, property.name);
        if (target.pendingRevision) markReferences(target.pendingRevision.draft, property.name);
        this.auditDirectEdit(state, target, team, `删除属性 ${property.name}。`);
      } else {
        const revision = this.ensureRevision(target, team);
        const property = revision.draft.properties.find((item) => item.id === propertyId);
        if (!property) throw new StoreError('该属性不在修订草稿中，请先撤销现有修订。');
        revision.draft.properties = revision.draft.properties.filter((item) => item.id !== propertyId);
        this.syncDraftRevision(state, target, revision);
        markReferences(revision.draft, property.name);
        this.audit(state, team, 'propose', target, `${TEAM_LABELS[team]} 提交跨组修订：删除属性 ${property.name}。`);
      }
    });
  }

  addExample(): boolean {
    const selected = this.selected;
    if (!selected) return false;
    const team = this.state.currentTeam;
    const tag = selected.name.toLowerCase().replaceAll(' ', '-');
    const example = {
      id: uid('example'),
      title: '新示例',
      code: `<${tag}>示例</${tag}>`,
      propertyIds: [] as string[],
      stale: false,
      staleReason: '',
      createdFromRevision: selected.revision
    };
    return this.mutateSection(selected, 'examples', '新增示例', (state, target, owner) => {
      if (owner) {
        target.examples.push(example);
        target.updatedAt = new Date().toISOString();
        this.mirrorToDraft(state, target, (draft) => draft.examples.push(structuredClone(example)));
        this.auditDirectEdit(state, target, team, `新增示例「${example.title}」。`);
      } else {
        const revision = this.ensureRevision(target, team);
        revision.draft.examples.push(structuredClone(example));
        this.syncDraftRevision(state, target, revision);
        this.audit(state, team, 'propose', target, `${TEAM_LABELS[team]} 提交跨组修订：新增示例「${example.title}」。`);
      }
    });
  }

  updateExample(exampleId: string, patch: Partial<ComponentSpec['examples'][number]>): boolean {
    const selected = this.selected;
    if (!selected) return false;
    const team = this.state.currentTeam;
    return this.mutateSection(selected, 'examples', '编辑示例', (state, target, owner) => {
      if (owner) {
        const example = target.examples.find((item) => item.id === exampleId);
        if (!example) return;
        Object.assign(example, patch);
        target.updatedAt = new Date().toISOString();
        this.mirrorToDraft(state, target, (draft) => {
          const draftExample = draft.examples.find((item) => item.id === exampleId);
          if (draftExample) Object.assign(draftExample, patch);
        });
        this.auditDirectEdit(state, target, team, `修改示例「${example.title}」。`);
      } else {
        const revision = this.ensureRevision(target, team);
        const example = revision.draft.examples.find((item) => item.id === exampleId);
        if (!example) throw new StoreError('该示例不在修订草稿中，请先撤销现有修订。');
        Object.assign(example, patch);
        this.syncDraftRevision(state, target, revision);
        this.audit(state, team, 'propose', target, `${TEAM_LABELS[team]} 提交跨组修订：示例「${example.title}」。`);
      }
    });
  }

  removeExample(exampleId: string): boolean {
    const selected = this.selected;
    if (!selected) return false;
    const team = this.state.currentTeam;
    return this.mutateSection(selected, 'examples', '删除示例', (state, target, owner) => {
      if (owner) {
        const example = target.examples.find((item) => item.id === exampleId);
        target.examples = target.examples.filter((item) => item.id !== exampleId);
        target.updatedAt = new Date().toISOString();
        this.mirrorToDraft(state, target, (draft) => {
          draft.examples = draft.examples.filter((item) => item.id !== exampleId);
        });
        if (example) this.auditDirectEdit(state, target, team, `删除示例「${example.title}」。`);
      } else {
        const revision = this.ensureRevision(target, team);
        const example = revision.draft.examples.find((item) => item.id === exampleId);
        if (!example) throw new StoreError('该示例不在修订草稿中，请先撤销现有修订。');
        revision.draft.examples = revision.draft.examples.filter((item) => item.id !== exampleId);
        this.syncDraftRevision(state, target, revision);
        this.audit(state, team, 'propose', target, `${TEAM_LABELS[team]} 提交跨组修订：删除示例「${example.title}」。`);
      }
    });
  }

  /** 当前小组确认待审修订；确认与当前契约哈希绑定 */
  confirmRevision(componentId: string): boolean {
    const team = this.state.currentTeam;
    const ok = this.commit('确认修订', (state) => {
      const target = state.components.find((item) => item.id === componentId);
      const revision = target?.pendingRevision;
      if (!target || !revision) throw new StoreError('当前没有待审修订。');
      if (validConfirmations(revision).some((item) => item.team === team)) {
        throw new StoreError(`${TEAM_LABELS[team]} 已确认当前契约，无需重复确认。`);
      }
      revision.confirmations = revision.confirmations.filter((item) => item.team !== team);
      revision.confirmations.push({ team, at: new Date().toISOString(), contractHash: revision.contractHash });
      revision.updatedAt = new Date().toISOString();
      this.audit(state, team, 'confirm', target, `${TEAM_LABELS[team]} 确认修订（契约 ${revision.contractHash}）。`);
    });
    if (ok) {
      const revision = this.state.components.find((item) => item.id === componentId)?.pendingRevision;
      this.notice(revision && canPublish(revision)
        ? `${TEAM_LABELS[team]} 已确认，已满足两个责任组确认，可以发布。`
        : `${TEAM_LABELS[team]} 已确认，仍待其他责任组确认。`);
    }
    return ok;
  }

  /** 两个责任组确认后发布修订；失败则回到修订前内容并保留草稿 */
  publishRevision(componentId: string): boolean {
    const team = this.state.currentTeam;
    const ok = this.commit('发布修订', (state) => {
      const target = state.components.find((item) => item.id === componentId);
      const revision = target?.pendingRevision;
      if (!target || !revision) throw new StoreError('当前没有待审修订。');
      if (!revision.changes.length) throw new StoreError('修订没有实际改动，无需发布。');
      const confirmed = new Set(validConfirmations(revision).map((item) => item.team));
      const missing = revision.requiredTeams.filter((item) => !confirmed.has(item));
      if (missing.length || confirmed.size < 2) {
        const needed = missing.length ? `仍需 ${missing.map((item) => TEAM_LABELS[item]).join('、')} 确认` : '仍需至少两个责任组确认';
        throw new StoreError(`${needed}，两个责任组确认后才能发布。`);
      }
      const nextContent: ComponentContent = { ...structuredClone(revision.draft), revision: target.revision + 1, updatedAt: new Date().toISOString() };
      const errors = validateComponent(nextContent).filter((issue) => issue.level === 'error');
      if (errors.length) {
        throw new StoreError(`「${target.name}」发布内容未通过校验：${errors[0].message} 已回到修订前内容，草稿已保留。`, true);
      }
      // 发布前自动快照，修订前内容可随时回溯
      const snapshot: ComponentSnapshot = {
        revision: target.revision,
        savedAt: new Date().toISOString(),
        reason: '发布前自动快照',
        component: contentOf(target)
      };
      target.snapshots.unshift(snapshot);
      target.snapshots = target.snapshots.slice(0, 12);
      Object.assign(target, nextContent);
      target.pendingRevision = null;
      this.audit(state, team, 'publish', target, `${TEAM_LABELS[team]} 发布修订，内容进入 r${target.revision}，修订前内容已存入快照。`);
    });
    if (ok) this.notice('修订已发布，修订前内容已存入版本快照。');
    return ok;
  }

  discardRevision(componentId: string): boolean {
    const team = this.state.currentTeam;
    const ok = this.commit('撤销修订', (state) => {
      const target = state.components.find((item) => item.id === componentId);
      const revision = target?.pendingRevision;
      if (!target || !revision) throw new StoreError('当前没有待审修订。');
      if (team !== revision.proposer && !revision.requiredTeams.includes(team)) {
        throw new StoreError('只有发起组或相关责任组可以撤销该修订。');
      }
      target.pendingRevision = null;
      this.audit(state, team, 'discard', target, `${TEAM_LABELS[team]} 撤销了待审修订，草稿已删除。`);
    });
    if (ok) this.notice('已撤销待审修订，组件内容保持不变。');
    return ok;
  }

  createSnapshot(reason = '手动版本'): boolean {
    const selected = this.selected;
    if (!selected) return false;
    return this.commit('创建版本快照', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      if (!target) return;
      const snapshot: ComponentSnapshot = {
        revision: target.revision,
        savedAt: new Date().toISOString(),
        reason,
        component: contentOf(target)
      };
      target.snapshots.unshift(snapshot);
      target.snapshots = target.snapshots.slice(0, 12);
      target.revision += 1;
      target.updatedAt = new Date().toISOString();
    });
  }

  /** 迁移示例到当前契约：仅示例责任组可执行 */
  migrateExamples(): boolean {
    const selected = this.selected;
    if (!selected) return false;
    const team = this.state.currentTeam;
    if (selected.owners.examples !== team) {
      this.emitError(`示例归属${TEAM_LABELS[selected.owners.examples]}，请切换到该组后再迁移。`);
      return false;
    }
    return this.commit('迁移示例到当前版本', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      if (!target) return;
      const activePropertyIds = new Set(target.properties.map((item) => item.id));
      target.examples.forEach((example) => {
        example.propertyIds = example.propertyIds.filter((id) => activePropertyIds.has(id));
        example.stale = false;
        example.staleReason = '';
        example.createdFromRevision = target.revision;
      });
      target.revision += 1;
      target.updatedAt = new Date().toISOString();
      this.audit(state, team, 'direct-edit', target, `${TEAM_LABELS[team]} 迁移示例到 r${target.revision}，旧结论已重算。`);
    });
  }

  validate(): ValidationIssue[] {
    return this.state.components.flatMap((component) => validateComponent(component));
  }

  undo() {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(clone(this.state));
    // 留痕与当前小组不随撤销回退
    this.state = { ...previous, auditLog: this.state.auditLog, currentTeam: this.state.currentTeam };
    this.persistSilently();
    this.emit();
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(clone(this.state));
    this.state = { ...next, auditLog: this.state.auditLog, currentTeam: this.state.currentTeam };
    this.persistSilently();
    this.emit();
  }

  reset() {
    this.undoStack = [];
    this.redoStack = [];
    this.state = createInitialState();
    this.persistSilently();
    this.emit();
  }

  /** 编辑区操作路由：责任组直接修改，跨组写入待审修订 */
  private mutateSection(
    component: ComponentSpec,
    section: 'properties' | 'examples',
    label: string,
    mutator: (state: WorkspaceState, target: ComponentSpec, owner: boolean) => void
  ): boolean {
    const team = this.state.currentTeam;
    const owner = component.owners[section] === team;
    const ok = this.commit(owner ? label : '提交跨组修订', (state) => {
      const target = state.components.find((item) => item.id === component.id);
      if (!target) return;
      if (owner) this.guardRevisionConflict(target, [section]);
      mutator(state, target, owner);
    });
    if (ok && !owner) this.notice(`已提交为待审修订：${label}，两个责任组确认后才能发布。`);
    return ok;
  }

  /** 直接修改与待审修订冲突的字段时拒绝，避免发布时互相覆盖 */
  private guardRevisionConflict(target: ComponentSpec, fields: string[]) {
    const revision = target.pendingRevision;
    if (!revision) return;
    const touched = new Set(revision.changes.map((change) => change.field));
    const conflict = fields.find((field) => touched.has(field));
    if (conflict) {
      throw new StoreError(`「${fieldLabel(conflict)}」已有待审修订，请先发布或撤销该修订。`);
    }
  }

  private ensureRevision(target: ComponentSpec, team: TeamId): PendingRevision {
    if (!target.pendingRevision) target.pendingRevision = createRevision(target, team);
    return target.pendingRevision;
  }

  /**
   * 责任组直接修改已发布内容时，把未涉及字段同步进修订草稿，
   * 保持草稿基于最新内容，发布不会回退这些直接修改；
   * 若契约因此变化，已有确认立即失效并重算。
   */
  private mirrorToDraft(state: WorkspaceState, target: ComponentSpec, apply: (draft: ComponentContent) => void) {
    const revision = target.pendingRevision;
    if (!revision) return;
    apply(revision.draft);
    revision.baseRevision = target.revision;
    this.syncDraftRevision(state, target, revision);
  }

  /** 重算修订；契约更新时已有确认立即失效，并写入留痕 */
  private syncDraftRevision(state: WorkspaceState, target: ComponentSpec, revision: PendingRevision) {
    const { invalidatedTeams, contractChanged } = syncRevision(revision, target);
    if (contractChanged && invalidatedTeams.length) {
      this.audit(state, 'system', 'invalidate', target, `属性契约更新，${invalidatedTeams.map((item) => TEAM_LABELS[item]).join('、')} 的确认已失效，需重新确认。`);
    }
  }

  /** 契约变化后，依赖示例不能沿用旧结论：全部标记待重新验证 */
  private staleExamplesIfContractChanged(target: ComponentSpec, beforeHash: string) {
    if (contractHashOf(target) === beforeHash) return;
    target.examples.forEach((example) => {
      example.stale = true;
      example.staleReason = '属性契约已更新，示例不能沿用旧结论，需要重新验证。';
    });
  }

  /** 已发布组件的责任组直接修改需要留痕 */
  private auditDirectEdit(state: WorkspaceState, target: ComponentSpec, team: TeamId, detail: string) {
    if (target.status !== 'published') return;
    this.audit(state, team, 'direct-edit', target, `${TEAM_LABELS[team]} 直接修改已发布组件：${detail}`);
  }

  private audit(state: WorkspaceState, team: TeamId | 'system', action: AuditAction, component: ComponentSpec, detail: string) {
    state.auditLog.unshift({
      id: uid('audit'),
      at: new Date().toISOString(),
      team,
      action,
      componentId: component.id,
      componentName: component.name,
      detail
    });
    state.auditLog = state.auditLog.slice(0, AUDIT_LIMIT);
  }

  /**
   * 事务化提交：变更失败或保存失败都回到修订前内容，草稿保留。
   */
  private commit(label: string, mutator: (state: WorkspaceState) => void): boolean {
    const before = clone(this.state);
    const next = clone(this.state);
    try {
      mutator(next);
    } catch (error) {
      // 守卫/校验失败：状态未应用，草稿原样保留
      if (error instanceof StoreError && error.auditable) {
        this.state.auditLog.unshift({
          id: uid('audit'),
          at: new Date().toISOString(),
          team: this.state.currentTeam,
          action: 'rollback',
          componentId: this.state.selectedId,
          componentName: this.selected?.name ?? '',
          detail: `${label}失败：${error.message}`
        });
        this.state.auditLog = this.state.auditLog.slice(0, AUDIT_LIMIT);
        this.persistSilently();
        this.emit();
      }
      this.emitError(error instanceof Error ? error.message : `${label}失败。`);
      return false;
    }
    this.state = next;
    try {
      this.persist();
    } catch {
      // 保存失败：回滚到修订前内容，草稿保留并留痕
      this.state = before;
      this.state.auditLog.unshift({
        id: uid('audit'),
        at: new Date().toISOString(),
        team: this.state.currentTeam,
        action: 'rollback',
        componentId: this.state.selectedId,
        componentName: this.selected?.name ?? '',
        detail: `${label}保存失败，已回到修订前内容，草稿已保留。`
      });
      this.state.auditLog = this.state.auditLog.slice(0, AUDIT_LIMIT);
      this.persistSilently();
      this.emit();
      this.emitError(`${label}失败，已回到修订前内容，草稿已保留。`);
      return false;
    }
    this.undoStack.push(before);
    this.undoStack = this.undoStack.slice(-40);
    this.redoStack = [];
    this.lastAction = label;
    this.emit();
    return true;
  }

  private load(): WorkspaceState {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) return this.migrate(JSON.parse(saved) as WorkspaceState);
    } catch {
      // 损坏的本地草稿回退到内置示例数据
    }
    return createInitialState();
  }

  /** 旧数据缺责任组等字段时补默认归属，并写入留痕 */
  private migrate(state: WorkspaceState): WorkspaceState {
    if (!Array.isArray(state.components) || !state.components.length) return createInitialState();
    if (state.currentTeam !== 'spec' && state.currentTeam !== 'a11y' && state.currentTeam !== 'platform') {
      state.currentTeam = 'spec';
    }
    if (!Array.isArray(state.auditLog)) state.auditLog = [];
    for (const component of state.components) {
      if (!component.owners) {
        component.owners = { ...DEFAULT_OWNERS };
        state.auditLog.unshift({
          id: uid('audit'),
          at: new Date().toISOString(),
          team: 'system',
          action: 'migrate-owner',
          componentId: component.id,
          componentName: component.name,
          detail: '旧数据缺少责任组，已补默认归属：组件→规范组、属性→平台组、无障碍说明→无障碍组、示例→平台组。'
        });
      }
      component.pendingRevision ??= null;
      if (!Array.isArray(component.snapshots)) component.snapshots = [];
    }
    state.auditLog = state.auditLog.slice(0, AUDIT_LIMIT);
    if (!state.components.some((item) => item.id === state.selectedId)) {
      state.selectedId = state.components[0].id;
    }
    return state;
  }

  private persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
  }

  private persistSilently() {
    try {
      this.persist();
    } catch {
      // 选择/切换等轻量操作失败时保持内存状态
    }
  }

  private emit() {
    this.dispatchEvent(new CustomEvent('change'));
  }

  private notice(message: string) {
    this.dispatchEvent(new CustomEvent('store-notice', { detail: message }));
  }

  private emitError(message: string) {
    this.dispatchEvent(new CustomEvent('store-error', { detail: message }));
  }
}
