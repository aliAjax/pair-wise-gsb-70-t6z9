import {
  Check,
  CornerUpLeft,
  History,
  Layers3,
  Save,
  ShieldAlert,
  TriangleAlert,
  Users,
} from 'lucide-react';
import { useState } from 'react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import {
  CHANGE_KIND_LABELS,
  CONSUMER_CONFIRMATION_LABELS,
  type ApiConsumer,
  type ConsumerConfirmationState,
  type ContractChange,
  type ReviewState,
} from '../../models/contract';
import { CompatibilityBadge, ReviewStateBadge } from './compatibility-badge';

interface ChangeReviewItemProps {
  change: ContractChange;
  consumers: ApiConsumer[];
  onReview: (changeId: string, state: ReviewState, comment: string) => void;
  onUpdate: (changeId: string, patch: Partial<ContractChange>) => void;
  onExemption: (changeId: string, reason: string) => void;
  onConfirmConsumer: (input: {
    changeId: string;
    consumerId: string;
    state: ConsumerConfirmationState;
    note: string;
  }) => void;
}

export function ChangeReviewItem({
  change,
  consumers,
  onReview,
  onUpdate,
  onExemption,
  onConfirmConsumer,
}: ChangeReviewItemProps) {
  const [comment, setComment] = useState(change.reviewComment);
  const [impact, setImpact] = useState(change.impactStatement);
  const [migration, setMigration] = useState(change.migrationPlan);
  const [exemptionReason, setExemptionReason] = useState('');
  const [showExemption, setShowExemption] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [confirmConsumerId, setConfirmConsumerId] = useState(consumers[0]?.id ?? '');
  const [confirmNote, setConfirmNote] = useState('');

  const activeConfirmations = change.consumerConfirmations.filter(
    (confirmation) => !confirmation.invalidated,
  );
  const invalidatedConfirmations = change.consumerConfirmations.filter(
    (confirmation) => confirmation.invalidated,
  );

  return (
    <article className="border-b border-slate-200 px-4 py-4 last:border-0">
      {change.staleReason && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-xs leading-5 text-red-900">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-700" />
          <div>
            <strong>该差异的旧结论已失效，需要重新确认。</strong>
            <p className="mt-1">{change.staleReason}</p>
            <p className="mt-1 text-red-700">原评审与调用方确认已归档，可在下方“历史结论”中查看。</p>
          </div>
        </div>
      )}

      <div className="flex flex-col justify-between gap-3 lg:flex-row lg:items-start">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs font-semibold text-sky-900">
              {change.method} {change.path}
            </span>
            <CompatibilityBadge value={change.compatibility} />
            <ReviewStateBadge value={change.reviewState} />
            {change.legacy && <Badge tone="amber">基线补录</Badge>}
            {change.detectedAt && !change.staleReason && <Badge tone="blue">基线重算</Badge>}
          </div>
          <h3 className="mt-2 text-sm font-semibold text-slate-900">
            {CHANGE_KIND_LABELS[change.kind]}
            {change.fieldName && (
              <span className="ml-2 font-mono text-xs font-normal text-slate-500">
                {change.fieldName} · {change.fieldLocation === 'request' ? '请求' : '响应'}
              </span>
            )}
          </h3>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">{change.rationale}</p>
        </div>
        <div className="text-left text-xs text-slate-500 lg:text-right">
          <div>评审人：{change.reviewer || '未指定'}</div>
          <div className="mt-1">结论：{change.reviewComment || '尚无意见'}</div>
          {(change.reviewHistory.length > 0 || invalidatedConfirmations.length > 0) && (
            <button
              type="button"
              className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-sky-800 hover:underline"
              onClick={() => setShowHistory((value) => !value)}
            >
              <History className="h-3.5 w-3.5" />
              历史结论（{change.reviewHistory.length + invalidatedConfirmations.length}）
            </button>
          )}
        </div>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            基线
          </span>
          <pre className="mt-1 whitespace-pre-wrap font-mono text-xs leading-5 text-slate-700">
            {change.before}
          </pre>
        </div>
        <div className="rounded-md border border-sky-200 bg-sky-50 p-3">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-sky-700">
            当前定义
          </span>
          <pre className="mt-1 whitespace-pre-wrap font-mono text-xs leading-5 text-sky-950">
            {change.after}
          </pre>
        </div>
      </div>

      {showHistory && (
        <div className="mt-3 rounded-md border border-slate-200 bg-white p-3">
          <strong className="text-xs font-semibold text-slate-700">历史结论与确认（仅查不可用）</strong>
          <ul className="mt-2 space-y-2">
            {change.reviewHistory.map((entry) => (
              <li key={entry.id} className="rounded bg-slate-50 p-2 text-xs leading-5 text-slate-600">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="neutral">{entry.reviewState}</Badge>
                  <span>{entry.reviewer}</span>
                </div>
                <p className="mt-1">{entry.reviewComment}</p>
                <p className="mt-1 text-slate-400">失效原因：{entry.invalidatedReason}</p>
              </li>
            ))}
            {invalidatedConfirmations.map((confirmation) => (
              <li key={confirmation.id} className="rounded bg-red-50 p-2 text-xs leading-5 text-red-900">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="red">已失效</Badge>
                  <span>{confirmation.consumerName}</span>
                  <span>原结论：{CONSUMER_CONFIRMATION_LABELS[confirmation.state]}</span>
                </div>
                {confirmation.note && <p className="mt-1">{confirmation.note}</p>}
                <p className="mt-1 text-red-700">
                  {confirmation.invalidatedReason}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {change.compatibility !== 'compatible' && (
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-700">
              调用方影响说明
            </label>
            <Textarea
              value={impact}
              onChange={(event) => setImpact(event.target.value)}
              placeholder="受影响调用方、版本、流量和业务影响"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-700">迁移方案</label>
            <Textarea
              value={migration}
              onChange={(event) => setMigration(event.target.value)}
              placeholder="升级顺序、兼容层范围、回滚和截止时间"
            />
          </div>
        </div>
      )}

      {consumers.length > 0 && change.compatibility !== 'compatible' && (
        <div className="mt-4 rounded-md border border-slate-200 bg-slate-50/60 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Users className="h-4 w-4 text-sky-800" />
            <strong className="text-xs font-semibold text-slate-700">调用方确认</strong>
            {invalidatedConfirmations.length > 0 && (
              <Badge tone="red">{invalidatedConfirmations.length} 条确认已失效待重认</Badge>
            )}
          </div>
          <div className="mt-2 grid gap-2 lg:grid-cols-2">
            {consumers.map((consumer) => {
              const confirmation = [...change.consumerConfirmations]
                .reverse()
                .find((item) => item.consumerId === consumer.id);
              return (
                <div
                  key={consumer.id}
                  className="flex flex-wrap items-center gap-2 rounded border border-slate-200 bg-white px-2.5 py-2 text-xs"
                >
                  <span className="font-medium">{consumer.name}</span>
                  <span className="text-slate-400">{consumer.environment} · {consumer.clientVersion}</span>
                  {confirmation ? (
                    confirmation.invalidated ? (
                      <Badge tone="red">原确认已失效</Badge>
                    ) : (
                      <Badge tone="green">
                        {CONSUMER_CONFIRMATION_LABELS[confirmation.state]}
                      </Badge>
                    )
                  ) : (
                    <Badge tone="amber">未确认</Badge>
                  )}
                </div>
              );
            })}
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-[200px_1fr_auto]">
            <select
              className="rounded-md border border-slate-300 bg-white px-2.5 py-2 text-xs"
              value={confirmConsumerId}
              onChange={(event) => setConfirmConsumerId(event.target.value)}
            >
              {consumers.map((consumer) => (
                <option key={consumer.id} value={consumer.id}>
                  {consumer.name}
                </option>
              ))}
            </select>
            <Textarea
              className="min-h-0 text-xs"
              value={confirmNote}
              onChange={(event) => setConfirmNote(event.target.value)}
              placeholder="调用方确认说明（版本兼容、升级窗口或兼容层诉求）"
            />
            <div className="flex gap-1.5">
              <Button
                size="sm"
                variant="secondary"
                disabled={!confirmConsumerId}
                onClick={() => {
                  onConfirmConsumer({
                    changeId: change.id,
                    consumerId: confirmConsumerId,
                    state: 'confirmed',
                    note: confirmNote,
                  });
                  setConfirmNote('');
                }}
              >
                <Check className="h-3.5 w-3.5" />
                确认接受
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!confirmConsumerId}
                onClick={() => {
                  onConfirmConsumer({
                    changeId: change.id,
                    consumerId: confirmConsumerId,
                    state: 'exemption',
                    note: confirmNote,
                  });
                  setConfirmNote('');
                }}
              >
                <Layers3 className="h-3.5 w-3.5" />
                兼容层
              </Button>
            </div>
          </div>
          {invalidatedConfirmations.length > 0 && (
            <p className="mt-2 flex items-center gap-1 text-[11px] text-red-700">
              <TriangleAlert className="h-3 w-3" />
              关联契约定义改动后，共享调用方的确认已一起失效；请重新逐条确认，发布门禁才会放行。
            </p>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-col gap-3 border-t border-slate-100 pt-4 xl:flex-row xl:items-end">
        <div className="min-w-0 flex-1">
          <label className="mb-1.5 block text-xs font-medium text-slate-700">评审意见</label>
          <Textarea
            className="min-h-16"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="说明接受、退回或豁免的依据"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              onUpdate(change.id, {
                impactStatement: impact,
                migrationPlan: migration,
              })
            }
          >
            <Save className="h-3.5 w-3.5" />
            保存说明
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onReview(change.id, 'returned', comment || '需要补充影响说明')}
          >
            <CornerUpLeft className="h-3.5 w-3.5" />
            退回
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowExemption((value) => !value)}
          >
            <Layers3 className="h-3.5 w-3.5" />
            申请兼容层
          </Button>
          <Button
            size="sm"
            onClick={() => onReview(change.id, 'accepted', comment || '影响和迁移方案已确认')}
          >
            <Check className="h-3.5 w-3.5" />
            接受
          </Button>
        </div>
      </div>

      {showExemption && (
        <div className="mt-3 rounded-md border border-blue-200 bg-blue-50 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="blue">兼容层豁免</Badge>
            <span className="text-xs text-blue-900">期限 30 天，发布报告保留记录</span>
          </div>
          <Textarea
            className="mt-3 bg-white"
            value={exemptionReason}
            onChange={(event) => setExemptionReason(event.target.value)}
            placeholder="说明为什么不能立即移除不兼容变化"
          />
          <div className="mt-3 flex justify-end">
            <Button
              size="sm"
              disabled={!exemptionReason.trim()}
              onClick={() => {
                onExemption(change.id, exemptionReason);
                setExemptionReason('');
                setShowExemption(false);
              }}
            >
              登记豁免
            </Button>
          </div>
        </div>
      )}

      {activeConfirmations.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {activeConfirmations.map((confirmation) => (
            <Badge key={confirmation.id} tone="green">
              {confirmation.consumerName}：{CONSUMER_CONFIRMATION_LABELS[confirmation.state]}
            </Badge>
          ))}
        </div>
      )}
    </article>
  );
}
