import {
  AUTO_DETECTED_KINDS,
  classifyChange,
  type ChangeKind,
  type Compatibility,
} from '../models/contract';

export type FieldLocation = 'request' | 'response';

export interface FieldDef {
  /** 稳定键：location|path|method|fieldName */
  key: string;
  path: string;
  method: string;
  fieldName: string;
  location: FieldLocation;
  type: string;
  required: boolean;
  enumValues: string[];
}

export interface DetectedChange {
  kind: ChangeKind;
  path: string;
  method: string;
  fieldName: string;
  location: FieldLocation;
  before: string;
  after: string;
  compatibility: Compatibility;
  rationale: string;
}

export type ParseStatus =
  | { ok: true; fields: FieldDef[] }
  | { ok: false; error: string };

interface JsonSchemaNode {
  type?: string;
  enum?: unknown[];
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  $ref?: string;
  allOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  anyOf?: JsonSchemaNode[];
}

interface OpenApiJson {
  paths?: Record<
    string,
    Record<
      string,
      {
        requestBody?: {
          content?: Record<string, { schema?: JsonSchemaNode }>;
        };
        responses?: Record<string, { content?: Record<string, { schema?: JsonSchemaNode }> }>;
      }
    >
  >;
  components?: { schemas?: Record<string, JsonSchemaNode> };
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const REQUEST_METHODS = new Set(['post', 'put', 'patch', 'delete']);

export function fieldKey(path: string, method: string, location: FieldLocation, fieldName: string) {
  return `${location}|${method.toUpperCase()}|${path}|${fieldName}`;
}

export function changeSignature(input: {
  kind: ChangeKind;
  path: string;
  method: string;
  fieldName?: string;
  before: string;
  after: string;
}): string {
  const method = input.method.toUpperCase();
  const field = input.fieldName || extractFieldName(input);
  return `${input.kind}|${method}|${input.path}|${field}|${input.before}->${input.after}`;
}

/** 旧手工清单的 before/after 文案里抽取字段名，用于回填签名（仅迁移兜底）。 */
function extractFieldName(input: { kind: ChangeKind; before: string; after: string }): string {
  const source = `${input.before} ${input.after}`;
  const match =
    source.match(/[A-Za-z_][\w.[\]]*/)?.[0] ??
    source.split(/\s+/).find((token) => /[A-Za-z]/.test(token)) ??
    'unknown';
  return match;
}

export function parseOpenApiDefinition(openapi: string): ParseStatus {
  const trimmed = openapi.trimStart();
  if (!trimmed) {
    return { ok: false, error: '接口定义为空。' };
  }
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as OpenApiJson;
      return { ok: true, fields: collectJsonFields(parsed) };
    } catch (error) {
      return {
        ok: false,
        error: `OpenAPI JSON 无法解析：${error instanceof Error ? error.message : '语法错误'}`,
      };
    }
  }
  return parseYamlLike(trimmed);
}

/* ---------------------------------- JSON --------------------------------- */

