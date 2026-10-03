import { stableChecksum } from './utils';
import {
  classifyChange,
  type ApiContract,
  type BaselineRef,
  type ChangeKind,
  type ContractChange,
  type ReviewConfirmation,
} from '../models/contract';

/**
 * 契约定义差异引擎。
 *
 * 以冻结版本快照为比较基线，解析 OpenAPI 文本（JSON 或工程内使用的 YAML 子集），
 * 重算字段增删、类型、枚举、必填与错误码变化。解析失败时返回 null，
 * 调用方必须保留原有差异清单，避免误清空评审结论。
 */

type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

interface FieldShape {
  type: string;
  required: boolean;
  enumValues: string[];
}

interface OperationShape {
  path: string;
  method: string;
  request: Map<string, FieldShape>;
  response: Map<string, FieldShape>;
  errorCodes: Set<string>;
}

export interface ExtractedSpec {
  operations: OperationShape[];
}

export interface DiffItem {
  path: string;
  method: string;
  kind: ChangeKind;
  target: string;
  side: 'request' | 'response' | 'error';
  before: string;
  after: string;
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

function isRecord(value: YamlValue | undefined): value is { [key: string]: YamlValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asStringList(value: YamlValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string | number => typeof item === 'string' || typeof item === 'number')
    .map(String);
}

function splitTopLevel(text: string, delimiter: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (const char of text) {
    if (quote) {
      current += char;
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '{' || char === '[') depth += 1;
    if (char === '}' || char === ']') depth -= 1;
    if (char === delimiter && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim());
}

function unquote(text: string): string {
  const trimmed = text.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseInline(text: string): YamlValue {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const map: { [key: string]: YamlValue } = {};
    for (const part of splitTopLevel(trimmed.slice(1, -1), ',')) {
      if (!part) continue;
      const separator = splitTopLevel(part, ':');
      if (separator.length < 2) continue;
      map[unquote(separator[0])] = parseInline(separator.slice(1).join(':'));
    }
    return map;
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return splitTopLevel(trimmed.slice(1, -1), ',')
      .filter((part) => part.length > 0)
      .map((part) => parseInline(part));
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null' || trimmed === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return unquote(trimmed);
}

/** 解析工程内使用的 YAML 子集：缩进块、- 序列、{}/[] 流式结构、引号标量。 */
function parseYamlSubset(text: string): YamlValue {
  const lines = text
    .split('\n')
    .map((raw) => raw.replace(/\t/g, '  '))
    .filter((raw) => raw.trim().length > 0 && !raw.trim().startsWith('#'))
    .map((raw) => ({ indent: raw.length - raw.trimStart().length, content: raw.trim() }));
  if (!lines.length) return null;
  let index = 0;

  function parseBlock(indent: number): YamlValue {
    const first = lines[index];
    if (first.content.startsWith('- ')) {
      const list: YamlValue[] = [];
      while (
        index < lines.length &&
        lines[index].indent === indent &&
        lines[index].content.startsWith('- ')
      ) {
        const inline = lines[index].content.slice(2);
        const colonIndex = inline.indexOf(':');
        const isMapEntry =
          colonIndex > 0 &&
          !inline.startsWith('{') &&
          !inline.startsWith('[') &&
          (inline[colonIndex + 1] === ' ' || colonIndex === inline.length - 1);
        if (isMapEntry) {
          list.push({
            [unquote(inline.slice(0, colonIndex))]: parseInline(inline.slice(colonIndex + 1)),
          });
        } else {
          list.push(parseInline(inline));
        }
        index += 1;
        if (index < lines.length && lines[index].indent > indent) {
          const rest = parseBlock(lines[index].indent);
          const last = list[list.length - 1];
          if (isRecord(last) && isRecord(rest)) {
            list[list.length - 1] = { ...last, ...rest };
          }
        }
      }
      return list;
    }
    const map: { [key: string]: YamlValue } = {};
    while (
      index < lines.length &&
      lines[index].indent === indent &&
      !lines[index].content.startsWith('- ')
    ) {
      const separator = splitTopLevel(lines[index].content, ':');
      const key = unquote(separator[0] ?? '');
      const inline = separator.slice(1).join(':').trim();
      index += 1;
      if (inline) {
        map[key] = parseInline(inline);
      } else if (index < lines.length && lines[index].indent > indent) {
        map[key] = parseBlock(lines[index].indent);
      } else {
        map[key] = null;
      }
    }
    return map;
  }

  return parseBlock(lines[0].indent);
}

export function parseSpecText(text: string): YamlValue | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed) as YamlValue;
    } catch {
      return null;
    }
  }
  try {
    return parseYamlSubset(trimmed);
  } catch {
    return null;
  }
}

