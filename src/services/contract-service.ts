import { seedContracts } from '../data/seed';
import { CHANGE_KIND_LABELS } from '../models/contract';
import type {
  ApiContract,
  ConsumerConfirmation,
  ConsumerConfirmationState,
  ContractChange,
  ContractVersion,
  ReviewState,
} from '../models/contract';
import { stableChecksum, formatDateTime } from '../lib/utils';
import {
  catalogSyncStatus,
  migrateContract,
  reconcileContractChanges,
} from '../lib/reconciliation';
import { parseOpenApiDefinition } from '../lib/field-diff';

const STORAGE_KEY = 'pair-wise-gsb-70-contracts';
const BATCH_STORAGE_KEY = 'pair-wise-gsb-70-freeze-batches';
const FAIL_NEXT_FREEZE_KEY = 'pair-wise-gsb-70-fail-next-freeze';
const LATENCY = 180;

export interface FreezeBatchItem {
  contractId: string;
  contractName: string;
  version: string;
  notes: string;
  status: 'pending' | 'completed' | 'failed';
  versionId?: string;
  error?: string;
  attempts: number;
}

export interface FreezeBatch {
  id: string;
  createdAt: string;
  createdBy: string;
  status: 'in_progress' | 'completed' | 'failed';
  items: FreezeBatchItem[];
  lastError?: string;
}

export class RevisionConflictError extends Error {
  contractId: string;
  constructor(contractId: string) {
    super('契约已在其他窗口保存，请刷新后基于最新版本重试。');
    this.name = 'RevisionConflictError';
    this.contractId = contractId;
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function wait(ms = LATENCY): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/* -------------------------------- 持久化层 -------------------------------- */

function loadRawContracts(): ApiContract[] {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as Array<Partial<ApiContract>>;
      return parsed.map(migrateContract);
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }
  const seeded = seedContracts.map(migrateContract);
  persistContracts(seeded);
  return seeded;
}

let cachedContracts: ApiContract[] | null = null;

function readContracts(): ApiContract[] {
  if (!cachedContracts) {
    cachedContracts = loadRawContracts();
  }
  return cachedContracts;
}

function persistContracts(contracts: ApiContract[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(contracts));
  cachedContracts = contracts;
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY && event.newValue) {
      try {
        cachedContracts = (JSON.parse(event.newValue) as Array<Partial<ApiContract>>).map(
          migrateContract,
        );
      } catch {
        cachedContracts = null;
      }
    }
    if (event.key === STORAGE_KEY) {
      window.dispatchEvent(new CustomEvent('pair-wise:contracts-storage'));
    }
    if (event.key === BATCH_STORAGE_KEY) {
      window.dispatchEvent(new CustomEvent('pair-wise:batches-storage'));
    }
  });
}

export async function listContracts(): Promise<ApiContract[]> {
  await wait(60);
  return clone(readContracts());
}

export async function getContract(id: string): Promise<ApiContract | undefined> {
  await wait(60);
  return readContracts().find((contract) => contract.id === id);
}

function assertRevision(contract: ApiContract, expectedRevision?: number) {
  if (typeof expectedRevision === 'number' && contract.revision !== expectedRevision) {
    throw new RevisionConflictError(contract.id);
  }
}

export async function saveContract(
  updated: ApiContract,
  expectedRevision?: number,
): Promise<ApiContract> {
  const contracts = readContracts();
  const index = contracts.findIndex((contract) => contract.id === updated.id);
  if (index >= 0) assertRevision(contracts[index], expectedRevision);
  const bumped: ApiContract = {
    ...updated,
    revision: (index >= 0 ? contracts[index].revision : updated.revision || 1) + 1,
    updatedAt: new Date().toISOString(),
  };
  const next =
    index >= 0
      ? contracts.map((contract) => (contract.id === updated.id ? bumped : contract))
      : [bumped, ...contracts];
  persistContracts(next);
  await wait();
  return clone(bumped);
}

export async function reviewChange(
  contractId: string,
  changeId: string,
  reviewState: ReviewState,
  reviewer: string,
  comment: string,
): Promise<ApiContract> {
  const contracts = readContracts();
  const contract = requireContract(contracts, contractId);
  const updated = applyReview(contract, changeId, reviewState, reviewer, comment);
  persistContracts(
    contracts.map((item) => (item.id === contractId ? bumpRevision(updated) : item)),
  );
  await wait();
  return clone(updated);
}

