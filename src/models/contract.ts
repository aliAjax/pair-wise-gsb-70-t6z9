export type ContractStatus = 'draft' | 'review' | 'ready' | 'released' | 'frozen';
export type ChangeKind =
  | 'field_added'
  | 'field_removed'
  | 'field_type_changed'
  | 'optionality_changed'
  | 'enum_expanded'
  | 'enum_narrowed'
  | 'error_code_added'
  | 'error_code_removed';
export type Compatibility = 'compatible' | 'warning' | 'breaking';
export type ReviewState = 'pending' | 'accepted' | 'returned' | 'exemption';
export type ConsumerConfirmationState = 'confirmed' | 'rejected' | 'exemption';

/** 可由定义比较自动检出的差异类型（手工错误码差异不在此列）。 */
export const AUTO_DETECTED_KINDS: ReadonlySet<ChangeKind> = new Set<ChangeKind>([
  'field_added',
  'field_removed',
  'field_type_changed',
  'optionality_changed',
  'enum_expanded',
  'enum_narrowed',
]);

export interface ConsumerConfirmation {
  id: string;
  consumerId: string;
  consumerName: string;
  state: ConsumerConfirmationState;
  note: string;
  confirmedBy: string;
  confirmedAt: string;
  /** 定义改动导致旧确认失效后保留原记录，仅作查询，不再通过门禁。 */
  invalidated?: boolean;
  invalidatedReason?: string;
  invalidatedAt?: string;
}

export interface ReviewHistoryEntry {
  id: string;
  reviewState: ReviewState;
  reviewer: string;
  reviewComment: string;
  reviewedAt: string;
  invalidatedReason: string;
}

export interface ContractChange {
  id: string;
  path: string;
  method: string;
  kind: ChangeKind;
  before: string;
  after: string;
  compatibility: Compatibility;
  rationale: string;
  impactStatement: string;
  migrationPlan: string;
  reviewState: ReviewState;
  reviewer: string;
  reviewComment: string;
  reviewedAt?: string;
  /** 差异相对基线的稳定签名，用于判断清单是否仍与实际定义一致。 */
  baselineSignature?: string;
  /** 旧数据迁移补录的差异，没有真实签名；定义再次保存后按基线重算。 */
  legacy?: boolean;
  /** 非空表示差异已被重新计算，该条旧结论失效、等待重新确认。 */
  staleReason?: string;
  detectedAt?: string;
  fieldName?: string;
  fieldLocation?: string;
  consumerConfirmations: ConsumerConfirmation[];
  reviewHistory: ReviewHistoryEntry[];
  /** 已随某个正式版本冻结归档。 */
  releasedInVersion?: string;
}

export interface ArchivedChange extends ContractChange {
  archivedReason: string;
  archivedAt: string;
}

export interface ApiConsumer {
  id: string;
  name: string;
  owner: string;
  environment: '生产' | '预发' | '灰度';
  clientVersion: string;
  requestsPerDay: number;
  contact: string;
}

export interface Exemption {
  id: string;
  changeId: string;
  scope: string;
  reason: string;
  approvedBy: string;
  expiresAt: string;
}

export interface ContractVersion {
  id: string;
  contractId: string;
  version: string;
  releasedAt: string;
  checksum: string;
  notes: string;
  changeIds: string[];
  openapi: string;
  /** 是否为当前比较基线。 */
  isBaseline?: boolean;
  /** 旧数据缺少基线时，按首个冻结快照回填。 */
  baselineBackfilled?: boolean;
}

export interface ApiContract {
  id: string;
  name: string;
  version: string;
  domain: string;
  owner: string;
  protocol: 'REST' | 'GraphQL' | 'gRPC-Web';
  status: ContractStatus;
  updatedAt: string;
  openapi: string;
  changes: ContractChange[];
  consumers: ApiConsumer[];
  exemptions: Exemption[];
  versions: ContractVersion[];
  /** 当前比较基线对应的冻结版本。 */
  baselineVersionId?: string;
  baselineChecksum?: string;
  /** 基线为旧数据回填时记录回填时间。 */
  baselineBackfilledAt?: string;
  /** 已失效但保留可查的差异结论。 */
  archivedChanges: ArchivedChange[];
  /** 乐观锁版本，两个窗口同时保存时后写者拿到冲突。 */
  revision: number;
}

