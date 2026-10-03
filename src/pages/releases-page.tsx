import { Link } from '@tanstack/react-router';
import {
  Archive,
  CheckCircle2,
  History,
  LockKeyhole,
  PackageCheck,
  TriangleAlert,
  Users,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Checkbox } from '../components/ui/checkbox';
import { Input } from '../components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { Textarea } from '../components/ui/textarea';
import { formatDateTime } from '../lib/utils';
import {
  CHANGE_KIND_LABELS,
  REVIEW_STATE_LABELS,
  validateForRelease,
  type ChangeKind,
} from '../models/contract';
import {
  useContracts,
  useFreezeVersion,
  useInvalidateChangeGroup,
} from '../services/contract-queries';
import { useReviewStore } from '../store/review-store';

interface DiffGroup {
  kind: ChangeKind;
  total: number;
  confirmed: number;
  contractIds: string[];
  contractNames: string[];
  sharedConsumers: string[];
}

export function ReleasesPage() {
  const contracts = useContracts();
  const freezeVersion = useFreezeVersion();
  const invalidateGroup = useInvalidateChangeGroup();
  const selectedContractId = useReviewStore((state) => state.selectedContractId);
  const setSelectedContract = useReviewStore((state) => state.setSelectedContract);
  const [version, setVersion] = useState('');
  const [notes, setNotes] = useState('');
  const [checkedIds, setCheckedIds] = useState<string[]>([]);

  const allContracts = useMemo(() => contracts.data ?? [], [contracts.data]);
  const checkedContracts = useMemo(
    () => allContracts.filter((contract) => checkedIds.includes(contract.id)),
    [allContracts, checkedIds],
  );

  const gateByContract = useMemo(() => {
    const map = new Map<string, { blockers: number; warnings: number }>();
    allContracts.forEach((contract) => {
      const issues = validateForRelease(contract);
      map.set(contract.id, {
        blockers: issues.filter((issue) => issue.severity === 'blocker').length,
        warnings: issues.filter((issue) => issue.severity === 'warning').length,
      });
    });
    return map;
  }, [allContracts]);

  const selectedContract = allContracts.find((contract) => contract.id === selectedContractId);
  const selectedIssues = selectedContract ? validateForRelease(selectedContract) : [];
  const blockers = selectedIssues.filter((issue) => issue.severity === 'blocker').length;

  const versions = useMemo(
    () =>
      allContracts
        .flatMap((contract) => contract.versions.map((release) => ({ contract, release })))
        .sort(
          (left, right) =>
            new Date(right.release.releasedAt).getTime() -
            new Date(left.release.releasedAt).getTime(),
        ),
    [allContracts],
  );

  /** 选中的多份契约之间，按联系方式重合的共享调用方 */
  const sharedConsumers = useMemo(() => {
    const byContact = new Map<string, { name: string; contracts: string[] }>();
    checkedContracts.forEach((contract) => {
      contract.consumers.forEach((consumer) => {
        const entry = byContact.get(consumer.contact) ?? { name: consumer.name, contracts: [] };
        if (!entry.contracts.includes(contract.name)) entry.contracts.push(contract.name);
        byContact.set(consumer.contact, entry);
      });
    });
    return [...byContact.entries()]
      .filter(([, entry]) => entry.contracts.length > 1)
      .map(([contact, entry]) => ({ contact, ...entry }));
  }, [checkedContracts]);

  /** 选中契约的差异按类型分组，统计已确认数量和受影响的共享调用方 */
  const diffGroups = useMemo<DiffGroup[]>(() => {
    const sharedContacts = new Set(sharedConsumers.map((consumer) => consumer.contact));
    const groups = new Map<ChangeKind, DiffGroup & { contractIdSet: Set<string>; sharedSet: Set<string> }>();
    checkedContracts.forEach((contract) => {
      contract.changes.forEach((change) => {
        let group = groups.get(change.kind);
        if (!group) {
          group = {
            kind: change.kind,
            total: 0,
            confirmed: 0,
            contractIds: [],
            contractNames: [],
            sharedConsumers: [],
            contractIdSet: new Set(),
            sharedSet: new Set(),
          };
          groups.set(change.kind, group);
        }
        group.total += 1;
        if (change.reviewState !== 'pending') {
          group.confirmed += 1;
          group.contractIdSet.add(contract.id);
          contract.consumers.forEach((consumer) => {
            if (sharedContacts.has(consumer.contact) && !group.sharedSet.has(consumer.name)) {
              group.sharedSet.add(consumer.name);
            }
          });
        }
      });
    });
    return [...groups.values()]
      .map(({ contractIdSet, sharedSet, ...group }) => ({
        ...group,
        contractIds: [...contractIdSet],
        contractNames: checkedContracts
          .filter((contract) => contractIdSet.has(contract.id))
          .map((contract) => contract.name),
        sharedConsumers: [...sharedSet],
      }))
      .sort((left, right) => right.confirmed - left.confirmed);
  }, [checkedContracts, sharedConsumers]);

  /** 原确认仍可查：选中契约的失效确认历史 */
  const confirmations = useMemo(
    () =>
      checkedContracts
        .flatMap((contract) =>
          contract.confirmations.map((confirmation) => ({ contract, confirmation })),
        )
        .sort(
          (left, right) =>
            new Date(right.confirmation.invalidatedAt).getTime() -
            new Date(left.confirmation.invalidatedAt).getTime(),
        ),
    [checkedContracts],
  );

  function toggleContract(contractId: string) {
    setCheckedIds((current) =>
      current.includes(contractId)
        ? current.filter((id) => id !== contractId)
        : [...current, contractId],
    );
  }

  async function freeze() {
    if (!selectedContract || !version.trim() || blockers) return;
    await freezeVersion.mutateAsync({
      contractId: selectedContract.id,
      version: version.trim(),
      notes: notes.trim() || '契约兼容性评审完成，正式冻结。',
    });
    setVersion('');
    setNotes('');
  }

  async function invalidate(group: DiffGroup) {
    const sharedText = group.sharedConsumers.length
      ? `共享调用方 ${group.sharedConsumers.join('、')} 的确认一起失效`
      : '无共享调用方';
    await invalidateGroup.mutateAsync({
      contractIds: group.contractIds,
      changeKind: group.kind,
      reason: `发布中心差异组「${CHANGE_KIND_LABELS[group.kind]}」确认失效，${sharedText}，需重新确认`,
    });
  }

  return (
    <div>
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-sky-800">Release Center</p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-950 sm:text-3xl">
          契约版本发布
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
          只有逐条评审完成且迁移约束满足后，才能冻结正式版本。多选契约可查看共享调用方，并按差异组联动失效确认。
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>正式版本记录</CardTitle>
              <p className="mt-1 text-xs text-slate-500">{versions.length} 个冻结版本</p>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-left text-sm">
                  <thead className="bg-slate-50 text-xs text-slate-500">
                    <tr>
                      <th className="px-4 py-3 font-medium">契约</th>
                      <th className="px-4 py-3 font-medium">版本</th>
                      <th className="px-4 py-3 font-medium">发布时间</th>
                      <th className="px-4 py-3 font-medium">校验值</th>
                      <th className="px-4 py-3 font-medium">比较基线</th>
                      <th className="px-4 py-3 font-medium">发布说明</th>
                      <th className="px-4 py-3 font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {versions.map(({ contract, release }) => (
                      <tr key={release.id} className="border-t border-slate-100">
                        <td className="px-4 py-4">
                          <div className="font-medium">{contract.name}</div>
                          <div className="mt-1 text-xs text-slate-500">{contract.domain}</div>
                        </td>
                        <td className="px-4 py-4">
                          <Badge tone="slate">v{release.version}</Badge>
                        </td>
                        <td className="px-4 py-4 text-slate-600">
                          {formatDateTime(release.releasedAt)}
                        </td>
                        <td className="px-4 py-4 font-mono text-xs text-slate-600">
                          {release.checksum}
                        </td>
                        <td className="px-4 py-4 text-xs text-slate-600">
                          {release.baseline ? `v${release.baseline.version}` : '首个冻结快照'}
                        </td>
                        <td className="max-w-md px-4 py-4 text-slate-600">{release.notes}</td>
                        <td className="px-4 py-4 text-right">
                          <Link
                            to="/contracts/$contractId"
                            params={{ contractId: contract.id }}
                            className="text-xs font-medium text-sky-800 hover:underline"
                          >
                            查看版本
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!versions.length && (
                  <p className="px-4 py-16 text-center text-sm text-slate-500">
                    尚无冻结的正式版本。
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>确认历史</CardTitle>
              <p className="mt-1 text-xs text-slate-500">
                定义变化或差异组失效后，原确认归档在这里，仍可查询
              </p>
            </CardHeader>
            <CardContent>
              {!checkedIds.length && (
                <p className="py-6 text-center text-sm text-slate-500">
                  先在右侧勾选契约，查看它们的失效确认记录。
                </p>
              )}
              {!!checkedIds.length && !confirmations.length && (
                <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
                  选中契约没有失效的确认记录。
                </div>
              )}
              <div className="space-y-3">
                {confirmations.map(({ contract, confirmation }) => (
                  <article
                    key={confirmation.id}
                    className="rounded-md border border-amber-200 bg-amber-50 p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <strong className="text-sm text-amber-950">{contract.name}</strong>
                      <span className="font-mono text-[11px] text-amber-900">
                        {confirmation.method} {confirmation.path}
                      </span>
                      <Badge tone="amber">{CHANGE_KIND_LABELS[confirmation.kind]}</Badge>
                      <Badge tone="neutral">
                        原结论 {REVIEW_STATE_LABELS[confirmation.reviewState]}
                      </Badge>
                    </div>
                    <p className="mt-2 text-xs leading-5 text-amber-900">{confirmation.reason}</p>
                    <div className="mt-2 text-[11px] text-amber-800">
                      确认人 {confirmation.reviewer || '未指定'} · 确认于{' '}
                      {formatDateTime(confirmation.confirmedAt)} · 失效于{' '}
                      {formatDateTime(confirmation.invalidatedAt)}
                    </div>
                  </article>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>选择发布契约</CardTitle>
              <p className="mt-1 text-xs text-slate-500">
                可多选，发布门禁实时检查当前工作副本
              </p>
            </CardHeader>
            <CardContent className="space-y-2">
              {allContracts.map((contract) => {
                const gate = gateByContract.get(contract.id);
                const checked = checkedIds.includes(contract.id);
                return (
                  <label
                    key={contract.id}
                    className={
                      checked
                        ? 'flex cursor-pointer items-start gap-3 rounded-md border border-sky-300 bg-sky-50 p-3'
                        : 'flex cursor-pointer items-start gap-3 rounded-md border border-slate-200 p-3 hover:bg-slate-50'
                    }
                  >
                    <Checkbox
                      className="mt-0.5"
                      checked={checked}
                      onCheckedChange={() => toggleContract(contract.id)}
                      aria-label={`选择 ${contract.name}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-slate-900">
                        {contract.name}
                        <span className="ml-2 font-mono text-xs text-slate-500">
                          v{contract.version}
                        </span>
                      </span>
                      <span className="mt-1 flex flex-wrap gap-1.5">
                        {gate?.blockers ? (
                          <Badge tone="red">{gate.blockers} 阻断</Badge>
                        ) : (
                          <Badge tone="green">门禁通过</Badge>
                        )}
                        {!!gate?.warnings && <Badge tone="amber">{gate.warnings} 警告</Badge>}
                      </span>
                    </span>
                  </label>
                );
              })}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>共享调用方</CardTitle>
              <p className="mt-1 text-xs text-slate-500">
                选中契约之间重合的调用方，差异组失效会联动影响
              </p>
            </CardHeader>
            <CardContent>
              {sharedConsumers.length ? (
                <div className="space-y-2">
                  {sharedConsumers.map((consumer) => (
                    <div
                      key={consumer.contact}
                      className="flex items-start gap-3 rounded-md border border-slate-200 p-3"
                    >
                      <Users className="mt-0.5 h-4 w-4 shrink-0 text-sky-800" />
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-slate-900">{consumer.name}</div>
                        <div className="mt-0.5 text-xs text-slate-500">{consumer.contact}</div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {consumer.contracts.map((name) => (
                            <Badge key={name} tone="blue">
                              {name}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-slate-500">
                  {checkedIds.length > 1
                    ? '选中契约之间没有共享调用方。'
                    : '勾选两份以上契约后展示共享调用方。'}
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>差异组确认</CardTitle>
              <p className="mt-1 text-xs text-slate-500">
                失效后相关契约的发布门禁同步阻断，原确认归档可查
              </p>
            </CardHeader>
            <CardContent className="space-y-2">
              {!checkedIds.length && (
                <p className="text-sm text-slate-500">勾选契约后按差异类型分组展示。</p>
              )}
              {!!checkedIds.length && !diffGroups.length && (
                <p className="text-sm text-slate-500">选中契约当前没有差异项。</p>
              )}
              {diffGroups.map((group) => (
                <div key={group.kind} className="rounded-md border border-slate-200 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <strong className="text-sm">{CHANGE_KIND_LABELS[group.kind]}</strong>
                    <Badge tone={group.confirmed ? 'amber' : 'neutral'}>
                      {group.confirmed}/{group.total} 已确认
                    </Badge>
                  </div>
                  {!!group.contractNames.length && (
                    <p className="mt-1.5 text-xs leading-5 text-slate-500">
                      {group.contractNames.join('、')}
                      {group.sharedConsumers.length
                        ? ` · 共享调用方：${group.sharedConsumers.join('、')}`
                        : ''}
                    </p>
                  )}
                  <Button
                    className="mt-2 w-full"
                    variant="secondary"
                    size="sm"
                    disabled={!group.confirmed || invalidateGroup.isPending}
                    onClick={() => void invalidate(group)}
                  >
                    <History className="h-3.5 w-3.5" />
                    使该组确认失效（{group.contractIds.length} 份契约）
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>冻结正式版本</CardTitle>
              <p className="mt-1 text-xs text-slate-500">发布门禁会实时检查当前工作副本</p>
            </CardHeader>
            <CardContent>
              <Select
                value={selectedContractId}
                onValueChange={(value) => {
                  setSelectedContract(value);
                  const contract = allContracts.find((item) => item.id === value);
                  if (contract) setVersion(suggestVersion(contract.version));
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="选择一个契约" />
                </SelectTrigger>
                <SelectContent>
                  {allContracts.map((contract) => (
                    <SelectItem key={contract.id} value={contract.id}>
                      {contract.name} · v{contract.version}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {selectedContract && (
                <div className="mt-4">
                  <div
                    className={
                      blockers
                        ? 'flex items-start gap-3 rounded-md border border-red-200 bg-red-50 p-3'
                        : 'flex items-start gap-3 rounded-md border border-emerald-200 bg-emerald-50 p-3'
                    }
                  >
                    {blockers ? (
                      <TriangleAlert className="mt-0.5 h-4 w-4 text-red-700" />
                    ) : (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-700" />
                    )}
                    <div>
                      <strong className="text-sm">
                        {blockers ? `${blockers} 个阻断项` : '发布门禁通过'}
                      </strong>
                      <p className="mt-1 text-xs leading-5 text-slate-600">
                        {blockers
                          ? '先在详细页补齐改变评审、影响说明和迁移方案。'
                          : '可以冻结正式版本，历史工作副本仍保留。'}
                      </p>
                    </div>
                  </div>

                  <label className="mt-4 block text-xs font-medium text-slate-700">新版本号</label>
                  <Input
                    className="mt-1.5"
                    value={version}
                    onChange={(event) => setVersion(event.target.value)}
                    placeholder="2.9.0"
                  />
                  <label className="mt-4 block text-xs font-medium text-slate-700">发布说明</label>
                  <Textarea
                    className="mt-1.5"
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                    placeholder="版本变化、兼容层和调用方升级状态"
                  />
                  <Button
                    className="mt-4 w-full"
                    disabled={!!blockers || !version.trim() || freezeVersion.isPending}
                    onClick={() => void freeze()}
                  >
                    <LockKeyhole className="h-4 w-4" />
                    {freezeVersion.isPending ? '冻结中' : '冻结正式版本'}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>冻结策略</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm text-slate-600">
              <Policy icon={Archive} text="版本快照包含完整 OpenAPI 和变更清单。" />
              <Policy icon={PackageCheck} text="重复版本号不会重复生成版本，恢复批次自动去重。" />
              <Policy icon={LockKeyhole} text="冻结后通过差异编辑器与当前工作副本比较。" />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function suggestVersion(current: string): string {
  const parts = current.split('.').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return current;
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

function Policy({
  icon: Icon,
  text,
}: {
  icon: typeof Archive;
  text: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-sky-800" />
      <span>{text}</span>
    </div>
  );
}