function applyReview(
  contract: ApiContract,
  changeId: string,
  reviewState: ReviewState,
  reviewer: string,
  comment: string,
): ApiContract {
  return {
    ...contract,
    status: contract.status === 'draft' ? 'review' : contract.status,
    changes: contract.changes.map((change) => {
      if (change.id !== changeId) return change;
      const reviewedAt = new Date().toISOString();
      const history =
        change.reviewState !== 'pending' && change.reviewedAt
          ? [
              ...change.reviewHistory,
              {
                id: `hist-${change.id}-${Date.now()}`,
                reviewState: change.reviewState,
                reviewer: change.reviewer,
                reviewComment: change.reviewComment,
                reviewedAt: change.reviewedAt,
                invalidatedReason: '评审结论被新结论覆盖，历史记录保留。',
              },
            ]
          : change.reviewHistory;
      return {
        ...change,
        reviewState,
        reviewer,
        reviewComment: comment,
        reviewedAt,
        // 对失效差异重新给出结论即视为重新确认；重新填写的影响/迁移说明已在调用方单独保存。
        staleReason: undefined,
        reviewHistory: history,
      };
    }),
  };
}

export async function bulkReviewChanges(
  selections: Array<{ contractId: string; changeId: string }>,
  reviewState: ReviewState,
  reviewer: string,
  comment: string,
): Promise<ApiContract[]> {
  const contracts = readContracts();
  const selected = new Set(selections.map((item) => `${item.contractId}:${item.changeId}`));
  const updated = contracts.map((contract) => {
    const hasSelection = contract.changes.some((change) =>
      selected.has(`${contract.id}:${change.id}`),
    );
    if (!hasSelection) return contract;
    let next = contract;
    if (contract.status === 'draft') {
      next = { ...next, status: 'review' };
    }
    for (const change of contract.changes) {
      if (selected.has(`${contract.id}:${change.id}`)) {
        next = applyReview(next, change.id, reviewState, reviewer, comment);
      }
    }
    return bumpRevision(next);
  });
  persistContracts(updated);
  await wait();
  return clone(updated);
}

/**
 * 保存接口定义：以冻结版本为比较基线重算字段差异。
 * 共享调用方在任意关联契约上的确认会一起失效；其他窗口同时保存时乐观锁阻断后写者。
 */
export async function updateContractOpenApi(
  contractId: string,
  openapi: string,
  expectedRevision?: number,
): Promise<{ contract: ApiContract; added: number; invalidated: number }> {
  const parsed = parseOpenApiDefinition(openapi);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  const contracts = readContracts();
  const contract = requireContract(contracts, contractId);
  assertRevision(contract, expectedRevision);

  const result = reconcileContractChanges(contract, openapi);
  if (result.parseError) {
    throw new Error(result.parseError);
  }
  const reconciled = bumpRevision({
    ...result.contract,
    status: contract.status === 'draft' ? 'review' : contract.status,
  });

  // 共享调用方：本次重算失效/新增的差异所持确认，跨契约一起失效。
  const touchedChangeIds = new Set<string>([
    ...result.archivedChanges.map((change) => change.id),
    ...result.createdChanges.map((change) => change.id),
  ]);
  const affectedConsumers = new Set<string>();
  const collectFrom = (changes: ContractChange[]) => {
    changes.forEach((change) => {
      if (!touchedChangeIds.has(change.id)) return;
      change.consumerConfirmations.forEach((confirmation) => {
        if (!confirmation.invalidated) affectedConsumers.add(confirmation.consumerId);
      });
    });
  };
  collectFrom(result.contract.changes);
  collectFrom(result.archivedChanges);

  let cascadeReason = '';
  if (affectedConsumers.size) {
    // 仅保留真正跨契约共享的调用方。
    const sharedIds = new Set(
      [...affectedConsumers].filter((consumerId) => {
        const owner = result.contract.consumers.find((item) => item.id === consumerId);
        if (!owner) return false;
        return contracts.some(
          (other) =>
            other.id !== contractId &&
            other.consumers.some((item) => item.id === consumerId || item.name === owner.name),
        );
      }),
    );
    affectedConsumers.clear();
    sharedIds.forEach((id) => affectedConsumers.add(id));
    cascadeReason = `关联契约「${contract.name}」保存定义后差异重算，共享调用方的确认同步失效，需要重新确认。`;
  }

  // 本契约：归档差异上的确认同样标记失效（原记录保留可查）。
  const localReason = `契约「${contract.name}」保存定义后差异重算，原调用方确认失效，需要重新确认。`;
  let reconciledValue = reconciled;
  if (touchedChangeIds.size) {
    const marked = invalidateArchivedConfirmations(reconciledValue, touchedChangeIds, localReason);
    if (marked) reconciledValue = marked;
  }

  const nextContracts = contracts.map((item) => {
    if (item.id === contractId) return reconciledValue;
    if (!affectedConsumers.size) return item;
    const cascaded = invalidateConsumerConfirmations(item, affectedConsumers, cascadeReason);
    return cascaded === item ? item : bumpRevision(cascaded);
  });
  persistContracts(nextContracts);
  await wait();
  return {
    contract: clone(reconciledValue),
    added: result.added,
    invalidated: result.invalidated,
  };
}

