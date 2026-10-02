/**
 * 权限隔离修订流程的端到端验证。
 * 运行：npm run verify
 */
import { canPublish, validConfirmations } from '../src/revision';
import { SpecStore } from '../src/store';
import type { WorkspaceState } from '../src/types';

// ---- 浏览器环境 mock ----
const storage = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, String(value)); },
  removeItem: (key: string) => { storage.delete(key); },
  clear: () => storage.clear()
};
if (typeof globalThis.CustomEvent === 'undefined') {
  (globalThis as Record<string, unknown>).CustomEvent = class CustomEvent<T> extends Event {
    detail: T;
    constructor(type: string, init?: { detail?: T }) {
      super(type);
      this.detail = init?.detail as T;
    }
  };
}

const STORAGE_KEY = 'sologsb-1028-workspace-v1';
let failures = 0;
const check = (name: string, condition: boolean) => {
  console.log(`${condition ? '✅' : '❌'} ${name}`);
  if (!condition) failures += 1;
};
const freshStore = () => {
  storage.clear();
  return new SpecStore();
};

// ---- 1. 权限隔离：跨组修改进入待审修订，责任组直接修改 ----
{
  const store = freshStore();
  store.select('dialog-spec');
  store.setTeam('spec');
  store.updateComponent({ keyboardBehavior: 'Esc 关闭；焦点恢复。' });
  const component = store.selected!;
  check('跨组修改生成待审修订', component.pendingRevision !== null);
  check('跨组修改不改已发布内容', component.keyboardBehavior !== 'Esc 关闭；焦点恢复。');
  check('修订草稿包含跨组改动', component.pendingRevision!.draft.keyboardBehavior === 'Esc 关闭；焦点恢复。');
  check('发起组自动确认当前契约', validConfirmations(component.pendingRevision!).some((item) => item.team === 'spec'));
  check('所需确认组 = 发起组 + 责任组', ['spec', 'a11y'].every((team) => component.pendingRevision!.requiredTeams.includes(team as 'spec' | 'a11y')));
  check('跨组修改已留痕', store.state.auditLog.some((entry) => entry.action === 'propose' && entry.team === 'spec'));

  store.setTeam('a11y');
  const liveBefore = store.selected!.keyboardBehavior;
  const blocked = store.updateComponent({ keyboardBehavior: '责任组直接覆盖' });
  check('责任组直改与修订冲突的字段被拒绝', !blocked && store.selected!.keyboardBehavior === liveBefore);

  store.discardRevision('dialog-spec');
  check('撤销修订后草稿删除', store.selected!.pendingRevision === null);
  store.updateComponent({ keyboardBehavior: 'Esc 关闭；焦点恢复。' });
  check('责任组直接修改立即生效', store.selected!.keyboardBehavior === 'Esc 关闭；焦点恢复。');
  check('责任组直接修改不产生修订', store.selected!.pendingRevision === null);
}

// ---- 2. 两个责任组确认后才能发布 ----
{
  const store = freshStore();
  store.select('field-spec');
  check('种子数据自带待审修订', store.selected!.pendingRevision !== null);
  check('修订发布前内容未变', !store.selected!.properties.some((item) => item.name === 'clearable'));

  const denied = store.publishRevision('field-spec');
  check('缺少第二组确认时发布失败', !denied);
  check('发布失败后草稿保留', store.selected!.pendingRevision !== null);
  check('发布失败后内容未变', !store.selected!.properties.some((item) => item.name === 'clearable'));

  store.setTeam('platform');
  check('平台组确认成功', store.confirmRevision('field-spec'));
  check('两组确认后满足发布条件', canPublish(store.selected!.pendingRevision!));

  const revisionBefore = store.selected!.revision;
  check('两组确认后发布成功', store.publishRevision('field-spec'));
  check('发布后草稿内容生效', store.selected!.properties.some((item) => item.name === 'clearable'));
  check('发布后修订清空', store.selected!.pendingRevision === null);
  check('发布后修订号递增', store.selected!.revision === revisionBefore + 1);
  check('发布前内容已存入快照', store.selected!.snapshots[0]?.reason === '发布前自动快照');
  check('提案/确认/发布全部留痕', ['propose', 'confirm', 'publish'].every((action) => store.state.auditLog.some((entry) => entry.action === action && entry.componentId === 'field-spec')));
}