export interface ReleaseIssue {
  id: string;
  severity: 'blocker' | 'warning';
  title: string;
  detail: string;
  changeId?: string;
}

export const CHANGE_KIND_LABELS: Record<ChangeKind, string> = {
  field_added: '新增字段',
  field_removed: '删除字段',
  field_type_changed: '字段类型变化',
  optionality_changed: '必填变化',
  enum_expanded: '枚举扩展',
  enum_narrowed: '枚举收窄',
  error_code_added: '新增错误码',
  error_code_removed: '删除错误码',
};

export const COMPATIBILITY_LABELS: Record<Compatibility, string> = {
  compatible: '兼容',
  warning: '警告',
  breaking: '不兼容',
};

export const REVIEW_STATE_LABELS: Record<ReviewState, string> = {
  pending: '待评审',
  accepted: '已接受',
  returned: '已退回',
  exemption: '兼容层豁免',
};

export const CONSUMER_CONFIRMATION_LABELS: Record<ConsumerConfirmationState, string> = {
  confirmed: '确认接受',
  rejected: '确认不接受',
  exemption: '走兼容层',
};

export const CONTRACT_STATUS_LABELS: Record<ContractStatus, string> = {
  draft: '草稿',
  review: '评审中',
  ready: '待发布',
  released: '已发布',
  frozen: '已冻结',
};

export function classifyChange(input: {
  kind: ChangeKind;
  before: string;
  after: string;
}): { compatibility: Compatibility; rationale: string } {
  switch (input.kind) {
    case 'field_removed':
      return {
        compatibility: 'breaking',
        rationale: '删除字段会使仍读取该字段的客户端解析失败或业务判断缺失。',
      };
    case 'field_type_changed':
      return {
        compatibility: 'breaking',
        rationale: '字段类型变化会导致客户端按旧类型解析失败或精度、枚举语义改变。',
      };
    case 'enum_narrowed':
      return {
        compatibility: 'breaking',
        rationale: '枚举值被移除后，仍发送或读取旧值的调用方会被拒绝或出现未知分支。',
      };
    case 'error_code_removed':
      return {
        compatibility: 'breaking',
        rationale: '删除错误码会破坏调用方基于错误码建立的分支与重试策略。',
      };
    case 'field_added':
      if (/required/i.test(input.after) || /必填/.test(input.after)) {
        return {
          compatibility: 'breaking',
          rationale: '新增必填字段要求现有调用方立即修改请求。',
        };
      }
      return {
        compatibility: 'compatible',
        rationale: '新增可选字段不会改变现有请求和响应结构。',
      };
    case 'optionality_changed':
      if (/可选.*必填|optional.*required/i.test(`${input.before} ${input.after}`)) {
        return {
          compatibility: 'breaking',
          rationale: '字段从可选变为必填，现有调用方可能不再满足请求约束。',
        };
      }
      return {
        compatibility: 'warning',
        rationale: '字段从必填变为可选会改变调用方对响应完整性的假设。',
      };
    case 'enum_expanded':
      return {
        compatibility: 'warning',
        rationale: '新增枚举值可能使未实现默认分支的客户端出现解析或展示异常。',
      };
    case 'error_code_added':
      return {
        compatibility: 'warning',
        rationale: '调用方应明确新错误码的展示和重试策略。',
      };
  }
}

export function findBaselineVersion(contract: ApiContract): ContractVersion | undefined {
  return contract.versions.find((version) => version.id === contract.baselineVersionId);
}

export function activeConsumerConfirmations(change: ContractChange): ConsumerConfirmation[] {
  return change.consumerConfirmations.filter(
    (confirmation) => confirmation.state === 'confirmed' && !confirmation.invalidated,
  );
}