function invalidateArchivedConfirmations(
  contract: ApiContract,
  changeIds: Set<string>,
  reason: string,
): ApiContract | null {
  let touched = false;
  const archivedChanges = contract.archivedChanges.map((change) => {
    if (!changeIds.has(change.id) || !change.consumerConfirmations.some((item) => !item.invalidated)) {
      return change;
    }
    touched = true;
    return {
      ...change,
      consumerConfirmations: change.consumerConfirmations.map((confirmation) =>
        confirmation.invalidated
          ? confirmation
          : {
              ...confirmation,
              invalidated: true,
              invalidatedReason: reason,
              invalidatedAt: new Date().toISOString(),
            },
      ),
    };
  });
  return touched ? { ...contract, archivedChanges } : null;
}

/** 立即按当前基线重新比对一次（“重新计算差异”按钮）。 */
export async function recalculateChanges(
  contractId: string,
): Promise<{ contract: ApiContract; added: number; invalidated: number }> {
  const contracts = readContracts();
  const contract = requireContract(contracts, contractId);
  const result = reconcileContractChanges(contract, contract.openapi);
  if (result.parseError) throw new Error(result.parseError);
  if (result.added === 0 && result.invalidated === 0) {
    return { contract: clone(contract), added: 0, invalidated: 0 };
  }
  const reconciled = bumpRevision(result.contract);
  persistContracts(
    contracts.map((item) => (item.id === contractId ? reconciled : item)),
  );
  await wait();
  return { contract: clone(reconciled), added: result.added, invalidated: result.invalidated };
}

function invalidateConsumerConfirmations(
  contract: ApiContract,
  consumerIds: Set<string>,
  reason: string,
): ApiContract {
  let touched = false;
  const changes = contract.changes.map((change) => {
    let changeTouched = false;
    const confirmations = change.consumerConfirmations.map((confirmation) => {
      if (consumerIds.has(confirmation.consumerId) && !confirmation.invalidated) {
        changeTouched = true;
        return {
          ...confirmation,
          invalidated: true,
          invalidatedReason: reason,
          invalidatedAt: new Date().toISOString(),
        };
      }
      return confirmation;
    });
    if (changeTouched) touched = true;
    return changeTouched ? { ...change, consumerConfirmations: confirmations } : change;
  });
  return touched ? { ...contract, changes } : contract;
}