function resolveRef(node: JsonSchemaNode | undefined, doc: OpenApiJson): JsonSchemaNode | undefined {
  if (!node?.$ref) return node;
  const ref = node.$ref.replace(/^#\/components\/schemas\//, '');
  return doc.components?.schemas?.[ref];
}

function flattenSchema(
  node: JsonSchemaNode | undefined,
  doc: OpenApiJson,
  seen = new Set<string>(),
): JsonSchemaNode | undefined {
  if (!node) return undefined;
  if (node.$ref) {
    if (seen.has(node.$ref)) return undefined;
    const nextSeen = new Set(seen).add(node.$ref);
    return flattenSchema(resolveRef(node, doc), doc, nextSeen);
  }
  const combined = node.allOf?.map((item) => flattenSchema(item, doc, seen));
  if (combined?.length) {
    return {
      ...node,
      type: node.type ?? combined.find((item) => item?.type)?.type,
      enum: node.enum ?? combined.find((item) => item?.enum)?.enum,
      properties: Object.fromEntries(
        combined.flatMap((item) => Object.entries(item?.properties ?? {})),
      ),
      required: combined.flatMap((item) => item?.required ?? []),
    };
  }
  return node;
}

function collectProperties(
  schema: JsonSchemaNode | undefined,
  doc: OpenApiJson,
): Array<{ name: string; node: JsonSchemaNode; required: boolean }> {
  const flat = flattenSchema(schema, doc);
  if (!flat?.properties) return [];
  return Object.entries(flat.properties).map(([name, node]) => ({
    name,
    node,
    required: flat.required?.includes(name) ?? false,
  }));
}

function collectJsonFields(doc: OpenApiJson): FieldDef[] {
  const fields: FieldDef[] = [];
  for (const [apiPath, pathItem] of Object.entries(doc.paths ?? {})) {
    for (const [rawMethod, operation] of Object.entries(pathItem ?? {})) {
      const method = rawMethod.toLowerCase();
      if (!HTTP_METHODS.has(method)) continue;
      const requestSchema = operation.requestBody?.content?.['application/json']?.schema;
      collectProperties(requestSchema, doc).forEach(({ name, node, required }) => {
        fields.push(
          makeFieldDef(apiPath, method, REQUEST_METHODS.has(method) ? 'request' : 'response', name, {
            type: node.type ?? 'unknown',
            required,
            enumValues: (node.enum ?? []).map(String),
          }),
        );
      });
      const responseSchema =
        operation.responses?.['200']?.content?.['application/json']?.schema ??
        operation.responses?.['201']?.content?.['application/json']?.schema;
      collectProperties(responseSchema, doc).forEach(({ name, node, required }) => {
        fields.push(
          makeFieldDef(apiPath, method, 'response', name, {
            type: node.type ?? 'unknown',
            required,
            enumValues: (node.enum ?? []).map(String),
          }),
        );
      });
    }
  }
  return fields;
}

/* ------------------------------- YAML 子集 -------------------------------- */
/**
 * 支持种子数据使用的伪 YAML 形态：
 * - `paths:` 下两层缩进分别是 `/path:` 与 `method:`
 * - 字段支持内联 `name: { type: string, enum: [A, B], required: true }`
 * - 也支持 `properties:` 下的块状 `name: { ... }`
 * - 任意 `required: [a, b]` / `required:` 列表
 */
function parseYamlLike(source: string): ParseStatus {
  const lines = source.split('\n');
  const fields: FieldDef[] = [];
  let currentPath: string | null = null;
  let currentMethod: string | null = null;
  let inPaths = false;
  let pathIndent = -1;
  let methodIndent = -1;
  const pendingRequired: string[] = [];

  const location = (): FieldLocation =>
    currentMethod && REQUEST_METHODS.has(currentMethod) ? 'request' : 'response';

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, '  ');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const content = line.trim();

    if (indent === 0) {
      inPaths = content === 'paths:';
      currentPath = null;
      currentMethod = null;
      continue;
    }
    if (!inPaths) {
      const parsedRequired = parseRequiredList(content);
      if (parsedRequired) pendingRequired.push(...parsedRequired);
      continue;
    }

    if (!content.endsWith(':')) {
      const parsedRequired = parseRequiredList(content);
      if (parsedRequired) pendingRequired.push(...parsedRequired);
    }

    if (currentPath === null || indent <= pathIndent) {
      const pathMatch = /^(\/\S.*?):\s*$/.exec(content);
      if (pathMatch) {
        currentPath = pathMatch[1];
        pathIndent = indent;
        currentMethod = null;
        methodIndent = -1;
        continue;
      }
    }

    if (currentPath !== null) {
      if (currentMethod === null || indent <= methodIndent) {
        const methodMatch = /^(get|post|put|patch|delete|head|options):\s*$/.exec(content);
        if (methodMatch) {
          currentMethod = methodMatch[1];
          methodIndent = indent;
          continue;
        }
      }
    }

    if (currentPath && currentMethod && indent > methodIndent) {
      const field = parseInlineField(content);
      if (field) {
        const required = field.required || pendingRequired.includes(field.name);
        fields.push(
          makeFieldDef(currentPath, currentMethod, location(), field.name, {
            type: field.type,
            required,
            enumValues: field.enumValues,
          }),
        );
      }
    }
  }

  if (!fields.length) {
    return { ok: false, error: '未能从定义中识别出任何接口字段，请检查 paths 与字段格式。' };
  }
  return { ok: true, fields };
}

function parseRequiredList(content: string): string[] | null {
  const inline = /^required:\s*\[([^\]]*)\]\s*$/.exec(content);
  if (inline) {
    return inline[1]
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return null;
}

interface InlineField {
  name: string;
  type: string;
  required: boolean;
  enumValues: string[];
}

