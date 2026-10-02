import type { GroupId, PendingRevision } from './types';

export const GROUP_LABELS: Record<GroupId, string> = {
  specs: '规范组',
  platform: '平台组',
  a11y: '无障碍组'
};

export const GROUP_MEMBERS: Record<GroupId, string[]> = {
  specs: ['林规范', '周契约'],
  platform: ['陈平台', '李架构'],
  a11y: ['王无碍', '赵读屏']
};

/**
 * 字段 -> 责任组。组件内容归规范组，属性契约与示例归平台组，
 * 键盘行为与读屏说明归无障碍组。
 */
export const FIELD_OWNERS: Partial<Record<string, GroupId>> = {
  name: 'specs',
  category: 'specs',
  status: 'specs',
  purpose: 'specs',
  usage: 'specs',
  states: 'specs',
  disabledScenarios: 'specs',
  properties: 'platform',
  interactionSignature: 'platform',
  examples: 'platform',
  keyboardBehavior: 'a11y',
  screenReader: 'a11y'
};

export const FIELD_LABELS: Partial<Record<string, string>> = {
  name: '组件名称',
  category: '分类',
  status: '组件状态',
  purpose: '用途',
  usage: '使用规则',
  states: '状态说明',
  disabledScenarios: '禁用场景',
  properties: '属性契约',
  interactionSignature: '交互签名',
  examples: '关联示例',
  keyboardBehavior: '键盘行为',
  screenReader: '读屏说明'
};

/** 契约字段：发布后会让其他待审契约修订的确认立即失效。 */
export const CONTRACT_FIELDS = ['properties', 'interactionSignature'];

/**
 * 一个待审修订需要哪些组确认：
 * 改动字段的责任组 + 提报组；跨组改动两者必不相同，即「两个责任组」。
 */
export function requiredGroupsFor(revision: PendingRevision): GroupId[] {
  const groups = new Set<GroupId>();
  for (const field of revision.changedFields) {
    const owner = FIELD_OWNERS[field];
    if (owner) groups.add(owner);
  }
  groups.add(revision.proposerGroup);
  return [...groups];
}

export function missingConfirmations(revision: PendingRevision): GroupId[] {
  const confirmed = new Set(revision.confirmations.map((item) => item.group));
  return requiredGroupsFor(revision).filter((group) => !confirmed.has(group));
}
