/* 服务层离线验证：并发冲突、恢复重放、差异组失效、旧数据迁移（jiti 运行） */

// localStorage 内存模拟
const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, String(value)),
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
};
(globalThis as Record<string, unknown>).window = {
  setTimeout: (fn: () => void, _ms: number) => setTimeout(fn, 0),
};

const service = await import('../src/services/contract-service');
const { seedContracts } = await import('../src/data/seed');
const models = await import('../src/models/contract');

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}`, detail ?? '');
  }
}

const STORAGE_KEY = 'pair-wise-gsb-70-contracts';
const RECOVERY_KEY = 'pair-wise-gsb-70-recovery';

// 1. 旧数据迁移：数组格式 → envelope，回填基线
console.log('--- 旧数据迁移 ---');
const legacy = JSON.parse(JSON.stringify(seedContracts)).map((c: Record<string, unknown>) => {
  const copy = c as {
    confirmations?: unknown;
    changes: Array<Record<string, unknown>>;
    versions: Array<unknown>;
  };
  delete copy.confirmations;
  copy.changes = copy.changes.map((change) => {
    const next = { ...change };
    delete next.fingerprint;
    delete next.baseline;
    return next;
  });
  return copy;
});
store.set(STORAGE_KEY, JSON.stringify(legacy));
let contracts = await service.listContracts();
check('旧数组格式可读取', contracts.length === 3);
check(
  '缺少基线的差异按首个冻结快照回填',
  contracts[0].changes.every((c) => c.baseline?.source === 'backfilled' && c.baseline.version === '2.7.0'),
);
check('确认历史补齐为空数组', Array.isArray(contracts[0].confirmations));
check(
  '无冻结版本的契约保持无基线',
  contracts[2].changes.every((c) => !c.baseline),
);
check('指纹已补齐', contracts[0].changes.every((c) => typeof c.fingerprint === 'string'));

// 2. 保存定义 → 重算差异
console.log('--- 保存定义重算 ---');
const order = contracts[0];
const modifiedOpenapi = order.openapi.replace('total: { type: "number" }', 'total: { type: "string" }');
const saved = await service.updateContractOpenApi(order.id, modifiedOpenapi);
check('重算识别类型变化', saved.changes.some((c) => c.kind === 'type_changed' && c.target === 'total'));
check(
  '既有结论保留',
  saved.changes.find((c) => c.kind === 'field_added')?.reviewState === 'accepted',
);

// 3. 并发冲突 → 待恢复批次；恢复重放幂等
console.log('--- 并发冲突与恢复 ---');
store.clear();
store.delete(RECOVERY_KEY);
// 模拟两个窗口：同一修订号上交错提交两个写操作
const [first, second] = await Promise.allSettled([
  service.reviewChange('contract-order', seedContracts[0].changes[0].id, 'returned', '评审人A', '窗口A退回'),
  service.reviewChange('contract-payment', seedContracts[1].changes[1].id, 'returned', '评审人B', '窗口B退回'),
]);
const settled = [first, second];
check(
  '并发写只有一个成功',
  settled.filter((s) => s.status === 'fulfilled').length === 1 &&
    settled.filter((s) => s.status === 'rejected').length === 1,
  settled.map((s) => s.status),
);
let batches = await service.listRecoveryBatches();
check('冲突操作进入待恢复批次', batches.length === 1 && batches[0].operations.length === 1, batches);
check('批次标注冲突原因', batches[0]?.reason === '并发保存冲突');

const recovery = await service.recoverPendingBatches();
check('恢复补写 1 项', recovery.recovered === 1, recovery);
check('恢复后无剩余批次', recovery.remaining.length === 0);
contracts = await service.listContracts();
check(
  '两个窗口的评审结论都落库',
  contracts[0].changes[0].reviewState === 'returned' &&
    contracts[1].changes.find((c) => c.kind === 'error_code_added')?.reviewState === 'returned',
  [contracts[0].changes[0].reviewState],
);
// 重复恢复不产生副作用
const again = await service.recoverPendingBatches();
check('重复恢复为空操作', again.recovered === 0);

// 4. 冻结幂等：恢复重放不重复生成版本
console.log('--- 冻结幂等 ---');
store.clear();
store.delete(RECOVERY_KEY);
// 先手工放入一个 freeze 恢复操作，同时该版本已存在（模拟首次写入实际成功但响应失败）
const payment = (await service.listContracts())[1];
await service.freezeVersion(payment.id, '4.2.1', '首次冻结');
store.set(
  RECOVERY_KEY,
  JSON.stringify([
    {
      id: 'batch-manual',
      createdAt: new Date().toISOString(),
      reason: '写入 localStorage 失败',
      operations: [
        {
          id: 'op-1',
          label: '冻结版本',
          contractIds: [payment.id],
          createdAt: new Date().toISOString(),
          attempts: 0,
          payload: { type: 'freeze', contractId: payment.id, version: '4.2.1', notes: '首次冻结' },
        },
        {
          id: 'op-2',
          label: '冻结版本',
          contractIds: [payment.id],
          createdAt: new Date().toISOString(),
          attempts: 0,
          payload: { type: 'freeze', contractId: payment.id, version: '4.2.2', notes: '补充冻结' },
        },
      ],
    },
  ]),
);
const freezeRecovery = await service.recoverPendingBatches();
check('两个冻结操作都完成', freezeRecovery.recovered === 2);
const afterRecover = (await service.listContracts())[1];
check(
  '已存在的 4.2.1 不重复生成',
  afterRecover.versions.filter((v) => v.version === '4.2.1').length === 1,
  afterRecover.versions.map((v) => v.version),
);
check(
  '未完成的 4.2.2 补写成功',
  afterRecover.versions.filter((v) => v.version === '4.2.2').length === 1,
);
check('重复版本号冻结被拒绝', await service.freezeVersion(payment.id, '4.2.1', '重复').then(
  () => false,
  (error: Error) => error.message.includes('已存在'),
));

// 5. 差异组失效：共享调用方确认一起失效，门禁同步阻断
console.log('--- 差异组失效 ---');
store.clear();
store.delete(RECOVERY_KEY);
const beforeInvalidate = await service.listContracts();
const orderBefore = beforeInvalidate.find((c) => c.id === 'contract-order')!;
const gateBefore = models.validateForRelease(orderBefore).filter((i) => i.severity === 'blocker');
check('失效前订单契约无待评审阻断（除既有 pending）', gateBefore.length === 1, gateBefore);

await service.invalidateChangeGroup(
  ['contract-order', 'contract-payment'],
  'field_added',
  '共享调用方 客服工作台 的确认一起失效',
);
const afterInvalidate = await service.listContracts();
const orderAfter = afterInvalidate.find((c) => c.id === 'contract-order')!;
const loyaltyAfter = orderAfter.changes.find((c) => c.kind === 'field_added')!;
check('组内已确认差异重置为待评审', loyaltyAfter.reviewState === 'pending');
check('原确认归档可查', orderAfter.confirmations.some((c) => c.changeId === loyaltyAfter.id && c.reviewState === 'accepted'));
check(
  '归档记录失效原因',
  orderAfter.confirmations[0].reason.includes('共享调用方'),
  orderAfter.confirmations[0].reason,
);
const gateAfter = models.validateForRelease(orderAfter).filter((i) => i.severity === 'blocker');
check('发布门禁同步阻断', gateAfter.some((i) => i.changeId === loyaltyAfter.id));
// 支付契约没有 field_added 差异，不受影响
const paymentAfter = afterInvalidate.find((c) => c.id === 'contract-payment')!;
check(
  '无该组差异的契约不受影响',
  paymentAfter.changes.every((c) => c.reviewState !== 'pending' || c.kind !== 'field_added'),
);
// 恢复重放：组失效幂等
store.set(
  RECOVERY_KEY,
  JSON.stringify([
    {
      id: 'batch-group',
      createdAt: new Date().toISOString(),
      reason: '并发保存冲突',
      operations: [
        {
          id: 'op-g1',
          label: '差异组失效',
          contractIds: ['contract-order'],
          createdAt: new Date().toISOString(),
          attempts: 0,
          payload: {
            type: 'invalidateGroup',
            contractIds: ['contract-order'],
            changeKind: 'field_added',
            reason: '重放',
          },
        },
      ],
    },
  ]),
);
const groupRecovery = await service.recoverPendingBatches();
check('组失效重放完成', groupRecovery.recovered === 1);
const replayed = await service.listContracts();
check(
  '重放不重复归档（目标已是 pending）',
  replayed.find((c) => c.id === 'contract-order')!.confirmations.filter((c) => c.reason === '重放').length === 0,
);

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
