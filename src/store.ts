import { createInitialState } from './data';
import { CONTRACT_FIELDS, FIELD_LABELS, FIELD_OWNERS, GROUP_LABELS, GROUP_MEMBERS, requiredGroupsFor } from './groups';
import type { ComponentExample, ComponentSpec, ComponentSnapshot, GroupId, PendingRevision, PropertySpec, ValidationIssue, WorkspaceState } from './types';

const STORAGE_KEY = 'sologsb-1028-workspace-v1';

const clone = <T>(value: T): T => structuredClone(value);
const uid = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const signature = (component: ComponentSpec) => `${component.properties.map((item) => `${item.name}:${item.required}`).join('|')}::${component.interactionSignature}`;

export interface RevisionActionResult {
  ok: boolean;
  error?: string;
}

export class SpecStore extends EventTarget {
  state: WorkspaceState;
  private undoStack: WorkspaceState[] = [];
  private redoStack: WorkspaceState[] = [];
  private lastAction = '';
  /** 跨组改动进入待审修订后，界面提示用。 */
  revisionNotice: string | null = null;

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
    this.persist();
    this.emit();
  }

  setCurrentGroup(group: GroupId) {
    this.commitSilent((state) => {
      state.currentGroup = group;
      if (!GROUP_MEMBERS[group].includes(state.currentMember)) {
        state.currentMember = GROUP_MEMBERS[group][0];
      }
    });
  }

  setCurrentMember(member: string) {
    this.commitSilent((state) => { state.currentMember = member; });
  }

  addComponent() {
    const id = uid('component');
    const component: ComponentSpec = {
      id,
      name: 'Untitled component',
      category: 'Uncategorised',
      status: 'draft',
      ownerGroup: this.state.currentGroup,
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
      snapshots: []
    };
    this.commit('新建组件', (state) => {
      state.components.unshift(component);
      state.selectedId = id;
    });
  }

  updateComponent(patch: Partial<ComponentSpec>, markExamplesStale = false) {
    const selected = this.selected;
    if (!selected) return;
    const direct: Partial<ComponentSpec> = {};
    const pending: Partial<ComponentSpec> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (FIELD_OWNERS[key] === this.state.currentGroup) {
        (direct as Record<string, unknown>)[key] = value;
      } else {
        (pending as Record<string, unknown>)[key] = value;
      }
    }
    if (Object.keys(direct).length) {
      this.commit('编辑组件', (state) => {
        const target = state.components.find((item) => item.id === selected.id);
        if (!target) return;
        Object.assign(target, direct, { updatedAt: new Date().toISOString() });
        if (markExamplesStale) {
          this.markExamplesStale(target, '组件交互或属性契约已修改，依赖示例需要重新验证，不能沿用旧结论。');
        }
        if (direct.interactionSignature !== undefined) this.invalidateContractRevisions(state);
      });
    }
    if (Object.keys(pending).length) {
      const fields = Object.keys(pending);
      this.proposeRevision(selected.id, pending, fields, {
        contractTouched: fields.some((field) => CONTRACT_FIELDS.includes(field))
      });
    }
  }

  addProperty() {
    const selected = this.selected;
    if (!selected) return;
    const target = this.state.components.find((item) => item.id === selected.id);
    if (!target) return;
    const property: PropertySpec = {
      id: uid('property'),
      name: 'newProperty',
      type: 'string',
      required: false,
      defaultValue: '',
      description: '描述该属性对开发者和用户的影响。'
    };
    const properties = [...target.properties, property];
    if (this.state.currentGroup === 'platform') {
      this.commit('新增属性', (state) => {
        const current = state.components.find((item) => item.id === selected.id);
        if (!current) return;
        current.properties = properties;
        current.updatedAt = new Date().toISOString();
        this.markExamplesStale(current, '属性契约已更新，新增属性后依赖示例需重新验证，不能沿用旧结论。');
        this.invalidateContractRevisions(state);
      });
    } else {
      this.proposeRevision(selected.id, { properties }, ['properties']);
    }
  }

  updateProperty(propertyId: string, patch: Partial<PropertySpec>) {
    const selected = this.selected;
    if (!selected) return;
    const target = this.state.components.find((item) => item.id === selected.id);
    if (!target) return;
    const properties = target.properties.map((item) => item.id === propertyId ? { ...item, ...patch } : item);
    const contractChanged = Object.keys(patch).some((key) => ['name', 'type', 'required', 'defaultValue'].includes(key));
    if (this.state.currentGroup === 'platform') {
      this.commit('编辑属性', (state) => {
        const current = state.components.find((item) => item.id === selected.id);
        if (!current) return;
        current.properties = properties;
        current.updatedAt = new Date().toISOString();
        if (contractChanged) {
          this.markExamplesStale(current, '属性契约已更新，依赖示例需重新验证，不能沿用旧结论。');
          this.invalidateContractRevisions(state);
        }
      });
    } else {
      this.proposeRevision(selected.id, { properties }, ['properties']);
    }
  }

  removeProperty(propertyId: string) {
    const selected = this.selected;
    if (!selected) return;
    const target = this.state.components.find((item) => item.id === selected.id);
    if (!target) return;
    const properties = target.properties.filter((item) => item.id !== propertyId);
    if (this.state.currentGroup === 'platform') {
      this.commit('删除属性', (state) => {
        const current = state.components.find((item) => item.id === selected.id);
        const property = current?.properties.find((item) => item.id === propertyId);
        if (!current || !property) return;
        current.properties = properties;
        current.examples.forEach((example) => {
          if (example.propertyIds.includes(propertyId) || example.code.includes(property.name)) {
            example.stale = true;
            example.staleReason = `属性 ${property.name} 已删除，示例代码或说明仍可能引用它。`;
          }
        });
        current.updatedAt = new Date().toISOString();
        this.invalidateContractRevisions(state);
      });
    } else {
      this.proposeRevision(selected.id, { properties }, ['properties']);
    }
  }

  addExample() {
    const selected = this.selected;
    if (!selected) return;
    const target = this.state.components.find((item) => item.id === selected.id);
    if (!target) return;
    const exampleId = uid('example');
    const example: ComponentExample = {
      id: exampleId,
      title: '新示例',
      code: `<${target.name.toLowerCase().replaceAll(' ', '-')}>示例</${target.name.toLowerCase().replaceAll(' ', '-')}>`,
      propertyIds: [],
      stale: false,
      staleReason: '',
      createdFromRevision: target.revision
    };
    const examples = [...target.examples, example];
    if (this.state.currentGroup === 'platform') {
      this.commit('新增示例', (state) => {
        const current = state.components.find((item) => item.id === selected.id);
        if (current) current.examples = examples;
      });
    } else {
      this.proposeRevision(selected.id, { examples }, ['examples']);
    }
  }

  updateExample(exampleId: string, patch: Partial<ComponentExample>) {
    const selected = this.selected;
    if (!selected) return;
    const target = this.state.components.find((item) => item.id === selected.id);
    if (!target) return;
    const examples = target.examples.map((item) => item.id === exampleId ? { ...item, ...patch } : item);
    if (this.state.currentGroup === 'platform') {
      this.commit('编辑示例', (state) => {
        const current = state.components.find((item) => item.id === selected.id);
        if (current) current.examples = examples;
      });
    } else {
      this.proposeRevision(selected.id, { examples }, ['examples']);
    }
  }

  removeExample(exampleId: string) {
    const selected = this.selected;
    if (!selected) return;
    const target = this.state.components.find((item) => item.id === selected.id);
    if (!target) return;
    const examples = target.examples.filter((item) => item.id !== exampleId);
    if (this.state.currentGroup === 'platform') {
      this.commit('删除示例', (state) => {
        const current = state.components.find((item) => item.id === selected.id);
        if (current) current.examples = examples;
      });
    } else {
      this.proposeRevision(selected.id, { examples }, ['examples']);
    }
  }

  createSnapshot(reason = '手动版本') {
    const selected = this.selected;
    if (!selected) return;
    this.commit('创建版本快照', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      if (!target) return;
      const { snapshots: _ignored, ...component } = clone(target);
      const nextRevision = target.revision + 1;
      const snapshot: ComponentSnapshot = {
        revision: target.revision,
        savedAt: new Date().toISOString(),
        reason,
        component: { ...component, revision: target.revision }
      };
      target.snapshots.unshift(snapshot);
      target.snapshots = target.snapshots.slice(0, 12);
      target.revision = nextRevision;
      target.updatedAt = new Date().toISOString();
    });
  }

  migrateExamples() {
    const selected = this.selected;
    if (!selected) return;
    this.commit('迁移示例到当前版本', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      if (!target) return;
      const currentSignature = signature(target);
      const activePropertyIds = new Set(target.properties.map((item) => item.id));
      target.examples.forEach((example) => {
        example.propertyIds = example.propertyIds.filter((id) => activePropertyIds.has(id));
        example.stale = false;
        example.staleReason = '';
        example.createdFromRevision = target.revision;
      });
      target.interactionSignature = currentSignature.split('::')[1] ?? target.interactionSignature;
      target.revision += 1;
      target.updatedAt = new Date().toISOString();
    });
  }

  /** 跨组改动进入待审修订，不直接改已发布内容。 */
  private proposeRevision(componentId: string, patch: Partial<ComponentSpec>, changedFields: string[], options: { contractTouched?: boolean; reason?: string } = {}) {
    const revision: PendingRevision = {
      id: uid('revision'),
      componentId,
      proposerGroup: this.state.currentGroup,
      proposer: this.state.currentMember,
      reason: options.reason ?? `跨组修改：${changedFields.map((field) => FIELD_LABELS[field] ?? field).join('、')}`,
      changedFields,
      patch,
      confirmations: [],
      status: 'pending',
      createdAt: new Date().toISOString(),
      contractTouched: options.contractTouched ?? changedFields.some((field) => CONTRACT_FIELDS.includes(field))
    };
    this.revisionNotice = '跨组修改已进入待审修订，需责任组与提报组共同确认后才能发布';
    this.commit('提交待审修订', (state) => {
      state.pendingRevisions.unshift(revision);
    });
  }

  confirmRevision(revisionId: string): RevisionActionResult {
    const revision = this.state.pendingRevisions.find((item) => item.id === revisionId);
    if (!revision || revision.status !== 'pending') {
      return { ok: false, error: '修订不存在或已处理。' };
    }
    const required = requiredGroupsFor(revision);
    if (!required.includes(this.state.currentGroup)) {
      return { ok: false, error: `你属于${GROUP_LABELS[this.state.currentGroup]}，不是该修订的责任组，不能确认。` };
    }
    if (revision.confirmations.some((item) => item.group === this.state.currentGroup)) {
      return { ok: false, error: '本组已确认，无需重复确认。' };
    }
    const ok = this.commit('确认修订', (state) => {
      const target = state.pendingRevisions.find((item) => item.id === revisionId);
      if (!target) return;
      target.confirmations.push({ group: state.currentGroup, member: state.currentMember, at: new Date().toISOString() });
    }, { rollbackOnFailure: true });
    return ok ? { ok: true } : { ok: false, error: '确认失败：本地存储写入失败，已回滚确认并保留修订草稿。' };
  }

  rejectRevision(revisionId: string): RevisionActionResult {
    const revision = this.state.pendingRevisions.find((item) => item.id === revisionId);
    if (!revision || revision.status !== 'pending') {
      return { ok: false, error: '修订不存在或已处理。' };
    }
    if (!requiredGroupsFor(revision).includes(this.state.currentGroup)) {
      return { ok: false, error: '只有该修订的责任组可以拒绝。' };
    }
    const ok = this.commit('拒绝修订', (state) => {
      const target = state.pendingRevisions.find((item) => item.id === revisionId);
      if (target) target.status = 'rejected';
    });
    return ok ? { ok: true } : { ok: false, error: '拒绝失败：本地存储写入失败，已保留修订草稿。' };
  }

  withdrawRevision(revisionId: string): RevisionActionResult {
    const revision = this.state.pendingRevisions.find((item) => item.id === revisionId);
    if (!revision || revision.status !== 'pending') {
      return { ok: false, error: '修订不存在或已处理。' };
    }
    if (revision.proposerGroup !== this.state.currentGroup) {
      return { ok: false, error: '只有提报组可以撤回修订。' };
    }
    const ok = this.commit('撤回修订', (state) => {
      const target = state.pendingRevisions.find((item) => item.id === revisionId);
      if (target) target.status = 'rejected';
    });
    return ok ? { ok: true } : { ok: false, error: '撤回失败：本地存储写入失败，已保留修订草稿。' };
  }

  /** 两个责任组确认后才发布；发布失败一律回滚到修订前内容，修订草稿保留。 */
  publishRevision(revisionId: string): RevisionActionResult {
    const revision = this.state.pendingRevisions.find((item) => item.id === revisionId);
    if (!revision || revision.status !== 'pending') {
      return { ok: false, error: '修订不存在或已处理。' };
    }
    const missing = this.missingGroups(revision);
    if (missing.length) {
      return { ok: false, error: `尚未确认：${missing.map((group) => GROUP_LABELS[group]).join('、')}。两个责任组确认后才能发布。` };
    }
    const next = clone(this.state);
    const target = next.components.find((item) => item.id === revision.componentId);
    if (!target) {
      return { ok: false, error: '发布失败：找不到目标组件，已回滚到修订前内容并保留草稿。' };
    }
    Object.assign(target, revision.patch, { updatedAt: new Date().toISOString() });
    const errors = this.validateComponent(target);
    if (errors.length) {
      return { ok: false, error: `发布失败：${errors[0]}，已回滚到修订前内容并保留草稿。` };
    }
    if (revision.contractTouched) {
      this.markExamplesStale(target, '属性契约已更新，示例需重新验证，不能沿用旧结论。');
      this.invalidateContractRevisions(next);
    }
    const published = next.pendingRevisions.find((item) => item.id === revisionId);
    if (published) {
      published.status = 'published';
      published.publishedAt = new Date().toISOString();
    }
    const ok = this.adopt('发布修订', next, true);
    return ok ? { ok: true } : { ok: false, error: '发布失败：本地存储写入失败，已回滚到修订前内容并保留草稿。' };
  }

  private missingGroups(revision: PendingRevision): GroupId[] {
    const confirmed = new Set(revision.confirmations.map((item) => item.group));
    return requiredGroupsFor(revision).filter((group) => !confirmed.has(group));
  }

  /** 契约一旦更新，已有确认立即失效重算。 */
  private invalidateContractRevisions(state: WorkspaceState) {
    state.pendingRevisions.forEach((revision) => {
      if (revision.status === 'pending' && revision.contractTouched) {
        revision.confirmations = [];
      }
    });
  }

  private markExamplesStale(target: ComponentSpec, reason: string) {
    target.examples.forEach((example) => {
      example.stale = true;
      example.staleReason = reason;
    });
  }

  private validateComponent(component: ComponentSpec): string[] {
    const errors: string[] = [];
    const names = new Set<string>();
    for (const property of component.properties) {
      const name = property.name.trim();
      if (name && names.has(name)) errors.push(`属性名称 ${name} 重复`);
      names.add(name);
    }
    for (const example of component.examples) {
      if (!example.code.trim()) errors.push(`示例「${example.title}」代码为空`);
    }
    if (!component.keyboardBehavior.trim()) errors.push('缺少键盘行为说明');
    if (!component.screenReader.trim()) errors.push('缺少读屏说明');
    return errors;
  }

  validate(): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    for (const component of this.state.components) {
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
    }
    return issues;
  }

  undo() {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(clone(this.state));
    this.state = previous;
    if (!this.persist()) this.dispatchPersistError();
    this.emit();
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(clone(this.state));
    this.state = next;
    if (!this.persist()) this.dispatchPersistError();
    this.emit();
  }

  reset() {
    this.undoStack = [];
    this.redoStack = [];
    this.state = createInitialState();
    this.persist();
    this.emit();
  }

  private commit(label: string, mutator: (state: WorkspaceState) => void, options: { rollbackOnFailure?: boolean } = {}): boolean {
    const before = clone(this.state);
    const next = clone(this.state);
    mutator(next);
    this.undoStack.push(before);
    this.undoStack = this.undoStack.slice(-40);
    this.redoStack = [];
    this.lastAction = label;
    this.state = next;
    const ok = this.persist();
    if (!ok) {
      if (options.rollbackOnFailure) {
        this.state = before;
        this.undoStack.pop();
      } else {
        this.dispatchPersistError();
      }
    }
    this.emit();
    return ok;
  }

  /** 发布修订：整体替换为新状态，失败时回滚到修订前内容，修订草稿保留。 */
  private adopt(label: string, next: WorkspaceState, rollbackOnFailure: boolean): boolean {
    const before = clone(this.state);
    this.undoStack.push(before);
    this.undoStack = this.undoStack.slice(-40);
    this.redoStack = [];
    this.lastAction = label;
    this.state = next;
    const ok = this.persist();
    if (!ok && rollbackOnFailure) {
      this.state = before;
      this.undoStack.pop();
    } else if (!ok) {
      this.dispatchPersistError();
    }
    this.emit();
    return ok;
  }

  private commitSilent(mutator: (state: WorkspaceState) => void) {
    const next = clone(this.state);
    mutator(next);
    this.state = next;
    if (!this.persist()) this.dispatchPersistError();
    this.emit();
  }

  private dispatchPersistError() {
    this.dispatchEvent(new CustomEvent('persist-error'));
  }

  private emit() {
    this.dispatchEvent(new CustomEvent('change'));
  }

  private persist(): boolean {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
      return true;
    } catch (error) {
      console.error('本地保存失败', error);
      return false;
    }
  }

  private load(): WorkspaceState {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as Partial<WorkspaceState>;
        if (parsed && Array.isArray(parsed.components)) return this.migrate(parsed);
      }
    } catch (error) {
      console.error('读取本地草稿失败，回退内置数据', error);
    }
    return createInitialState();
  }

  /** 旧数据缺责任组、缺当前组或修订列表时补默认归属。 */
  private migrate(raw: Partial<WorkspaceState>): WorkspaceState {
    const currentGroup: GroupId = raw.currentGroup ?? 'specs';
    const state: WorkspaceState = {
      components: raw.components ?? [],
      selectedId: raw.selectedId ?? raw.components?.[0]?.id ?? '',
      currentGroup,
      currentMember: raw.currentMember ?? GROUP_MEMBERS[currentGroup][0],
      pendingRevisions: raw.pendingRevisions ?? []
    };
    if (!GROUP_MEMBERS[currentGroup].includes(state.currentMember)) {
      state.currentMember = GROUP_MEMBERS[currentGroup][0];
    }
    state.components.forEach((component) => {
      if (!component.ownerGroup) component.ownerGroup = 'specs';
    });
    return state;
  }
}
