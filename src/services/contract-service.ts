import { seedContracts } from '../data/seed';
import type {
  ApiContract,
  ChangeKind,
  ContractChange,
  ContractVersion,
  ReviewState,
} from '../models/contract';
import { CHANGE_KIND_LABELS, BASELINE_SOURCE_LABELS } from '../models/contract';
import {
  backfillBaselines,
  changeFingerprint,
  reconcileChanges,
  baselineRefOf,
} from '../lib/spec-diff';
import { stableChecksum, formatDateTime } from '../lib/utils';

const STORAGE_KEY = 'pair-wise-gsb-70-contracts';
const RECOVERY_KEY = 'pair-wise-gsb-70-recovery';
const LATENCY = 180;

interface StorageEnvelope {
  revision: number;
  contracts: ApiContract[];
}

/** 写入失败或并发冲突时保留的待恢复操作，可序列化以便跨窗口恢复。 */
export type RecoveryPayload =
  | { type: 'saveContract'; contract: ApiContract }
  | { type: 'updateOpenApi'; contractId: string; openapi: string }
  | {
      type: 'reviewChange';
      contractId: string;
      changeId: string;
      reviewState: ReviewState;
      reviewer: string;
      comment: string;
    }
  | {
      type: 'bulkReview';
      selections: Array<{ contractId: string; changeId: string }>;
      reviewState: ReviewState;
      reviewer: string;
      comment: string;
    }
  | { type: 'addExemption'; contractId: string; changeId: string; reason: string }
  | { type: 'freeze'; contractId: string; version: string; notes: string }
  | { type: 'invalidateGroup'; contractIds: string[]; changeKind: ChangeKind; reason: string };

export interface RecoveryOperation {
  id: string;
  label: string;
  contractIds: string[];
  createdAt: string;
  attempts: number;
  lastError?: string;
  payload: RecoveryPayload;
}

export interface RecoveryBatch {
  id: string;
  createdAt: string;
  reason: string;
  operations: RecoveryOperation[];
}

export class ConcurrentWriteError extends Error {
  constructor() {
    super('检测到其他窗口同时保存，本次修改已保留到待恢复批次');
    this.name = 'ConcurrentWriteError';
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function wait(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, LATENCY));
}

/** 旧数据迁移：数组包成 envelope，补齐确认历史、差异指纹并按首个冻结快照回填基线。 */
function migrateContract(contract: ApiContract): ApiContract {
  const withDefaults: ApiContract = {
    ...contract,
    confirmations: contract.confirmations ?? [],
    changes: contract.changes.map((change) => ({
      ...change,
      fingerprint: change.fingerprint ?? changeFingerprint(change),
    })),
  };
  return backfillBaselines(withDefaults);
}

function readEnvelope(): StorageEnvelope {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as StorageEnvelope | ApiContract[];
      if (Array.isArray(parsed)) {
        return { revision: 1, contracts: parsed.map(migrateContract) };
      }
      if (parsed && Array.isArray(parsed.contracts)) {
        return {
          revision: typeof parsed.revision === 'number' ? parsed.revision : 1,
          contracts: parsed.contracts.map(migrateContract),
        };
      }
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }
  const envelope: StorageEnvelope = { revision: 1, contracts: clone(seedContracts) };
  writeEnvelope(envelope);
  return envelope;
}

function writeEnvelope(envelope: StorageEnvelope): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
}