// ---- 3. 契约更新：确认立即失效重算，依赖示例不沿用旧结论 ----
{
  const store = freshStore();
  store.select('button-spec');
  store.setTeam('a11y');
  store.updateProperty('p-variant', { defaultValue: 'primary' });
  check('跨组属性修改进入待审修订', store.selected!.pendingRevision !== null);

  store.setTeam('platform');
  store.confirmRevision('button-spec');
  check('平台组确认当前契约', validConfirmations(store.selected!.pendingRevision!).some((item) => item.team === 'platform'));

  store.setTeam('a11y');
  store.updateProperty('p-variant', { defaultValue: 'accent' });
  const revision = store.selected!.pendingRevision!;
  const confirmedTeams = validConfirmations(revision).map((item) => item.team);
  check('契约更新后已有确认立即失效', !confirmedTeams.includes('platform'));
  check('发起组确认按新契约重算', confirmedTeams.includes('a11y'));
  check('确认失效已留痕', store.state.auditLog.some((entry) => entry.action === 'invalidate'));
  check('草稿内依赖示例不沿用旧结论', revision.draft.examples.every((example) => example.stale));
  check('确认失效后不满足发布条件', !canPublish(revision));

  store.select('dialog-spec');
  store.setTeam('platform');
  store.updateProperty('p-dialog-open', { defaultValue: 'true' });
  check('责任组直改契约后依赖示例全部失效', store.selected!.examples.every((example) => example.stale));
}

// ---- 4. 发布校验失败：回到修订前内容并保留草稿 ----
{
  const store = freshStore();
  store.select('dialog-spec');
  store.setTeam('spec');
  store.updateComponent({ keyboardBehavior: '' });
  store.setTeam('a11y');
  store.confirmRevision('dialog-spec');
  check('确认齐全、等待发布', canPublish(store.selected!.pendingRevision!));

  const contentBefore = store.selected!.keyboardBehavior;
  const published = store.publishRevision('dialog-spec');
  check('内容未通过校验时发布失败', !published);
  check('发布失败回到修订前内容', store.selected!.keyboardBehavior === contentBefore);
  check('发布失败后草稿保留', store.selected!.pendingRevision !== null);
  check('发布失败回滚已留痕', store.state.auditLog.some((entry) => entry.action === 'rollback'));
}

// ---- 5. 保存失败：回到修订前内容并保留草稿 ----
{
  const store = freshStore();
  store.select('dialog-spec');
  store.setTeam('spec');
  store.updateComponent({ keyboardBehavior: '修订草稿内容' });
  check('草稿已建立', store.selected!.pendingRevision !== null);

  const setItem = (globalThis.localStorage as Storage).setItem;
  (globalThis.localStorage as Storage).setItem = () => { throw new Error('QuotaExceededError'); };
  store.setTeam('platform');
  const saved = store.updateComponent({ name: '保存失败的修改' });
  check('保存失败返回失败', !saved);
  check('保存失败回到修订前内容', store.selected!.name !== '保存失败的修改');
  check('保存失败后草稿保留', store.selected!.pendingRevision?.draft.keyboardBehavior === '修订草稿内容');
  check('保存失败回滚已留痕', store.state.auditLog.some((entry) => entry.action === 'rollback'));
  (globalThis.localStorage as Storage).setItem = setItem;
}

// ---- 6. 直接修改不被后续发布回退（草稿镜像） ----
{
  const store = freshStore();
  store.select('dialog-spec');
  store.setTeam('a11y');
  store.updateComponent({ purpose: '无障碍组提议的新用途' });
  store.setTeam('spec');
  store.updateComponent({ usage: '规范组直接修改的使用规则' });
  store.confirmRevision('dialog-spec');
  check('直接修改镜像后仍可发布', store.publishRevision('dialog-spec'));
  check('发布后包含修订改动', store.selected!.purpose === '无障碍组提议的新用途');
  check('发布后保留责任组直接修改', store.selected!.usage === '规范组直接修改的使用规则');
}

// ---- 7. 旧数据缺责任组时补默认归属 ----
{
  storage.clear();
  const legacyState = {
    components: [
      {
        id: 'legacy-1', name: 'Legacy', category: 'x', status: 'published', purpose: '', usage: '',
        properties: [], states: '', keyboardBehavior: 'k', screenReader: 's', disabledScenarios: '',
        interactionSignature: '', examples: [], revision: 1, updatedAt: '', snapshots: []
      }
    ],
    selectedId: 'legacy-1'
  } satisfies Partial<WorkspaceState> & Record<string, unknown>;
  storage.set(STORAGE_KEY, JSON.stringify(legacyState));
  const store = new SpecStore();
  const migrated = store.state.components[0];
  check('旧数据补默认归属', migrated.owners.component === 'spec' && migrated.owners.properties === 'platform' && migrated.owners.accessibility === 'a11y' && migrated.owners.examples === 'platform');
  check('旧数据补当前小组', store.state.currentTeam === 'spec');
  check('旧数据补空修订位', migrated.pendingRevision === null);
  check('归属迁移已留痕', store.state.auditLog.some((entry) => entry.action === 'migrate-owner'));
}

// ---- 8. 重复确认被拒绝且不影响草稿 ----
{
  const store = freshStore();
  store.select('dialog-spec');
  store.setTeam('spec');
  store.updateComponent({ keyboardBehavior: 'x' });
  const again = store.confirmRevision('dialog-spec');
  check('重复确认被拒绝', !again);
  check('拒绝后草稿保留', store.selected!.pendingRevision !== null);
}

console.log(failures ? `\n${failures} 项验证失败` : '\n全部验证通过');
process.exit(failures ? 1 : 0);