export function invalidatedConsumerConfirmations(change: ContractChange): ConsumerConfirmation[] {
  return change.consumerConfirmations.filter((confirmation) => confirmation.invalidated);
}

export function validateForRelease(contract: ApiContract): ReleaseIssue[] {
  const issues: ReleaseIssue[] = [];
  const pending = contract.changes.filter((change) => change.reviewState === 'pending');
  pending.forEach((change) => {
    issues.push({
      id: `pending-${change.id}`,
      severity: 'blocker',
      title: '存在未处理变更',
      detail: `${change.method} ${change.path} 仍处于待评审状态。`,
      changeId: change.id,
    });
  });

  // 旧结论已因定义改动失效，必须对重新计算后的差异重新确认。
  contract.changes
    .filter((change) => change.staleReason)
    .forEach((change) => {
      issues.push({
        id: `stale-${change.id}`,
        severity: 'blocker',
        title: '差异结论已失效，需要重新确认',
        detail: `${change.method} ${change.path}：${change.staleReason}`,
        changeId: change.id,
      });
    });

  // 调用方确认失效：原确认仍可查，但门禁按未确认处理。
  contract.changes.forEach((change) => {
    const invalidated = invalidatedConsumerConfirmations(change);
    if (invalidated.length) {
      issues.push({
        id: `invalidated-confirmation-${change.id}`,
        severity: 'blocker',
        title: '调用方确认已失效',
        detail: `${change.method} ${change.path} 上 ${invalidated
          .map((item) => item.consumerName)
          .join('、')} 的确认已随定义改动失效，需要重新确认。`,
        changeId: change.id,
      });
    }
  });

  contract.changes
    .filter((change) => change.reviewState !== 'exemption')
    .forEach((change) => {
      if (change.compatibility === 'compatible') {
        return;
      }
      if (!change.impactStatement.trim()) {
        issues.push({
          id: `impact-${change.id}`,
          severity: 'blocker',
          title: '缺少调用方影响说明',
          detail: `${change.path} 需要说明受影响调用方、流量和业务影响。`,
          changeId: change.id,
        });
      }
      if (!change.migrationPlan.trim()) {
        issues.push({
          id: `migration-${change.id}`,
          severity: 'blocker',
          title: '缺少迁移方案',
          detail: `${change.path} 需要给出客户端升级、兼容层或回滚路径。`,
          changeId: change.id,
        });
      }
    });

  // 不兼容差异必须逐个拿到调用方确认（或登记兼容层豁免）。
  contract.changes
    .filter(
      (change) =>
        change.compatibility === 'breaking' &&
        change.reviewState === 'accepted' &&
        !contract.exemptions.some((item) => item.changeId === change.id) &&
        contract.consumers.length > 0 &&
        activeConsumerConfirmations(change).length === 0,
    )
    .forEach((change) => {
      issues.push({
        id: `consumer-confirm-${change.id}`,
        severity: 'blocker',
        title: '不兼容差异缺少调用方确认',
        detail: `${change.path} 还没有任何受影响调用方确认接受；原确认若已失效需重新确认。`,
        changeId: change.id,
      });
    });

  contract.changes
    .filter(
      (change) =>
        change.compatibility === 'breaking' &&
        change.reviewState === 'accepted' &&
        !contract.exemptions.some((item) => item.changeId === change.id),
    )
    .forEach((change) => {
      issues.push({
        id: `breaking-${change.id}`,
        severity: 'warning',
        title: '不兼容变更已接受但未登记豁免',
        detail: `${change.path} 需要记录兼容层的范围、原因和到期时间。`,
        changeId: change.id,
      });
    });

  if (!contract.baselineVersionId) {
    issues.push({
      id: 'baseline-missing',
      severity: 'warning',
      title: '尚未建立比较基线',
      detail: '首份正式版本冻结后，将以该冻结快照作为字段差异比较基线。',
    });
  }

  return issues;
}