export async function confirmConsumerChange(input: {
  contractId: string;
  changeId: string;
  consumerId: string;
  state: ConsumerConfirmationState;
  note: string;
  reviewer: string;
}): Promise<ApiContract> {
  const contracts = readContracts();
  const contract = requireContract(contracts, input.contractId);
  const consumer = contract.consumers.find((item) => item.id === input.consumerId);
  if (!consumer) throw new Error('调用方不存在');
  const confirmation: ConsumerConfirmation = {
    id: `cc-${Date.now()}-${input.consumerId}`,
    consumerId: consumer.id,
    consumerName: consumer.name,
    state: input.state,
    note: input.note,
    confirmedBy: input.reviewer,
    confirmedAt: new Date().toISOString(),
  };
  const updated: ApiContract = {
    ...contract,
    changes: contract.changes.map((change) =>
      change.id === input.changeId
        ? {
            ...change,
            consumerConfirmations: [
              ...change.consumerConfirmations.filter(
                (item) => item.consumerId !== input.consumerId,
              ),
              confirmation,
            ],
          }
        : change,
    ),
  };
  persistContracts(
    contracts.map((item) => (item.id === input.contractId ? bumpRevision(updated) : item)),
  );
  await wait();
  return clone(updated);
}

export async function addExemption(
  contractId: string,
  changeId: string,
  reason: string,
): Promise<ApiContract> {
  const contracts = readContracts();
  const contract = requireContract(contracts, contractId);
  const exemption = {
    id: `ex-${Date.now()}`,
    changeId,
    scope: contract.changes.find((item) => item.id === changeId)?.path ?? '未指定',
    reason,
    approvedBy: '当前评审人',
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  };
  const updated = bumpRevision({
    ...contract,
    exemptions: [...contract.exemptions, exemption],
    changes: contract.changes.map((change) =>
      change.id === changeId ? { ...change, reviewState: 'exemption' } : change,
    ),
  });
  persistContracts(contracts.map((item) => (item.id === contractId ? updated : item)));
  await wait();
  return clone(updated);
}

/* ------------------------------ 版本冻结/批次 ------------------------------ */

export function getCatalogSync(contract: ApiContract) {
  return catalogSyncStatus(contract);
}

export function setFailNextFreeze(enabled: boolean): void {
  if (enabled) {
    localStorage.setItem(FAIL_NEXT_FREEZE_KEY, '1');
  } else {
    localStorage.removeItem(FAIL_NEXT_FREEZE_KEY);
  }
}

export function isFailNextFreezeArmed(): boolean {
  return localStorage.getItem(FAIL_NEXT_FREEZE_KEY) === '1';
}

function loadBatches(): FreezeBatch[] {
  const stored = localStorage.getItem(BATCH_STORAGE_KEY);
  if (!stored) return [];
  try {
    return JSON.parse(stored) as FreezeBatch[];
  } catch {
    return [];
  }
}

function persistBatches(batches: FreezeBatch[]): void {
  localStorage.setItem(BATCH_STORAGE_KEY, JSON.stringify(batches));
}

