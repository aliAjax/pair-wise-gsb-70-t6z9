import {
  AUTO_DETECTED_KINDS,
  CHANGE_KIND_LABELS,
  type ApiContract,
  type ArchivedChange,
  type ContractChange,
} from '../models/contract';
import {
  changeSignature,
  diffFieldSets,
  parseOpenApiDefinition,
  type FieldDef,
} from './field-diff';

export interface ReconcileResult {
  contract: ApiContract;
  parseError?: string;
  added: number;
  invalidated: number;
  /** 本次新归档（失效）的旧差异。 */
  archivedChanges: ArchivedChange[];
  /** 本次新建、等待确认的差异。 */
  createdChanges: ContractChange[];
}

const FIELD_TOKEN = /[A-Za-z_][\w.[\]]*/g;

/** 从手工文案里尽量提取字段名（仅用于旧签名/同字段匹配兜底）。 */
export function extractFieldToken(kind: string, before: string, after: string): string {
  const pick = (text: string): string | undefined => {
    const tokens = text.match(FIELD_TOKEN) ?? [];
    return tokens.find(
      (token) =>
        !/^(GET|POST|PUT|PATCH|DELETE|string|number|boolean|integer|array|object|required|optional)$/i.test(
          token,
        ),
    );
  };
  return (
    pick(after) ??
    pick(before) ??
    `field-${kind}`
  );
}

export function signatureOfChange(change: ContractChange): string {
  if (change.baselineSignature) return change.baselineSignature;
  return changeSignature({
    kind: change.kind,
    path: change.path,
    method: change.method,
    fieldName: change.fieldName ?? extractFieldToken(change.kind, change.before, change.after),
    before: change.before,
    after: change.after,
  });
}

function idleChangeId(contractId: string, serial: number): string {
  return `chg-${contractId.replace(/[^a-z0-9]/gi, '')}-det-${Date.now()}-${serial}`;
}

/**
 * 以冻结版本为基线重算字段差异。
 * - 签名一致：清单与定义一致，结论保留；
 * - 同字段但差异内容变化：旧差异失效归档（结论仍可查），生成新差异等待确认；
 * - 基线有、清单缺：补上差异；清单有、基线无：旧差异归档；
 * - 手工错误码差异不参与自动重算。
 */
