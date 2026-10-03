import { ArchiveRestore } from 'lucide-react';
import { Badge } from '../ui/badge';
import { CHANGE_KIND_LABELS, type ArchivedChange } from '../../models/contract';
import { CompatibilityBadge } from './compatibility-badge';
import { formatDateTime } from '../../lib/utils';

export function ArchivedChangesPanel({ changes }: { changes: ArchivedChange[] }) {
  if (!changes.length) return null;
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50/60">
      <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3">
        <ArchiveRestore className="h-4 w-4 text-slate-500" />
        <strong className="text-sm text-slate-700">已失效 / 已冻结归档（{changes.length}）</strong>
        <span className="text-xs text-slate-500">原评审与调用方确认仍可查，但不再作为门禁依据</span>
      </div>
      <ul className="divide-y divide-slate-200">
        {changes.map((change) => (
          <li key={change.id} className="px-4 py-3 text-xs leading-5 text-slate-600">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono font-semibold text-slate-700">
                {change.method} {change.path}
              </span>
              <CompatibilityBadge value={change.compatibility} />
              <Badge tone="neutral">{CHANGE_KIND_LABELS[change.kind]}</Badge>
              {change.releasedInVersion && (
                <Badge tone="slate">随 v{change.releasedInVersion} 冻结</Badge>
              )}
              <span className="ml-auto text-slate-400">{formatDateTime(change.archivedAt)}</span>
            </div>
            <p className="mt-1.5">{change.archivedReason}</p>
            <div className="mt-1.5 grid gap-1 md:grid-cols-2">
              <span className="text-slate-500">基线：{change.before}</span>
              <span className="text-slate-500">当时定义：{change.after}</span>
            </div>
            {(change.reviewer || change.consumerConfirmations.length > 0) && (
              <p className="mt-1.5 text-slate-500">
                {change.reviewer && `原结论 ${change.reviewState}（${change.reviewer}）`}
                {change.consumerConfirmations.length > 0 &&
                  `；调用方确认：${change.consumerConfirmations
                    .map(
                      (confirmation) =>
                        `${confirmation.consumerName}${
                          confirmation.invalidated ? '（已失效）' : ''
                        }`,
                    )
                    .join('、')}`}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