export function listFreezeBatches(): FreezeBatch[] {
  return loadBatches().sort(
    (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
}

export function deleteFreezeBatch(batchId: string): void {
  persistBatches(loadBatches().filter((batch) => batch.id !== batchId));
  window.dispatchEvent(new CustomEvent('pair-wise:batches-storage'));
}

export interface FreezeInput {
  contractId: string;
  version: string;
  notes: string;
}

/** 创建并执行多契约冻结批次；失败时批次保留，等待“继续未完成契约”。 */
export async function createFreezeBatch(
  inputs: FreezeInput[],
  createdBy = '当前评审人',
): Promise<FreezeBatch> {
  const contracts = readContracts();
  const batch: FreezeBatch = {
    id: `batch-${Date.now()}`,
    createdAt: new Date().toISOString(),
    createdBy,
    status: 'in_progress',
    items: inputs.map((input) => {
      const contract = contracts.find((item) => item.id === input.contractId);
      return {
        contractId: input.contractId,
        contractName: contract?.name ?? input.contractId,
        version: input.version,
        notes: input.notes,
        status: 'pending',
        attempts: 0,
      };
    }),
  };
  persistBatches([batch, ...loadBatches()]);
  return runFreezeBatch(batch.id, true);
}

function consumeFailureInjection(): boolean {
  if (isFailNextFreezeArmed()) {
    localStorage.removeItem(FAIL_NEXT_FREEZE_KEY);
    return true;
  }
  return false;
}

export async function resumeFreezeBatch(batchId: string): Promise<FreezeBatch> {
  return runFreezeBatch(batchId, false);
}

async function runFreezeBatch(batchId: string, allowInjectedFailure: boolean): Promise<FreezeBatch> {
  let batch = requireBatch(batchId);
  const contracts = readContracts();

  for (const item of batch.items) {
    if (item.status === 'completed') continue;
    item.attempts += 1;
    try {
      const contract = requireContract(contracts, item.contractId);

      // 幂等：目标版本已冻结过（另一窗口抢先完成），只登记结果，不重复生成版本。
      const already = contract.versions.find(
        (version) => version.version === item.version.trim(),
      );
      if (already) {
        item.status = 'completed';
        item.versionId = already.id;
        persistBatches(updateStoredBatch(batch));
        continue;
      }

      if (allowInjectedFailure && consumeFailureInjection()) {
        throw new Error('模拟写入失败：本地存储暂不可用（用于演示失败恢复）');
      }

      const frozen = freezeContract(contract, item.version.trim(), item.notes);
      const index = contracts.findIndex((entry) => entry.id === item.contractId);
      contracts[index] = frozen;
      persistContracts([...contracts]);
      item.status = 'completed';
      item.versionId = frozen.versions[0]?.id;
      item.error = undefined;
      persistBatches(updateStoredBatch(batch));
    } catch (error) {
      item.status = 'failed';
      item.error = error instanceof Error ? error.message : '冻结失败';
      batch.status = 'failed';
      batch.lastError = item.error;
      persistBatches(updateStoredBatch(batch));
      await wait();
      return clone(batch);
    }
  }

  batch.status = batch.items.every((item) => item.status === 'completed')
    ? 'completed'
    : 'failed';
  persistBatches(updateStoredBatch(batch));
  await wait();
  return clone(batch);
}

function updateStoredBatch(batch: FreezeBatch): FreezeBatch[] {
  return loadBatches().map((stored) => (stored.id === batch.id ? clone(batch) : stored));
}

function requireBatch(batchId: string): FreezeBatch {
  const batch = loadBatches().find((item) => item.id === batchId);
  if (!batch) throw new Error('冻结批次不存在');
  return clone(batch);
}

/** 单契约冻结：详情页沿用，内部直接落盘并复用同一套冻结规则。 */
export async function freezeVersion(
  contractId: string,
  version: string,
  notes: string,
): Promise<ApiContract> {
  const contracts = readContracts();
  const contract = requireContract(contracts, contractId);
  if (contract.versions.some((item) => item.version === version.trim())) {
    throw new Error(`版本 ${version} 已冻结，不能重复生成。`);
  }
  const frozen = freezeContract(contract, version.trim(), notes);
  persistContracts(
    contracts.map((item) => (item.id === contractId ? frozen : item)),
  );
  await wait();
  return clone(frozen);
}

function freezeContract(contract: ApiContract, version: string, notes: string): ApiContract {
  const release: ContractVersion = {
    id: `ver-${Date.now()}-${stableChecksum(contract.openapi + version).slice(0, 6)}`,
    contractId: contract.id,
    version,
    releasedAt: new Date().toISOString(),
    checksum: stableChecksum(contract.openapi),
    notes,
    changeIds: contract.changes.map((change) => change.id),
    openapi: contract.openapi,
    isBaseline: true,
  };

  const archivedAt = release.releasedAt;
  const archivedFromChanges = contract.changes.map((change) => ({
    ...change,
    releasedInVersion: version,
    staleReason: undefined,
    archivedReason: `随正式版本 ${version} 冻结归档；后续差异以新版本为基线重新比较。`,
    archivedAt,
  }));

  return {
    ...contract,
    version,
    status: 'frozen',
    baselineVersionId: release.id,
    baselineChecksum: release.checksum,
    versions: [
      release,
      ...contract.versions.map((item) => ({ ...item, isBaseline: false })),
    ],
    changes: [],
    archivedChanges: [...archivedFromChanges, ...contract.archivedChanges],
    revision: contract.revision + 1,
    updatedAt: release.releasedAt,
  };
}

function bumpRevision(contract: ApiContract): ApiContract {
  return { ...contract, revision: contract.revision + 1, updatedAt: new Date().toISOString() };
}

function requireContract(contracts: ApiContract[], id: string): ApiContract {
  const contract = contracts.find((item) => item.id === id);
  if (!contract) throw new Error('契约不存在');
  return contract;
}

/* -------------------------------- 展示辅助 -------------------------------- */

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
    ? [change.fieldName ? `${change.fieldName}: demo-value` : change.after.replace(/^新增|移除|变为/g, '').trim()]
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

export function buildChangeReport(contract: ApiContract): string {
  const baseline = contract.versions.find((version) => version.id === contract.baselineVersionId);
  const sync = catalogSyncStatus(contract);
  const lines = [
    `# ${contract.name} ${contract.version} 契约变更报告`,
    '',
    `- 领域：${contract.domain}`,
    `- 负责人：${contract.owner}`,
    `- 状态：${contract.status}`,
    `- 生成时间：${new Date().toISOString()}`,
    '',
    '## 比较基线',
    baseline
      ? [
          `- 基线版本：${baseline.version}（冻结于 ${formatDateTime(baseline.releasedAt)}，校验值 ${baseline.checksum}）`,
          baseline.baselineBackfilled
            ? '- 基线来源：旧数据缺少基线，按首个冻结快照回填'
            : '- 基线来源：正式冻结版本',
          contract.baselineBackfilledAt
            ? `- 回填时间：${formatDateTime(contract.baselineBackfilledAt)}`
            : '',
          `- 清单一致性：${
            sync.synced
              ? '清单与基线差异一致'
              : `不一致（缺 ${sync.missing} 项、多余 ${sync.extra} 项、待重新确认 ${sync.stale} 项）`
          }`,
        ]
          .filter(Boolean)
          .join('\n')
      : '- 尚无冻结版本，首版冻结后建立比较基线。',
    '',
    '## 当前差异明细',
    ...(contract.changes.length
      ? contract.changes.flatMap((change) => [
          `### ${change.method} ${change.path} - ${CHANGE_KIND_LABELS[change.kind]}`,
          change.legacy ? '- 来源：旧清单补录（保存定义后按基线重算）' : '',
          change.staleReason ? `- 失效说明：${change.staleReason}` : '',
          `- 兼容性：${change.compatibility}`,
          `- 变更前：${change.before}`,
          `- 变更后：${change.after}`,
          `- 判定依据：${change.rationale}`,
          `- 调用方影响：${change.impactStatement || '未填写'}`,
          `- 迁移方案：${change.migrationPlan || '未填写'}`,
          `- 评审结论：${change.reviewState}`,
          ...change.consumerConfirmations.map(
            (confirmation) =>
              `- 调用方确认：${confirmation.consumerName} - ${confirmation.state}${
                confirmation.invalidated ? '（已失效，需重新确认）' : ''
              }${confirmation.note ? `（${confirmation.note}）` : ''}`,
          ),
          '',
        ])
      : ['- 当前相对基线无待评审差异。', '']),
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
    '## 已失效/归档结论（原确认仍可查）',
    ...(contract.archivedChanges.length
      ? contract.archivedChanges.map(
          (change) =>
            `- [${formatDateTime(change.archivedAt)}] ${change.method} ${change.path} ${CHANGE_KIND_LABELS[change.kind]}：${change.archivedReason}` +
            (change.reviewer ? `（原结论 ${change.reviewState}，评审人 ${change.reviewer}）` : '') +
            (change.releasedInVersion ? `，随版本 ${change.releasedInVersion} 冻结` : ''),
        )
      : ['- 无']),
  ];
  return lines.join('\n');
}

export function diffVersionSummary(contract: ApiContract): string {
  const previous = contract.versions.find((version) => version.id === contract.baselineVersionId)
    ?? contract.versions[0];
  if (!previous) {
    return '无可比较的历史正式版本。';
  }
  const sync = catalogSyncStatus(contract);
  return [
    `基线版本 ${previous.version}`,
    `冻结于 ${formatDateTime(previous.releasedAt)}`,
    `校验值 ${previous.checksum}`,
    previous.baselineBackfilled ? '该基线由首个冻结快照回填' : '正式冻结基线',
    `当前待评审差异 ${contract.changes.length} 项`,
    sync.synced ? '差异清单与实际定义一致' : `清单已过期：缺 ${sync.missing} / 多 ${sync.extra} / 待确认 ${sync.stale}`,
  ].join('\n');
}