export function reconcileContractChanges(
  contract: ApiContract,
  nextOpenApi: string,
): ReconcileResult {
  const baseline = contract.versions.find((version) => version.id === contract.baselineVersionId);
  if (!baseline) {
    return {
      contract: { ...contract, openapi: nextOpenApi },
      added: 0,
      invalidated: 0,
      archivedChanges: [],
      createdChanges: [],
    };
  }

  const baselineParsed = parseOpenApiDefinition(baseline.openapi);
  const currentParsed = parseOpenApiDefinition(nextOpenApi);
  if (!baselineParsed.ok || !currentParsed.ok) {
    const parseError = !baselineParsed.ok
      ? `基线定义无法解析：${baselineParsed.error}`
      : !currentParsed.ok
        ? currentParsed.error
        : '定义无法解析';
    return {
      contract,
      parseError,
      added: 0,
      invalidated: 0,
      archivedChanges: [],
      createdChanges: [],
    };
  }

  const detected = diffFieldSets(baselineParsed.fields, currentParsed.fields);
  const detectedBySignature = new Map(detected.map((item) => [signatureOfDetected(item), item]));

  const autoChanges = contract.changes.filter((change) =>
    AUTO_DETECTED_KINDS.has(change.kind),
  );
  const manualChanges = contract.changes.filter(
    (change) => !AUTO_DETECTED_KINDS.has(change.kind),
  );

  const kept: ContractChange[] = [];
  const consumedDetected = new Set<string>();
  const archivedNow: ArchivedChange[] = [];
  const createdNow: ContractChange[] = [];
  let invalidated = 0;
  let serial = 0;

  function archive(change: ContractChange, reason: string): ArchivedChange {
    const archived: ArchivedChange = {
      ...change,
      staleReason: undefined,
      archivedReason: reason,
      archivedAt: new Date().toISOString(),
    };
    archivedNow.push(archived);
    return archived;
  }

  const nextArchived = [...contract.archivedChanges];

  // 第一遍：精确签名匹配。必须先完成，避免未命中项的同字段兜底抢掉其他字段的检出差异。
  const unmatched: ContractChange[] = [];
  for (const change of autoChanges) {
    const signature = change.baselineSignature ?? signatureOfChange(change);
    const exact = detectedBySignature.get(signature);
    if (exact) {
      // 签名一致：清单仍与定义一致。legacy 补录项借此转正并去掉补录标记。
      kept.push(change.legacy ? { ...change, legacy: false } : change);
      consumedDetected.add(signature);
    } else {
      unmatched.push(change);
    }
  }

  // 第二遍：未命中项按“同字段 + 同位置”匹配剩余检出差异。
  for (const change of unmatched) {
    const changeField =
      change.fieldName ?? extractFieldToken(change.kind, change.before, change.after);
    const sameFieldMatch = detected.find(
      (item) =>
        !consumedDetected.has(signatureOfDetected(item)) &&
        change.path === item.path &&
        change.method.toUpperCase() === item.method.toUpperCase() &&
        (change.fieldLocation ?? item.location) === item.location &&
        changeField === item.fieldName,
    );

    if (sameFieldMatch) {
      const targetSignature = signatureOfDetected(sameFieldMatch);
      consumedDetected.add(targetSignature);
      const archived = archive(
        change,
        `定义再次保存，字段 ${sameFieldMatch.fieldName} 的实际差异已变化（${CHANGE_KIND_LABELS[change.kind]} → ${CHANGE_KIND_LABELS[sameFieldMatch.kind]}），旧结论失效。`,
      );
      nextArchived.push(archived);
      serial += 1;
      const replacement = buildReplacementChange(
        contract.id,
        sameFieldMatch,
        serial,
        change,
      );
      kept.push(replacement);
      createdNow.push(replacement);
      invalidated += 1;
    } else {
      const archived = archive(
        change,
        change.legacy
          ? '基线按首个冻结快照回填后重算，该手工条目与基线实际差异不一致，旧结论失效。'
          : '当前定义已恢复到基线状态或差异消失，旧结论失效。',
      );
      nextArchived.push(archived);
      invalidated += 1;
    }
  }

  let added = 0;
  for (const item of detected) {
    const signature = signatureOfDetected(item);
    if (consumedDetected.has(signature)) continue;
    serial += 1;
    const created = buildNewChange(contract.id, item, serial);
    kept.push(created);
    createdNow.push(created);
    added += 1;
  }

  const nextChanges = [...manualChanges, ...kept];
  return {
    contract: { ...contract, openapi: nextOpenApi, changes: nextChanges, archivedChanges: nextArchived },
    added,
    invalidated,
    archivedChanges: archivedNow,
    createdChanges: createdNow,
  };
}

function signatureOfDetected(item: {
  kind: ContractChange['kind'];
  path: string;
  method: string;
  fieldName: string;
  before: string;
  after: string;
}): string {
  return changeSignature({
    kind: item.kind,
    path: item.path,
    method: item.method,
    fieldName: item.fieldName,
    before: item.before,
    after: item.after,
  });
}

function buildReplacementChange(
  contractId: string,
  item: DetectedDiff,
  serial: number,
  previous: ContractChange,
): ContractChange {
  const staleReason = `保存定义时按冻结基线重算：字段 ${item.fieldName} 的差异由「${CHANGE_KIND_LABELS[previous.kind]}」变为「${CHANGE_KIND_LABELS[item.kind]}」，原评审与调用方确认失效，需要重新确认。`;
  return {
    ...buildNewChange(contractId, item, serial, staleReason),
    impactStatement: '',
    migrationPlan: '',
  };
}

function buildNewChange(
  contractId: string,
  item: DetectedDiff,
  serial: number,
  staleReason?: string,
): ContractChange {
  return {
    id: idleChangeId(contractId, serial),
    path: item.path,
    method: item.method,
    kind: item.kind,
    before: item.before,
    after: item.after,
    compatibility: item.compatibility,
    rationale: item.rationale,
    impactStatement: '',
    migrationPlan: '',
    reviewState: 'pending',
    reviewer: '',
    reviewComment: '',
    baselineSignature: signatureOfDetected(item),
    staleReason,
    detectedAt: new Date().toISOString(),
    fieldName: item.fieldName,
    fieldLocation: item.location,
    consumerConfirmations: [],
    reviewHistory: [],
  };
}

type DetectedDiff = ReturnType<typeof diffFieldSets>[number];