function dig(value: YamlValue | undefined, path: string[]): YamlValue | undefined {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function extractFields(schema: YamlValue | undefined): Map<string, FieldShape> {
  const fields = new Map<string, FieldShape>();
  let target = schema;
  if (isRecord(target) && target.type === 'array') {
    target = target.items;
  }
  if (!isRecord(target) || !isRecord(target.properties)) return fields;
  const required = new Set(asStringList(target.required));
  for (const [name, raw] of Object.entries(target.properties)) {
    const shape = isRecord(raw) ? raw : {};
    fields.set(name, {
      type: typeof shape.type === 'string' ? shape.type : 'object',
      required: required.has(name),
      enumValues: asStringList(shape.enum),
    });
  }
  return fields;
}

function responseSchema(operation: { [key: string]: YamlValue }): YamlValue | undefined {
  const responses = operation.responses;
  if (!isRecord(responses)) return undefined;
  const successKey =
    Object.keys(responses).find((key) => key.startsWith('2')) ?? Object.keys(responses)[0];
  if (!successKey) return undefined;
  return dig(responses[successKey], ['content', 'application/json', 'schema']);
}

export function extractSpec(root: YamlValue | null): ExtractedSpec | null {
  if (!isRecord(root) || !isRecord(root.paths)) return null;
  const globalErrorCodes = new Set(asStringList(root['x-error-codes']));
  const problemCodeEnum = dig(root, ['components', 'schemas', 'Problem', 'properties', 'code']);
  if (isRecord(problemCodeEnum)) {
    asStringList(problemCodeEnum.enum).forEach((code) => globalErrorCodes.add(code));
  }

  const operations: OperationShape[] = [];
  for (const [path, methods] of Object.entries(root.paths)) {
    if (!isRecord(methods)) continue;
    for (const [method, rawOperation] of Object.entries(methods)) {
      if (!HTTP_METHODS.has(method.toLowerCase()) || !isRecord(rawOperation)) continue;
      const errorCodes = new Set(globalErrorCodes);
      asStringList(rawOperation['x-error-codes']).forEach((code) => errorCodes.add(code));
      operations.push({
        path,
        method: method.toUpperCase(),
        request: extractFields(
          dig(rawOperation, ['requestBody', 'content', 'application/json', 'schema']),
        ),
        response: extractFields(responseSchema(rawOperation)),
        errorCodes,
      });
    }
  }
  return { operations };
}

const SIDE_LABELS = { request: '请求', response: '响应', error: '错误码' } as const;

function formatField(name: string, field: FieldShape): string {
  const enumText = field.enumValues.length ? ` [${field.enumValues.join(' | ')}]` : '';
  return `${name}: ${field.type}${enumText}`;
}

function diffFieldMaps(
  path: string,
  method: string,
  side: 'request' | 'response',
  before: Map<string, FieldShape>,
  after: Map<string, FieldShape>,
  items: DiffItem[],
): void {
  const label = SIDE_LABELS[side];
  for (const [name, field] of after) {
    const previous = before.get(name);
    if (!previous) {
      items.push({
        path,
        method,
        kind: 'field_added',
        target: name,
        side,
        before: `${label}字段集合不含 ${name}`,
        after: `新增${field.required ? '必填' : '可选'}${label}字段 ${formatField(name, field)}`,
      });
      continue;
    }
    if (previous.type !== field.type) {
      items.push({
        path,
        method,
        kind: 'type_changed',
        target: name,
        side,
        before: `${label}字段 ${name}: ${previous.type}`,
        after: `${label}字段 ${name} 类型变为 ${field.type}`,
      });
    }
    if (previous.required !== field.required) {
      items.push({
        path,
        method,
        kind: 'optionality_changed',
        target: name,
        side,
        before: `${name} 为${previous.required ? '必填' : '可选'}字段`,
        after: `${name} 变为${field.required ? '必填' : '可选'}字段`,
      });
    }
    const addedEnum = field.enumValues.filter((value) => !previous.enumValues.includes(value));
    const removedEnum = previous.enumValues.filter((value) => !field.enumValues.includes(value));
    if (addedEnum.length) {
      items.push({
        path,
        method,
        kind: 'enum_expanded',
        target: name,
        side,
        before: `${name}: ${previous.enumValues.join(' | ') || '（空枚举）'}`,
        after: `${name}: ${field.enumValues.join(' | ')}`,
      });
    }
    if (removedEnum.length) {
      items.push({
        path,
        method,
        kind: 'enum_reduced',
        target: name,
        side,
        before: `${name}: ${previous.enumValues.join(' | ')}`,
        after: `${name}: ${field.enumValues.join(' | ') || '（空枚举）'}`,
      });
    }
  }
  for (const [name, field] of before) {
    if (after.has(name)) continue;
    items.push({
      path,
      method,
      kind: 'field_removed',
      target: name,
      side,
      before: `${label}字段 ${formatField(name, field)}`,
      after: `移除${label}字段 ${name}`,
    });
  }
}

export function diffSpecs(baseline: ExtractedSpec, current: ExtractedSpec): DiffItem[] {
  const items: DiffItem[] = [];
  const baselineByOperation = new Map(
    baseline.operations.map((operation) => [`${operation.method} ${operation.path}`, operation]),
  );
  const currentByOperation = new Map(
    current.operations.map((operation) => [`${operation.method} ${operation.path}`, operation]),
  );

  for (const operation of current.operations) {
    const previous = baselineByOperation.get(`${operation.method} ${operation.path}`);
    diffFieldMaps(
      operation.path,
      operation.method,
      'request',
      previous?.request ?? new Map(),
      operation.request,
      items,
    );
    diffFieldMaps(
      operation.path,
      operation.method,
      'response',
      previous?.response ?? new Map(),
      operation.response,
      items,
    );
    const beforeCodes = previous?.errorCodes ?? new Set<string>();
    for (const code of operation.errorCodes) {
      if (!beforeCodes.has(code)) {
        items.push({
          path: operation.path,
          method: operation.method,
          kind: 'error_code_added',
          target: code,
          side: 'error',
          before: `错误码集合不含 ${code}`,
          after: `新增错误码 ${code}`,
        });
      }
    }
    for (const code of beforeCodes) {
      if (!operation.errorCodes.has(code)) {
        items.push({
          path: operation.path,
          method: operation.method,
          kind: 'error_code_removed',
          target: code,
          side: 'error',
          before: `错误码集合包含 ${code}`,
          after: `移除错误码 ${code}`,
        });
      }
    }
  }

  for (const operation of baseline.operations) {
    if (currentByOperation.has(`${operation.method} ${operation.path}`)) continue;
    diffFieldMaps(
      operation.path,
      operation.method,
      'request',
      operation.request,
      new Map(),
      items,
    );
    diffFieldMaps(
      operation.path,
      operation.method,
      'response',
      operation.response,
      new Map(),
      items,
    );
    for (const code of operation.errorCodes) {
      items.push({
        path: operation.path,
        method: operation.method,
        kind: 'error_code_removed',
        target: code,
        side: 'error',
        before: `错误码集合包含 ${code}`,
        after: `移除错误码 ${code}`,
      });
    }
  }

  return items;
}

export function changeFingerprint(input: {
  kind: ChangeKind;
  path: string;
  method: string;
  before: string;
  after: string;
}): string {
  return stableChecksum(
    [input.kind, input.method, input.path, input.before, input.after].join('|'),
  );
}

function identityKey(input: {
  kind: ChangeKind;
  path: string;
  method: string;
  target?: string;
  side?: string;
}): string {
  return [input.method, input.path, input.kind, input.side ?? '', input.target ?? ''].join('|');
}

export function baselineRefOf(version: {
  id: string;
  version: string;
  checksum: string;
}): BaselineRef {
  return {
    versionId: version.id,
    version: version.version,
    checksum: version.checksum,
    source: 'frozen',
  };
}

export function diffItemToChange(
  contractId: string,
  item: DiffItem,
  baseline: BaselineRef,
): ContractChange {
  const classified = classifyChange(item);
  const fingerprint = changeFingerprint(item);
  return {
    id: `chg-${stableChecksum([contractId, identityKey(item), fingerprint].join('|'))}`,
    path: item.path,
    method: item.method,
    kind: item.kind,
    target: item.target,
    side: item.side,
    before: item.before,
    after: item.after,
    compatibility: classified.compatibility,
    rationale: classified.rationale,
    impactStatement: '',
    migrationPlan: '',
    reviewState: 'pending',
    reviewer: '',
    reviewComment: '',
    fingerprint,
    baseline,
  };
}

function toConfirmation(
  change: ContractChange,
  reason: string,
  invalidatedAt: string,
): ReviewConfirmation {
  return {
    id: `cnf-${stableChecksum(
      [change.id, change.reviewState, change.reviewedAt ?? '', invalidatedAt].join('|'),
    )}`,
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
    confirmedAt: change.reviewedAt ?? invalidatedAt,
    invalidatedAt,
    reason,
  };
}

export interface ReconcileResult {
  changes: ContractChange[];
  confirmations: ReviewConfirmation[];
  invalidated: number;
  baseline: BaselineRef;
}

/**
 * 以最近冻结版本为基线重算差异，并与现有清单对齐：
 * - 指纹一致的差异保留原结论；
 * - 同一字段/错误码但内容变化的差异，原结论归档失效，重置为待评审；
 * - 已消失的差异，其结论与说明归档到确认历史。
 * 无基线或定义无法解析时返回 null，调用方保留原清单。
 */
export function reconcileChanges(
  contract: ApiContract,
  nextOpenApi: string,
  now: string = new Date().toISOString(),
): ReconcileResult | null {
  const baselineVersion = contract.versions[0];
  if (!baselineVersion) return null;
  const baselineSpec = extractSpec(parseSpecText(baselineVersion.openapi));
  const nextSpec = extractSpec(parseSpecText(nextOpenApi));
  if (!baselineSpec || !nextSpec) return null;

  const baseline = baselineRefOf(baselineVersion);
  const diffItems = diffSpecs(baselineSpec, nextSpec);
  const confirmations = [...contract.confirmations];
  const consumed = new Set<string>();
  let invalidated = 0;

  const byFingerprint = new Map(
    contract.changes.map((change) => [change.fingerprint ?? changeFingerprint(change), change]),
  );
  const byIdentity = new Map(contract.changes.map((change) => [identityKey(change), change]));

  const changes = diffItems.map((item) => {
    const fingerprint = changeFingerprint(item);
    const exact = byFingerprint.get(fingerprint);
    if (exact && !consumed.has(exact.id)) {
      consumed.add(exact.id);
      return { ...exact, baseline, fingerprint };
    }
    const shifted = byIdentity.get(identityKey(item));
    if (shifted && !consumed.has(shifted.id)) {
      consumed.add(shifted.id);
      if (shifted.reviewState !== 'pending') {
        confirmations.unshift(toConfirmation(shifted, '接口定义已变化，原确认失效，需重新确认', now));
        invalidated += 1;
      }
      const regenerated = diffItemToChange(contract.id, item, baseline);
      return {
        ...regenerated,
        id: shifted.id,
        impactStatement: shifted.impactStatement,
        migrationPlan: shifted.migrationPlan,
      };
    }
    return diffItemToChange(contract.id, item, baseline);
  });

  for (const change of contract.changes) {
    if (consumed.has(change.id)) continue;
    if (change.reviewState !== 'pending' || change.impactStatement || change.migrationPlan) {
      confirmations.unshift(toConfirmation(change, '差异已不在当前定义中，原确认归档', now));
      if (change.reviewState !== 'pending') invalidated += 1;
    }
  }

  return { changes, confirmations, invalidated, baseline };
}

/** 旧数据缺少基线时，按首个冻结快照回填差异基线。 */
export function backfillBaselines(contract: ApiContract): ApiContract {
  const firstFrozen = contract.versions[0];
  if (!firstFrozen) return contract;
  const ref: BaselineRef = { ...baselineRefOf(firstFrozen), source: 'backfilled' };
  return {
    ...contract,
    changes: contract.changes.map((change) =>
      change.baseline ? change : { ...change, baseline: ref },
    ),
  };
}