function parseInlineField(content: string): InlineField | null {
  const match = /^([A-Za-z_][\w.[\]]*)\s*:\s*\{(.+)\}\s*,?$/.exec(content);
  if (!match) return null;
  const [, name, body] = match;
  const typeMatch = /type:\s*["']?([\w|]+)["']?/.exec(body);
  const enumMatch = /enum:\s*\[([^\]]*)\]/.exec(body);
  return {
    name,
    type: typeMatch?.[1] ?? 'string',
    required: /required:\s*true/.test(body),
    enumValues: enumMatch
      ? enumMatch[1]
          .split(',')
          .map((item) => item.trim().replace(/^["']|["']$/g, ''))
          .filter(Boolean)
      : [],
  };
}

function makeFieldDef(
  apiPath: string,
  method: string,
  loc: FieldLocation,
  fieldName: string,
  detail: { type: string; required: boolean; enumValues: string[] },
): FieldDef {
  return {
    key: fieldKey(apiPath, method.toUpperCase(), loc, fieldName),
    path: apiPath,
    method: method.toUpperCase(),
    fieldName,
    location: loc,
    type: detail.type,
    required: detail.required,
    enumValues: detail.enumValues,
  };
}

/* ------------------------------- 比较逻辑 --------------------------------- */

function formatType(field: FieldDef): string {
  return `${fieldLabel(field)} 类型 ${field.type}`;
}

function fieldLabel(field: FieldDef): string {
  return `${field.method} ${field.path} ${field.location === 'request' ? '请求' : '响应'}字段 ${field.fieldName}`;
}

function enumLabel(values: string[]): string {
  return values.length ? values.join(' | ') : '（无枚举约束）';
}

export function diffFieldSets(baseline: FieldDef[], current: FieldDef[]): DetectedChange[] {
  const changes: DetectedChange[] = [];
  const baselineMap = new Map(baseline.map((field) => [field.key, field]));
  const currentMap = new Map(current.map((field) => [field.key, field]));

  for (const field of current) {
    const before = baselineMap.get(field.key);
    if (!before) {
      changes.push(buildDetected(field, 'field_added', '字段不存在', describeField(field)));
      continue;
    }
    if (before.type !== field.type) {
      changes.push(buildDetected(field, 'field_type_changed', formatType(before), formatType(field)));
    }
    if (before.required !== field.required) {
      changes.push(
        buildDetected(
          field,
          'optionality_changed',
          `${fieldLabel(field)}：${before.required ? '必填' : '可选'}`,
          `${fieldLabel(field)}：${field.required ? '必填' : '可选'}`,
        ),
      );
    }
    const beforeEnums = new Set(before.enumValues);
    const afterEnums = new Set(field.enumValues);
    const added = field.enumValues.filter((value) => !beforeEnums.has(value));
    const removed = before.enumValues.filter((value) => !afterEnums.has(value));
    if (added.length && !removed.length) {
      changes.push(
        buildDetected(
          field,
          'enum_expanded',
          `${fieldLabel(field)} 枚举 ${enumLabel(before.enumValues)}`,
          `${fieldLabel(field)} 枚举 ${enumLabel(field.enumValues)}`,
        ),
      );
    }
    if (removed.length) {
      changes.push(
        buildDetected(
          field,
          'enum_narrowed',
          `${fieldLabel(field)} 枚举 ${enumLabel(before.enumValues)}`,
          `${fieldLabel(field)} 枚举 ${enumLabel(field.enumValues.filter((v) => !removed.includes(v)))}`,
        ),
      );
    }
  }

  for (const field of baseline) {
    if (!currentMap.has(field.key)) {
      changes.push(buildDetected(field, 'field_removed', describeField(field), '字段已删除'));
    }
  }

  return changes.sort((left, right) => left.path.localeCompare(right.path) || right.kind.localeCompare(left.kind));
}

function describeField(field: FieldDef): string {
  return [
    fieldLabel(field),
    `类型 ${field.type}`,
    field.required ? '必填' : '可选',
    field.enumValues.length ? `枚举 ${enumLabel(field.enumValues)}` : '',
  ]
    .filter(Boolean)
    .join('，');
}

function buildDetected(
  field: FieldDef,
  kind: ChangeKind,
  before: string,
  after: string,
): DetectedChange {
  const classified = classifyChange({ kind, before, after });
  return {
    kind,
    path: field.path,
    method: field.method,
    fieldName: field.fieldName,
    location: field.location,
    before,
    after,
    compatibility: classified.compatibility,
    rationale: classified.rationale,
  };
}

export function isAutoDetectedKind(kind: ChangeKind): boolean {
  return AUTO_DETECTED_KINDS.has(kind);
}