/** 清单是否与“基线 → 当前定义”的真实差异一致；冻结前门禁使用。 */
export function catalogSyncStatus(
  contract: ApiContract,
): { synced: boolean; missing: number; extra: number; stale: number } {
  const baseline = contract.versions.find((version) => version.id === contract.baselineVersionId);
  const activeAuto = contract.changes.filter((change) => AUTO_DETECTED_KINDS.has(change.kind));
  const stale = activeAuto.filter((change) => change.staleReason).length;
  if (!baseline) {
    return { synced: stale === 0, missing: 0, extra: 0, stale };
  }
  const baselineParsed = parseOpenApiDefinition(baseline.openapi);
  const currentParsed = parseOpenApiDefinition(contract.openapi);
  if (!baselineParsed.ok || !currentParsed.ok) {
    return { synced: false, missing: 0, extra: 0, stale };
  }
  const expected = diffFieldSets(baselineParsed.fields, currentParsed.fields);
  const expectedSignatures = new Set(expected.map(signatureOfDetected));
  const activeSignatures = new Set(
    activeAuto
      .filter((change) => !change.legacy && !change.staleReason)
      .map((change) => change.baselineSignature ?? signatureOfChange(change)),
  );
  let missing = 0;
  for (const signature of expectedSignatures) {
    if (!activeSignatures.has(signature)) missing += 1;
  }
  let extra = 0;
  for (const change of activeAuto) {
    if (change.legacy || change.staleReason) continue;
    const signature = change.baselineSignature ?? signatureOfChange(change);
    if (!expectedSignatures.has(signature)) extra += 1;
  }
  return { synced: missing === 0 && extra === 0 && stale === 0, missing, extra, stale };
}

export function parsedFieldCount(openapi: string): FieldDef[] | undefined {
  const parsed = parseOpenApiDefinition(openapi);
  return parsed.ok ? parsed.fields : undefined;
}

/* ------------------------------ 旧数据迁移 -------------------------------- */

/**
 * 旧数据缺少基线：按首个冻结快照（versions 末尾）回填。
 * 手写字段差异补录签名并标记 legacy，下次保存定义时按基线重算；
 * 已有评审结论同步写入 reviewHistory，保证失效后仍可查。
 */
export function migrateContract(raw: Partial<ApiContract>): ApiContract {
  const contract: ApiContract = {
    ...(raw as ApiContract),
    revision: typeof raw.revision === 'number' ? raw.revision : 1,
    archivedChanges: Array.isArray(raw.archivedChanges) ? raw.archivedChanges : [],
    changes: (raw.changes ?? []).map((change) => ({
      ...change,
      fieldName: change.fieldName,
      consumerConfirmations: Array.isArray(change.consumerConfirmations)
        ? change.consumerConfirmations
        : [],
      reviewHistory: Array.isArray(change.reviewHistory) ? change.reviewHistory : [],
    })),
    versions: raw.versions ?? [],
  };

  const sortedVersions = [...contract.versions].sort(
    (left, right) =>
      new Date(left.releasedAt).getTime() - new Date(right.releasedAt).getTime(),
  );
  const firstFrozen = sortedVersions[0];

  if (!contract.baselineVersionId && firstFrozen) {
    contract.baselineVersionId = firstFrozen.id;
    contract.baselineChecksum = firstFrozen.checksum;
    contract.baselineBackfilledAt = new Date().toISOString();
    contract.versions = contract.versions.map((version) =>
      version.id === firstFrozen.id
        ? { ...version, isBaseline: true, baselineBackfilled: true }
        : { ...version, isBaseline: false },
    );
  } else if (contract.baselineVersionId) {
    contract.versions = contract.versions.map((version) => ({
      ...version,
      isBaseline: version.id === contract.baselineVersionId,
    }));
  }

  contract.changes = contract.changes.map((change) => {
    const next: ContractChange = { ...change };
    if (
      next.reviewState !== 'pending' &&
      next.reviewedAt &&
      !next.reviewHistory.some(
        (entry) => entry.reviewedAt === next.reviewedAt && entry.reviewer === next.reviewer,
      )
    ) {
      next.reviewHistory = [
        ...next.reviewHistory,
        {
          id: `hist-${next.id}-migrated`,
          reviewState: next.reviewState,
          reviewer: next.reviewer,
          reviewComment: next.reviewComment,
          reviewedAt: next.reviewedAt,
          invalidatedReason: '历史结论迁移保留。',
        },
      ];
    }
    if (AUTO_DETECTED_KINDS.has(next.kind) && !next.baselineSignature) {
      next.baselineSignature = changeSignature({
        kind: next.kind,
        path: next.path,
        method: next.method,
        fieldName:
          next.fieldName ?? extractFieldToken(next.kind, next.before, next.after),
        before: next.before,
        after: next.after,
      });
      next.legacy = true;
    }
    return next;
  });

  return contract;
}