function readRecoveryBatches(): RecoveryBatch[] {
  const stored = localStorage.getItem(RECOVERY_KEY);
  if (!stored) return [];
  try {
    const parsed = JSON.parse(stored) as RecoveryBatch[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    localStorage.removeItem(RECOVERY_KEY);
    return [];
  }
}

function writeRecoveryBatches(batches: RecoveryBatch[]): void {
  if (batches.length) {
    localStorage.setItem(RECOVERY_KEY, JSON.stringify(batches));
  } else {
    localStorage.removeItem(RECOVERY_KEY);
  }
}

function enqueueRecovery(operation: Omit<RecoveryOperation, 'id' | 'createdAt' | 'attempts'>, reason: string): void {
  const batches = readRecoveryBatches();
  const now = new Date().toISOString();
  batches.unshift({
    id: `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: now,
    reason,
    operations: [{ ...operation, id: `op-${Date.now()}`, createdAt: now, attempts: 0 }],
  });
  writeRecoveryBatches(batches);
}

/**
 * 乐观并发写路径：读取-修改后在写入前校验修订号。
 * 两个窗口同时保存时后写者冲突，操作进入待恢复批次；localStorage 写失败同样保留。
 */
async function transact<T>(
  mutate: (contracts: ApiContract[]) => { next: ApiContract[]; result: T },
  operation: Omit<RecoveryOperation, 'id' | 'createdAt' | 'attempts'>,
): Promise<T> {
  const base = readEnvelope();
  const { next, result } = mutate(clone(base.contracts));
  await wait();
  const current = readEnvelope();
  if (current.revision !== base.revision) {
    enqueueRecovery(operation, '并发保存冲突');
    throw new ConcurrentWriteError();
  }
  try {
    writeEnvelope({ revision: current.revision + 1, contracts: next });
  } catch (error) {
    enqueueRecovery(operation, '写入 localStorage 失败');
    throw error;
  }
  return result;
}

export async function listContracts(): Promise<ApiContract[]> {
  await wait();
  return clone(readEnvelope().contracts);
}

export async function getContract(id: string): Promise<ApiContract | undefined> {
  const contracts = await listContracts();
  return contracts.find((contract) => contract.id === id);
}

export async function listRecoveryBatches(): Promise<RecoveryBatch[]> {
  await wait();
  return readRecoveryBatches();
}

function replaceContract(
  contracts: ApiContract[],
  updated: ApiContract,
): ApiContract[] {
  const exists = contracts.some((contract) => contract.id === updated.id);
  return exists
    ? contracts.map((contract) => (contract.id === updated.id ? updated : contract))
    : [updated, ...contracts];
}

function touch(contract: ApiContract, now: string): ApiContract {
  return { ...contract, updatedAt: now };
}

/** 保存定义时按最近冻结版本重算差异；定义未变化或无基线时保留原清单。 */
function withRecomputedChanges(contract: ApiContract, nextOpenApi: string, now: string): ApiContract {
  if (contract.openapi === nextOpenApi) return contract;
  const reconciled = reconcileChanges(contract, nextOpenApi, now);
  if (!reconciled) {
    return { ...contract, openapi: nextOpenApi };
  }
  const invalidated = reconciled.invalidated > 0;
  return {
    ...contract,
    openapi: nextOpenApi,
    changes: reconciled.changes,
    confirmations: reconciled.confirmations,
    status:
      invalidated && contract.status !== 'draft' && contract.status !== 'frozen'
        ? 'review'
        : contract.status,
  };
}

function applySaveContract(contracts: ApiContract[], updated: ApiContract, now: string): ApiContract[] {
  const existing = contracts.find((contract) => contract.id === updated.id);
  let next: ApiContract = { ...updated, confirmations: updated.confirmations ?? [] };
  if (existing && existing.openapi !== updated.openapi) {
    // 定义发生变化：以调用方提交的内容为准，但差异清单按冻结基线重算
    const recomputed = withRecomputedChanges(existing, updated.openapi, now);
    next = {
      ...next,
      openapi: recomputed.openapi,
      changes: recomputed.changes,
      confirmations: recomputed.confirmations,
      status: recomputed.status,
    };
  }
  return replaceContract(contracts, touch(next, now));
}

function applyUpdateOpenApi(
  contracts: ApiContract[],
  contractId: string,
  openapi: string,
  now: string,
): ApiContract[] {
  const contract = contracts.find((item) => item.id === contractId);
  if (!contract) throw new Error('契约不存在');
  return replaceContract(contracts, touch(withRecomputedChanges(contract, openapi, now), now));
}

function applyReviewChange(
  contracts: ApiContract[],
  contractId: string,
  changeId: string,
  reviewState: ReviewState,
  reviewer: string,
  comment: string,
  now: string,
): ApiContract[] {
  const contract = contracts.find((item) => item.id === contractId);
  if (!contract) throw new Error('契约不存在');
  const updated: ApiContract = {
    ...contract,
    status: contract.status === 'draft' ? 'review' : contract.status,
    changes: contract.changes.map((change) =>
      change.id === changeId
        ? { ...change, reviewState, reviewer, reviewComment: comment, reviewedAt: now }
        : change,
    ),
  };
  return replaceContract(contracts, touch(updated, now));
}

function applyBulkReview(
  contracts: ApiContract[],
  selections: Array<{ contractId: string; changeId: string }>,
  reviewState: ReviewState,
  reviewer: string,
  comment: string,
  now: string,
): ApiContract[] {
  const selected = new Set(selections.map((item) => `${item.contractId}:${item.changeId}`));
  return contracts.map((contract) => {
    if (!contract.changes.some((change) => selected.has(`${contract.id}:${change.id}`))) {
      return contract;
    }
    return touch(
      {
        ...contract,
        status: contract.status === 'draft' ? 'review' : contract.status,
        changes: contract.changes.map((change) =>
          selected.has(`${contract.id}:${change.id}`)
            ? { ...change, reviewState, reviewer, reviewComment: comment, reviewedAt: now }
            : change,
        ),
      },
      now,
    );
  });
}

function applyAddExemption(
  contracts: ApiContract[],
  contractId: string,
  changeId: string,
  reason: string,
  now: string,
): ApiContract[] {
  const contract = contracts.find((item) => item.id === contractId);
  if (!contract) throw new Error('契约不存在');
  const exemption = {
    id: `ex-${Date.now()}`,
    changeId,
    scope: contract.changes.find((item) => item.id === changeId)?.path ?? '未指定',
    reason,
    approvedBy: '当前评审人',
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  };
  const updated: ApiContract = {
    ...contract,
    exemptions: [...contract.exemptions, exemption],
    changes: contract.changes.map((change) =>
      change.id === changeId ? { ...change, reviewState: 'exemption' } : change,
    ),
  };
  return replaceContract(contracts, touch(updated, now));
}

/** 冻结正式版本。重复版本号直接拒绝，恢复重放时按版本号去重，不重复生成版本。 */
function applyFreeze(
  contracts: ApiContract[],
  contractId: string,
  version: string,
  notes: string,
  now: string,
): ApiContract[] {
  const contract = contracts.find((item) => item.id === contractId);
  if (!contract) throw new Error('契约不存在');
  if (contract.versions.some((release) => release.version === version)) {
    throw new Error(`版本 v${version} 已存在，未重复生成`);
  }

  const release: ContractVersion = {
    id: `ver-${Date.now()}`,
    contractId,
    version,
    releasedAt: now,
    checksum: stableChecksum(contract.openapi),
    notes,
    changeIds: contract.changes.map((change) => change.id),
    openapi: contract.openapi,
    baseline: contract.versions[0] ? baselineRefOf(contract.versions[0]) : undefined,
  };
  const updated = backfillBaselines({
    ...contract,
    version,
    status: 'frozen',
    versions: [release, ...contract.versions],
  });
  return replaceContract(contracts, touch(updated, now));
}

/** 发布中心差异组失效：共享调用方对某组差异的确认一起失效，原确认归档可查。 */
function applyInvalidateGroup(
  contracts: ApiContract[],
  contractIds: string[],
  changeKind: ChangeKind,
  reason: string,
  now: string,
): ApiContract[] {
  const targets = new Set(contractIds);
  return contracts.map((contract) => {
    if (!targets.has(contract.id)) return contract;
    const invalidated = contract.changes.filter(
      (change) => change.kind === changeKind && change.reviewState !== 'pending',
    );
    if (!invalidated.length) return contract;
    const confirmations = [
      ...invalidated.map((change) => ({
        id: `cnf-${stableChecksum([change.id, change.reviewState, now].join('|'))}`,
        changeId: change.id,
        path: change.path,
        method: change.method,
        kind: change.kind,
        reviewState: change.reviewState,
        reviewer: change.reviewer,
        comment: change.reviewComment,
        impactStatement: change.impactStatement,
        migrationPlan: change.migrationPlan,
        fingerprint: change.fingerprint ?? changeFingerprint(change),
        confirmedAt: change.reviewedAt ?? now,
        invalidatedAt: now,
        reason,
      })),
      ...contract.confirmations,
    ];
    return touch(
      {
        ...contract,
        status: contract.status === 'ready' || contract.status === 'released' ? 'review' : contract.status,
        confirmations,
        changes: contract.changes.map((change) =>
          change.kind === changeKind && change.reviewState !== 'pending'
            ? { ...change, reviewState: 'pending' as const, reviewer: '', reviewComment: '', reviewedAt: undefined }
            : change,
        ),
      },
      now,
    );
  });
}

export async function saveContract(updated: ApiContract): Promise<ApiContract> {
  const now = new Date().toISOString();
  return transact(
    (contracts) => {
      const next = applySaveContract(contracts, updated, now);
      return {
        next,
        result: clone(next.find((contract) => contract.id === updated.id) ?? updated),
      };
    },
    {
      label: `保存契约 · ${updated.name}`,
      contractIds: [updated.id],
      payload: { type: 'saveContract', contract: updated },
    },
  );
}

export async function reviewChange(
  contractId: string,
  changeId: string,
  reviewState: ReviewState,
  reviewer: string,
  comment: string,
): Promise<ApiContract> {
  const now = new Date().toISOString();
  return transact(
    (contracts) => {
      const next = applyReviewChange(
        contracts,
        contractId,
        changeId,
        reviewState,
        reviewer,
        comment,
        now,
      );
      const saved = next.find((contract) => contract.id === contractId);
      if (!saved) throw new Error('契约不存在');
      return { next, result: clone(saved) };
    },
    {
      label: `评审变更 · ${contractId}`,
      contractIds: [contractId],
      payload: { type: 'reviewChange', contractId, changeId, reviewState, reviewer, comment },
    },
  );
}

export async function bulkReviewChanges(
  selections: Array<{ contractId: string; changeId: string }>,
  reviewState: ReviewState,
  reviewer: string,
  comment: string,
): Promise<ApiContract[]> {
  const now = new Date().toISOString();
  const contractIds = [...new Set(selections.map((item) => item.contractId))];
  return transact(
    (contracts) => {
      const next = applyBulkReview(contracts, selections, reviewState, reviewer, comment, now);
      return { next, result: clone(next) };
    },
    {
      label: `批量评审 · ${selections.length} 项`,
      contractIds,
      payload: { type: 'bulkReview', selections, reviewState, reviewer, comment },
    },
  );
}

export async function updateContractOpenApi(
  contractId: string,
  openapi: string,
): Promise<ApiContract> {
  const now = new Date().toISOString();
  return transact(
    (contracts) => {
      const next = applyUpdateOpenApi(contracts, contractId, openapi, now);
      const saved = next.find((contract) => contract.id === contractId);
      if (!saved) throw new Error('契约不存在');
      return { next, result: clone(saved) };
    },
    {
      label: `保存定义 · ${contractId}`,
      contractIds: [contractId],
      payload: { type: 'updateOpenApi', contractId, openapi },
    },
  );
}

export async function addExemption(
  contractId: string,
  changeId: string,
  reason: string,
): Promise<ApiContract> {
  const now = new Date().toISOString();
  return transact(
    (contracts) => {
      const next = applyAddExemption(contracts, contractId, changeId, reason, now);
      const saved = next.find((contract) => contract.id === contractId);
      if (!saved) throw new Error('契约不存在');
      return { next, result: clone(saved) };
    },
    {
      label: `登记豁免 · ${contractId}`,
      contractIds: [contractId],
      payload: { type: 'addExemption', contractId, changeId, reason },
    },
  );
}

export async function freezeVersion(
  contractId: string,
  version: string,
  notes: string,
): Promise<ApiContract> {
  const now = new Date().toISOString();
  return transact(
    (contracts) => {
      const next = applyFreeze(contracts, contractId, version, notes, now);
      const saved = next.find((contract) => contract.id === contractId);
      if (!saved) throw new Error('契约不存在');
      return { next, result: clone(saved) };
    },
    {
      label: `冻结版本 · ${contractId} v${version}`,
      contractIds: [contractId],
      payload: { type: 'freeze', contractId, version, notes },
    },
  );
}

export async function invalidateChangeGroup(
  contractIds: string[],
  changeKind: ChangeKind,
  reason: string,
): Promise<ApiContract[]> {
  const now = new Date().toISOString();
  return transact(
    (contracts) => {
      const next = applyInvalidateGroup(contracts, contractIds, changeKind, reason, now);
      return { next, result: clone(next) };
    },
    {
      label: `差异组失效 · ${CHANGE_KIND_LABELS[changeKind]}`,
      contractIds,
      payload: { type: 'invalidateGroup', contractIds, changeKind, reason },
    },
  );
}

/**
 * 重放待恢复批次：只补未完成契约，不重复生成版本。
 * 每个操作按当前状态判断幂等，已生效的跳过，未完成的补写。
 */
export async function recoverPendingBatches(): Promise<{
  recovered: number;
  remaining: RecoveryBatch[];
}> {
  await wait();
  const batches = readRecoveryBatches();
  if (!batches.length) return { recovered: 0, remaining: [] };

  const envelope = readEnvelope();
  let contracts = clone(envelope.contracts);
  let recovered = 0;
  const now = new Date().toISOString();
  const remaining: RecoveryBatch[] = [];

  for (const batch of batches) {
    const pending: RecoveryOperation[] = [];
    for (const operation of batch.operations) {
      try {
        const outcome = replayOperation(contracts, operation.payload, now);
        contracts = outcome;
        recovered += 1;
      } catch (error) {
        pending.push({
          ...operation,
          attempts: operation.attempts + 1,
          lastError: error instanceof Error ? error.message : '恢复失败',
        });
      }
    }
    if (pending.length) remaining.push({ ...batch, operations: pending });
  }

  writeEnvelope({ revision: envelope.revision + 1, contracts });
  writeRecoveryBatches(remaining);
  return { recovered, remaining };
}

function replayOperation(
  contracts: ApiContract[],
  payload: RecoveryPayload,
  now: string,
): ApiContract[] {
  switch (payload.type) {
    case 'saveContract':
      return applySaveContract(contracts, payload.contract, now);
    case 'updateOpenApi': {
      const contract = contracts.find((item) => item.id === payload.contractId);
      if (!contract) throw new Error('契约不存在');
      if (contract.openapi === payload.openapi) return contracts;
      return applyUpdateOpenApi(contracts, payload.contractId, payload.openapi, now);
    }
    case 'reviewChange': {
      const contract = contracts.find((item) => item.id === payload.contractId);
      const change = contract?.changes.find((item) => item.id === payload.changeId);
      if (
        change &&
        change.reviewState === payload.reviewState &&
        change.reviewer === payload.reviewer &&
        change.reviewComment === payload.comment
      ) {
        return contracts;
      }
      return applyReviewChange(
        contracts,
        payload.contractId,
        payload.changeId,
        payload.reviewState,
        payload.reviewer,
        payload.comment,
        now,
      );
    }
    case 'bulkReview': {
      const unfinished = payload.selections.filter((selection) => {
        const contract = contracts.find((item) => item.id === selection.contractId);
        const change = contract?.changes.find((item) => item.id === selection.changeId);
        return !change || change.reviewState !== payload.reviewState;
      });
      if (!unfinished.length) return contracts;
      return applyBulkReview(
        contracts,
        unfinished,
        payload.reviewState,
        payload.reviewer,
        payload.comment,
        now,
      );
    }
    case 'addExemption': {
      const contract = contracts.find((item) => item.id === payload.contractId);
      if (
        contract?.exemptions.some(
          (item) => item.changeId === payload.changeId && item.reason === payload.reason,
        )
      ) {
        return contracts;
      }
      return applyAddExemption(contracts, payload.contractId, payload.changeId, payload.reason, now);
    }
    case 'freeze': {
      const contract = contracts.find((item) => item.id === payload.contractId);
      if (!contract) throw new Error('契约不存在');
      if (contract.versions.some((release) => release.version === payload.version)) {
        return contracts;
      }
      return applyFreeze(contracts, payload.contractId, payload.version, payload.notes, now);
    }
    case 'invalidateGroup': {
      const hasUnfinished = contracts.some(
        (contract) =>
          payload.contractIds.includes(contract.id) &&
          contract.changes.some(
            (change) => change.kind === payload.changeKind && change.reviewState !== 'pending',
          ),
      );
      if (!hasUnfinished) return contracts;
      return applyInvalidateGroup(
        contracts,
        payload.contractIds,
        payload.changeKind,
        payload.reason,
        now,
      );
    }
  }
}

export function generateExampleRequest(contract: ApiContract, change?: ContractChange): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contract.openapi);
  } catch {
    parsed = null;
  }
  const openapi = parsed as
    | {
        paths?: Record<string, Record<string, { summary?: string }>>;
      }
    | null;
  const candidates = openapi?.paths ? Object.entries(openapi.paths) : [];
  const selectedPath = change?.path ?? candidates[0]?.[0] ?? '/resource';
  const selectedMethod = (
    change?.method ??
    (candidates[0]?.[1] ? Object.keys(candidates[0][1])[0] : 'get')
  ).toUpperCase();
  const fields = change
    ? [change.after.replace(/^新增|移除|变为/g, '').trim()]
    : ['orderId: ORD-20260929-001', 'requestId: req-local-demo'];

  return JSON.stringify(
    {
      method: selectedMethod,
      url: `https://api.example.com${selectedPath.replace('{orderId}', 'ORD-20260929-001').replace('{paymentId}', 'PAY-90218').replace('{userId}', 'U-1024')}`,
      headers: {
        Authorization: 'Bearer <token>',
        'X-Client-Version': contract.version,
      },
      body:
        selectedMethod === 'GET'
          ? undefined
          : Object.fromEntries(
              fields.map((field) => {
                const [key, value] = field.split(':').map((item) => item.trim());
                return [key || 'field', value || 'value'];
              }),
            ),
    },
    null,
    2,
  );
}

function describeBaseline(contract: ApiContract): string {
  const baselines = new Map<string, { version: string; checksum: string; source: string }>();
  contract.changes.forEach((change) => {
    if (change.baseline) {
      baselines.set(change.baseline.versionId, {
        version: change.baseline.version,
        checksum: change.baseline.checksum,
        source: BASELINE_SOURCE_LABELS[change.baseline.source],
      });
    }
  });
  if (!baselines.size) return '无（差异清单未与冻结基线核对）';
  return [...baselines.values()]
    .map((item) => `v${item.version}（${item.source}，校验值 ${item.checksum}）`)
    .join('；');
}

export function buildChangeReport(contract: ApiContract): string {
  const lines = [
    `# ${contract.name} ${contract.version} 契约变更报告`,
    '',
    `- 领域：${contract.domain}`,
    `- 负责人：${contract.owner}`,
    `- 状态：${contract.status}`,
    `- 比较基线：${describeBaseline(contract)}`,
    `- 生成时间：${new Date().toISOString()}`,
    '',
    '## 变更明细',
    ...contract.changes.flatMap((change) => [
      `### ${change.method} ${change.path} - ${change.kind}`,
      `- 兼容性：${change.compatibility}`,
      `- 变更前：${change.before}`,
      `- 变更后：${change.after}`,
      `- 判定依据：${change.rationale}`,
      `- 比较基线：${change.baseline ? `v${change.baseline.version}（${BASELINE_SOURCE_LABELS[change.baseline.source]}）` : '未核对'}`,
      `- 调用方影响：${change.impactStatement || '未填写'}`,
      `- 迁移方案：${change.migrationPlan || '未填写'}`,
      `- 评审结论：${change.reviewState}`,
      '',
    ]),
    '## 调用方',
    ...contract.consumers.map(
      (consumer) =>
        `- ${consumer.name} / ${consumer.owner} / ${consumer.environment} / ${consumer.clientVersion}`,
    ),
    '',
    '## 豁免记录',
    ...(contract.exemptions.length
      ? contract.exemptions.map(
          (item) => `- ${item.scope}：${item.reason}（至 ${item.expiresAt}）`,
        )
      : ['- 无']),
    '',
    '## 失效确认记录',
    ...(contract.confirmations.length
      ? contract.confirmations.map(
          (item) =>
            `- ${item.method} ${item.path}（${CHANGE_KIND_LABELS[item.kind]}）：原结论 ${item.reviewState} · ${item.reviewer || '未指定'}，${item.reason}（${formatDateTime(item.invalidatedAt)}）`,
        )
      : ['- 无']),
  ];
  return lines.join('\n');
}

export function diffVersionSummary(contract: ApiContract): string {
  const previous = contract.versions[0];
  if (!previous) {
    return '无可比较的历史正式版本，差异清单未与冻结基线核对。';
  }
  const baseline = contract.changes.find((change) => change.baseline)?.baseline;
  return [
    `上一版 ${previous.version}`,
    `发布于 ${formatDateTime(previous.releasedAt)}`,
    `校验值 ${previous.checksum}`,
    `本版变更 ${contract.changes.length} 项`,
    baseline
      ? `差异基线 v${baseline.version}（${BASELINE_SOURCE_LABELS[baseline.source]}）`
      : '差异基线未核对',
  ].join('\n');
}
