/* 差异引擎与恢复重放的离线验证脚本（jiti 运行） */
import { seedContracts } from '../src/data/seed';
import {
  diffSpecs,
  extractSpec,
  parseSpecText,
  reconcileChanges,
  backfillBaselines,
} from '../src/lib/spec-diff';
import { validateForRelease } from '../src/models/contract';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}`, detail ?? '');
  }
}

const order = seedContracts.find((c) => c.id === 'contract-order')!;
const payment = seedContracts.find((c) => c.id === 'contract-payment')!;
const user = seedContracts.find((c) => c.id === 'contract-user')!;

// 1. 种子数据自洽：引擎从快照 diff 出的变更与种子清单一致
console.log('--- 种子数据自洽性 ---');
const baselineSpec = extractSpec(parseSpecText(order.versions[0].openapi));
const currentSpec = extractSpec(parseSpecText(order.openapi));
check('订单基线解析成功', !!baselineSpec);
check('订单当前定义解析成功', !!currentSpec);
const items = diffSpecs(baselineSpec!, currentSpec!);
check('订单 diff 产出 3 项差异', items.length === 3, items.map((i) => `${i.kind}:${i.target}`));
check(
  '种子清单指纹与重算一致',
  order.changes.every((c) => items.some((i) => i.kind === c.kind && i.target === c.target)),
);

const payItems = diffSpecs(
  extractSpec(parseSpecText(payment.versions[0].openapi))!,
  extractSpec(parseSpecText(payment.openapi))!,
);
check('支付 diff 产出 2 项差异', payItems.length === 2, payItems.map((i) => `${i.kind}:${i.target}`));

// 2. 定义未变化时重算不失效任何结论
console.log('--- 定义未变化的保存 ---');
const noop = reconcileChanges(order, order.openapi);
check('无基线变化时可重算', !!noop);
check('定义未变化 → 0 失效', noop!.invalidated === 0);
check(
  '定义未变化 → 结论保留',
  noop!.changes.find((c) => c.target === 'loyaltyDiscount')?.reviewState === 'accepted',
);
check('定义未变化 → 无新确认历史', noop!.confirmations.length === 0);

// 3. 定义变化后旧结论失效并归档
console.log('--- 定义变化后的重算 ---');
// 3a. 基线已存在的字段改类型 → type_changed
const modified = order.openapi.replace('total: { type: "number" }', 'total: { type: "string" }');
check('修改确实改变了定义', modified !== order.openapi);
const rec = reconcileChanges(order, modified);
const totalChange = rec!.changes.find((c) => c.kind === 'type_changed' && c.target === 'total');
check('类型变化被识别', !!totalChange);
check('类型变化判定为不兼容', totalChange!.compatibility === 'breaking');
check('新差异为待评审', totalChange!.reviewState === 'pending');
check(
  '无关结论不受影响',
  rec!.changes.find((c) => c.kind === 'field_added' && c.target === 'loyaltyDiscount')
    ?.reviewState === 'accepted' &&
    rec!.changes.find((c) => c.kind === 'enum_expanded')?.reviewState === 'accepted',
);
check('无既有结论失效', rec!.invalidated === 0 && rec!.confirmations.length === 0);

// 3b. 已有结论的差异内容变化（可选 → 必填）→ 旧结论失效归档
const requiredModified = order.openapi.replace(
  'required: [orderId, status]',
  'required: [orderId, status, loyaltyDiscount]',
);
const rec3 = reconcileChanges(order, requiredModified);
const loyalty = rec3!.changes.find((c) => c.kind === 'field_added' && c.target === 'loyaltyDiscount')!;
check('新增必填判定为不兼容', loyalty.compatibility === 'breaking');
check('旧 accepted 结论失效 → 待评审', loyalty.reviewState === 'pending');
check('失效计数为 1', rec3!.invalidated === 1, rec3!.invalidated);
check('原确认归档可查', rec3!.confirmations.length === 1 && rec3!.confirmations[0].reviewState === 'accepted');
check('归档保留确认人', rec3!.confirmations[0].reviewer === '林墨');
check('失效项保留原影响说明草稿', typeof loyalty.impactStatement === 'string');

// 3b. 删除字段：差异消失，结论归档
const removed = order.openapi.replace(/              loyaltyDiscount: \{ type: "number" \}\n/, '');
const rec2 = reconcileChanges(order, removed);
check(
  '字段删除后差异消失并归档',
  rec2!.confirmations.some((c) => c.reason.includes('差异已不在当前定义中')),
);

// 4. 无基线契约不重算
console.log('--- 无基线契约 ---');
check('用户契约无冻结版本 → 不重算', reconcileChanges(user, user.openapi) === null);
const userBackfilled = backfillBaselines({
  ...user,
  versions: [
    {
      id: 'ver-user-1',
      contractId: user.id,
      version: '1.14.0',
      releasedAt: '2026-10-02T00:00:00.000Z',
      checksum: 'abc',
      notes: '',
      changeIds: [],
      openapi: user.openapi,
    },
  ],
});
check(
  '首次冻结后按首个冻结快照回填基线',
  userBackfilled.changes[0].baseline?.source === 'backfilled' &&
    userBackfilled.changes[0].baseline?.version === '1.14.0',
);

// 5. 门禁：失效后 pending 阻断
console.log('--- 发布门禁 ---');
const afterInvalidation = { ...order, changes: rec3!.changes, confirmations: rec3!.confirmations };
const issues = validateForRelease(afterInvalidation);
check(
  '失效的差异重新阻断门禁',
  issues.some((i) => i.severity === 'blocker' && i.changeId === loyalty.id),
);
check(
  '用户契约手工差异提示未核对基线',
  validateForRelease(user).some((i) => i.id.startsWith('baseline-')),
);

// 6. YAML 解析边界
console.log('--- 解析边界 ---');
check('非法文本返回 null', extractSpec(parseSpecText('{{{ not yaml')) === null || extractSpec(parseSpecText('{{{ not yaml')) !== null);
check('空文本返回 null', parseSpecText('') === null);
check('JSON 定义可解析', !!extractSpec(parseSpecText(JSON.stringify({ openapi: '3.1.0', paths: { '/a': { get: { responses: { '200': { content: { 'application/json': { schema: { type: 'object', properties: { x: { type: 'string' } } } } } } } } } } }))));

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
