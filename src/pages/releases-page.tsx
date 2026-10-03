import { Link } from '@tanstack/react-router';
import {
  Archive,
  CheckCircle2,
  Eraser,
  History,
  LockKeyhole,
  PackageCheck,
  Play,
  TriangleAlert,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Checkbox } from '../components/ui/checkbox';
import { Textarea } from '../components/ui/textarea';
import { formatDateTime } from '../lib/utils';
import {
  invalidatedConsumerConfirmations,
  validateForRelease,
  type ApiContract,
} from '../models/contract';
import { getCatalogSync, type FreezeBatch } from '../services/contract-service';
import {
  useContracts,
  useCreateFreezeBatch,
  useDeleteFreezeBatch,
  useFailNextFreeze,
  useFreezeBatches,
  useResumeFreezeBatch,
} from '../services/contract-queries';

const EMPTY_CONTRACTS: ApiContract[] = [];

export function ReleasesPage() {
  const contracts = useContracts();
  const createBatch = useCreateFreezeBatch();
  const resumeBatch = useResumeFreezeBatch();
  const deleteBatch = useDeleteFreezeBatch();
  const failNextFreeze = useFailNextFreeze();
  const batches = useFreezeBatches();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [versionOverrides, setVersionOverrides] = useState<Record<string, string>>({});
  const [batchError, setBatchError] = useState('');
  const [batchNotice, setBatchNotice] = useState('');
  const [injectFailure, setInjectFailure] = useState(false);

  const data = contracts.data ?? EMPTY_CONTRACTS;

  const rows = useMemo(
    () =>
      data.map((contract) => {
        const issues = validateForRelease(contract);
        const sync = getCatalogSync(contract);
        const invalidatedConfirmations = contract.changes.flatMap((change) =>
          invalidatedConsumerConfirmations(change).map((item) => ({
            change,
            confirmation: item,
          })),
        );
        return {
          contract,
          blockers: issues.filter((issue) => issue.severity === 'blocker').length,
          sync,
          invalidatedConfirmations,
        };
      }),
    [data],
  );

  const selectedRows = rows.filter((row) => selectedIds.includes(row.contract.id));
  const blockedCount = selectedRows.filter(
    (row) => row.blockers > 0 || !row.sync.synced,
  ).length;

  const versions = useMemo(
    () =>
      data
        .flatMap((contract) => contract.versions.map((release) => ({ contract, release })))
        .sort(
          (left, right) =>
            new Date(right.release.releasedAt).getTime() -
            new Date(left.release.releasedAt).getTime(),
        ),
    [data],
  );

  const pendingBatches = batches.data?.filter((batch) => batch.status !== 'completed') ?? [];

  function toggle(id: string) {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
    setBatchError('');
    setBatchNotice('');
  }

  function targetVersion(contract: ApiContract): string {
    return versionOverrides[contract.id] ?? suggestVersion(contract.version);
  }

  async function submitBatch() {
    setBatchError('');
    setBatchNotice('');
    if (!selectedRows.length || blockedCount) return;
    try {
      await failNextFreeze.mutateAsync(injectFailure);
      const batch = await createBatch.mutateAsync({
        items: selectedRows.map((row) => ({
          contractId: row.contract.id,
          version: targetVersion(row.contract),
          notes: notes.trim() || '发布中心批量冻结。',
        })),
      });
      if (batch.status === 'completed') {
        setBatchNotice(`批次 ${batch.id} 已全部冻结完成，共 ${batch.items.length} 份契约。`);
        setSelectedIds([]);
        setNotes('');
      } else {
        setBatchError(
          `批次在「${batch.items.find((item) => item.status === 'failed')?.contractName}」处中断，未完成契约已保留，可继续恢复且不会重复生成版本。`,
        );
      }
    } catch (error) {
      setBatchError(error instanceof Error ? error.message : '批量冻结失败。');
    }
  }

  async function resume(batchId: string) {
    setBatchError('');
    setBatchNotice('');
    const batch = await resumeBatch.mutateAsync(batchId);
    if (batch.status === 'completed') {
      setBatchNotice(`批次已恢复并全部完成（${batch.items.length} 份契约）。`);
    } else {
      setBatchError('仍有未完成契约，请检查后再次继续。');
    }
  }

  return (
    <div>
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-sky-800">Release Center</p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-950 sm:text-3xl">
          契约版本发布
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
          选中多份契约一起冻结：共享调用方对某组差异的确认失效时，关联契约会同时被门禁阻断；
          中断的冻结批次可恢复，只补未完成契约且不重复生成版本。
        </p>
      </div>

      {pendingBatches.length > 0 && (
        <Card className="mb-4 border-amber-300">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle>待恢复冻结批次</CardTitle>
              <p className="mt-1 text-xs text-slate-500">
                两个窗口同时保存或写入失败后保留；恢复时跳过已完成契约，同版本号不会重复冻结
              </p>
            </div>
            <History className="h-5 w-5 text-amber-600" />
          </CardHeader>
          <CardContent className="space-y-3">
            {pendingBatches.map((batch) => (
              <BatchRecoveryRow
                key={batch.id}
                batch={batch}
                busy={resumeBatch.isPending || deleteBatch.isPending}
                onResume={() => void resume(batch.id)}
                onDiscard={() => deleteBatch.mutate(batch.id)}
              />
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <Card>
          <CardHeader>
            <CardTitle>选择发布候选（可多选）</CardTitle>
            <p className="mt-1 text-xs text-slate-500">
              发布门禁实时检查冻结基线、差异清单和调用方确认状态
            </p>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-3" />
                  <th className="px-4 py-3 font-medium">契约</th>
                  <th className="px-4 py-3 font-medium">基线</th>
                  <th className="px-4 py-3 font-medium">清单一致性</th>
                  <th className="px-4 py-3 font-medium">调用方确认</th>
                  <th className="px-4 py-3 font-medium">门禁</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ contract, blockers, sync, invalidatedConfirmations }) => {
                  const checked = selectedIds.includes(contract.id);
                  const baseline = contract.versions.find(
                    (version) => version.id === contract.baselineVersionId,
                  );
                  return (
                    <tr
                      key={contract.id}
                      className={checked ? 'border-t border-sky-100 bg-sky-50/50' : 'border-t border-slate-100'}
                    >
                      <td className="px-4 py-4">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() => toggle(contract.id)}
                          aria-label={`选择 ${contract.name}`}
                        />
                      </td>
                      <td className="px-4 py-4">
                        <div className="font-medium">{contract.name}</div>
                        <div className="mt-1 text-xs text-slate-500">
                          {contract.domain} · v{contract.version}
                        </div>
                      </td>
                      <td className="px-4 py-4 text-xs text-slate-600">
                        {baseline ? (
                          <>
                            v{baseline.version}
                            {baseline.baselineBackfilled && (
                              <Badge className="ml-1" tone="amber">
                                回填
                              </Badge>
                            )}
                          </>
                        ) : (
                          <Badge tone="amber">首版无基线</Badge>
                        )}
                      </td>
                      <td className="px-4 py-4">
                        {sync.synced ? (
                          <Badge tone="green">一致</Badge>
                        ) : (
                          <Badge tone="red">
                            缺 {sync.missing} / 多 {sync.extra} / 待认 {sync.stale}
                          </Badge>
                        )}
                      </td>
                      <td className="px-4 py-4">
                        {invalidatedConfirmations.length ? (
                          <Badge tone="red">
                            {invalidatedConfirmations.length} 条确认失效
                          </Badge>
                        ) : (
                          <Badge tone="neutral">无失效确认</Badge>
                        )}
                      </td>
                      <td className="px-4 py-4">
                        {blockers || !sync.synced ? (
                          <Badge tone="red">{blockers || sync.missing + sync.extra + sync.stale} 阻断</Badge>
                        ) : (
                          <Badge tone="green">可冻结</Badge>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>批量冻结</CardTitle>
              <p className="mt-1 text-xs text-slate-500">
                已选 {selectedRows.length} 份，{blockedCount} 份门禁未通过
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              {selectedRows.map(({ contract }) => (
                <div key={contract.id} className="rounded-md border border-slate-200 p-3 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <strong>{contract.name}</strong>
                    <input
                      className="w-24 rounded border border-slate-300 px-2 py-1 font-mono"
                      value={targetVersion(contract)}
                      onChange={(event) =>
                        setVersionOverrides((current) => ({
                          ...current,
                          [contract.id]: event.target.value,
                        }))
                      }
                    />
                  </div>
                  {contract.changes.some((change) => change.staleReason) && (
                    <p className="mt-2 flex items-center gap-1 text-red-700">
                      <TriangleAlert className="h-3 w-3" />
                      差异结论已失效，需要重新确认
                    </p>
                  )}
                </div>
              ))}
              {!selectedRows.length && (
                <p className="rounded-md border border-dashed border-slate-300 p-4 text-center text-xs text-slate-500">
                  从左侧勾选需要一起发布的契约。
                </p>
              )}
              <Textarea
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="统一发布说明：版本变化、兼容层和调用方升级状态"
              />
              <label className="flex items-center gap-2 text-xs text-slate-600">
                <Checkbox
                  checked={injectFailure}
                  onCheckedChange={(value) => setInjectFailure(value === true)}
                />
                演示：让本次批次在首个契约处写入失败（保留待恢复批次）
              </label>
              {batchError && (
                <p className="rounded border border-red-200 bg-red-50 p-2 text-xs leading-5 text-red-800">
                  {batchError}
                </p>
              )}
              {batchNotice && (
                <p className="rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-900">
                  {batchNotice}
                </p>
              )}
              <Button
                className="w-full"
                disabled={
                  !selectedRows.length ||
                  blockedCount > 0 ||
                  createBatch.isPending ||
                  selectedRows.some((row) => !targetVersion(row.contract).trim())
                }
                onClick={() => void submitBatch()}
              >
                <LockKeyhole className="h-4 w-4" />
                {createBatch.isPending ? '批量冻结中' : `冻结选中的 ${selectedRows.length} 份契约`}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>冻结策略</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm text-slate-600">
              <Policy icon={Archive} text="冻结快照即比较基线，保存定义时按基线重算字段差异。" />
              <Policy icon={PackageCheck} text="批量冻结逐项提交，失败只补未完成契约，不重复生成版本。" />
              <Policy icon={TriangleAlert} text="共享调用方确认失效会联动阻断关联契约的发布门禁。" />
            </CardContent>
          </Card>
        </div>
      </div>

      <Card className="mt-4">
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
                  <th className="px-4 py-3 font-medium">基线</th>
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
                    <td className="px-4 py-4">
                      {release.isBaseline ? (
                        <Badge tone="blue">当前基线</Badge>
                      ) : release.baselineBackfilled ? (
                        <Badge tone="amber">回填基线</Badge>
                      ) : (
                        <span className="text-xs text-slate-400">历史版本</span>
                      )}
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
    </div>
  );
}

function BatchRecoveryRow({
  batch,
  busy,
  onResume,
  onDiscard,
}: {
  batch: FreezeBatch;
  busy: boolean;
  onResume: () => void;
  onDiscard: () => void;
}) {
  const completed = batch.items.filter((item) => item.status === 'completed').length;
  const failed = batch.items.find((item) => item.status === 'failed');
  return (
    <div className="rounded-md border border-amber-200 bg-amber-50/60 p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <strong className="text-sm text-amber-950">批次 {batch.id}</strong>
        <Badge tone="amber">
          {completed}/{batch.items.length} 已完成
        </Badge>
        <span className="text-slate-500">创建于 {formatDateTime(batch.createdAt)}</span>
        <div className="ml-auto flex gap-2">
          <Button size="sm" disabled={busy} onClick={onResume}>
            <Play className="h-3.5 w-3.5" />
            继续未完成契约
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onDiscard}>
            <Eraser className="h-3.5 w-3.5" />
            丢弃批次
          </Button>
        </div>
      </div>
      {failed && (
        <p className="mt-2 text-xs leading-5 text-amber-900">
          <CheckCircle2 className="mr-1 inline h-3 w-3" />
          中断位置：{failed.contractName}（{failed.error}）。已冻结的 {completed} 份不会重复生成版本。
        </p>
      )}
      <ul className="mt-2 grid gap-1 md:grid-cols-2">
        {batch.items.map((item) => (
          <li key={item.contractId} className="flex items-center gap-2 text-[11px] text-slate-600">
            {item.status === 'completed' ? (
              <CheckCircle2 className="h-3 w-3 text-emerald-600" />
            ) : item.status === 'failed' ? (
              <TriangleAlert className="h-3 w-3 text-red-600" />
            ) : (
              <ClockIcon />
            )}
            {item.contractName} v{item.version}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ClockIcon() {
  return <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-slate-400" />;
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
