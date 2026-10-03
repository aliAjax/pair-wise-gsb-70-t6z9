import type { ApiContract, ContractChange } from '../models/contract';
import { classifyChange } from '../models/contract';
import {
  baselineRefOf,
  changeFingerprint,
  diffItemToChange,
  diffSpecs,
  extractSpec,
  parseSpecText,
} from '../lib/spec-diff';
import { stableChecksum } from '../lib/utils';

interface SeedField {
  name: string;
  type?: string;
  required?: boolean;
  enum?: string[];
}

interface SeedOperation {
  path: string;
  method: string;
  summary: string;
  request?: SeedField[];
  response?: SeedField[];
  errorCodes?: string[];
}

function fieldLine(field: SeedField): string {
  const enumText = field.enum?.length ? `, enum: [${field.enum.join(', ')}]` : '';
  return `${field.name}: { type: "${field.type ?? 'string'}"${enumText} }`;
}

function schemaBlock(fields: SeedField[], indent: string): string[] {
  const required = fields.filter((field) => field.required).map((field) => field.name);
  return [
    `${indent}type: object`,
    ...(required.length ? [`${indent}required: [${required.join(', ')}]`] : []),
    `${indent}properties:`,
    ...fields.map((field) => `${indent}  ${fieldLine(field)}`),
  ];
}

function openApi(title: string, version: string, operations: SeedOperation[]): string {
  const lines: string[] = [
    'openapi: 3.1.0',
    'info:',
    `  title: ${title}`,
    `  version: ${version}`,
    'servers:',
    '  - url: https://api.example.com',
    'paths:',
  ];
  for (const operation of operations) {
    lines.push(
      `  ${operation.path}:`,
      `    ${operation.method}:`,
      `      summary: ${operation.summary}`,
    );
    if (operation.errorCodes?.length) {
      lines.push(`      x-error-codes: [${operation.errorCodes.join(', ')}]`);
    }
    if (operation.request?.length) {
      lines.push(
        '      requestBody:',
        '        content:',
        '          application/json:',
        '            schema:',
        ...schemaBlock(operation.request, '              '),
      );
    }
    if (operation.response?.length) {
      lines.push(
        '      responses:',
        "        '200':",
        '          description: 成功',
        '          content:',
        '            application/json:',
        '              schema:',
        ...schemaBlock(operation.response, '                '),
      );
    }
  }
  lines.push(
    'components:',
    '  schemas:',
    '    Problem:',
    '      type: object',
    '      properties:',
    '        code: { type: string }',
    '        message: { type: string }',
    '',
  );
  return lines.join('\n');
}

/** 由差异引擎根据冻结快照与当前定义生成变更清单，保证指纹与后续重算一致。 */
function seedChanges(
  contractId: string,
  baselineText: string,
  currentText: string,
  baselineVersion: { id: string; version: string; checksum: string },
  overrides: Record<string, Partial<ContractChange>>,
): ContractChange[] {
  const baselineSpec = extractSpec(parseSpecText(baselineText));
  const currentSpec = extractSpec(parseSpecText(currentText));
  if (!baselineSpec || !currentSpec) return [];
  const baseline = baselineRefOf(baselineVersion);
  return diffSpecs(baselineSpec, currentSpec).map((item) => {
    const change = diffItemToChange(contractId, item, baseline);
    const override = overrides[`${item.method} ${item.path} ${item.kind} ${item.target}`];
    return override ? { ...change, ...override } : change;
  });
}

const orderOperationsV270: SeedOperation[] = [
  {
    path: '/orders/{orderId}',
    method: 'get',
    summary: '查询订单',
    errorCodes: ['ORDER_NOT_FOUND'],
    request: [
      { name: 'orderId', required: true },
      { name: 'includeTimeline', type: 'boolean' },
      { name: 'currency' },
    ],
    response: [
      { name: 'orderId', required: true },
      { name: 'status', enum: ['CREATED', 'PAID', 'CANCELLED'], required: true },
      { name: 'total', type: 'number' },
    ],
  },
  {
    path: '/orders/{orderId}/cancel',
    method: 'post',
    summary: '取消订单',
    request: [
      { name: 'orderId', required: true },
      { name: 'reason' },
      { name: 'requestId' },
    ],
    response: [{ name: 'cancelled', type: 'boolean', required: true }],
  },
];

const orderOperationsV280: SeedOperation[] = [
  {
    ...orderOperationsV270[0],
    response: [
      { name: 'orderId', required: true },
      { name: 'status', enum: ['CREATED', 'PAID', 'CANCELLED', 'PARTIAL_REFUND'], required: true },
      { name: 'total', type: 'number' },
      { name: 'loyaltyDiscount', type: 'number' },
    ],
  },
  {
    ...orderOperationsV270[1],
    request: [
      { name: 'orderId', required: true },
      { name: 'reason' },
      { name: 'requestId', required: true },
    ],
  },
];

const paymentOperationsV410: SeedOperation[] = [
  {
    path: '/payments/{paymentId}',
    method: 'get',
    summary: '查询支付单',
    errorCodes: ['PAYMENT_NOT_FOUND'],
    request: [{ name: 'paymentId', required: true }],
    response: [
      { name: 'paymentId', required: true },
      { name: 'settlementBatchId' },
      { name: 'status' },
    ],
  },
  {
    path: '/refunds',
    method: 'post',
    summary: '创建退款',
    request: [
      { name: 'paymentId', required: true },
      { name: 'amount', type: 'number', required: true },
      { name: 'reason' },
    ],
    response: [{ name: 'refundId', required: true }],
  },
];

const paymentOperationsV420: SeedOperation[] = [
  {
    ...paymentOperationsV410[0],
    errorCodes: ['PAYMENT_NOT_FOUND', 'RISK_HOLD'],
    response: [{ name: 'paymentId', required: true }, { name: 'status' }],
  },
  paymentOperationsV410[1],
];

const userOperationsV1140: SeedOperation[] = [
  {
    path: '/users/{userId}',
    method: 'get',
    summary: '查询用户',
    request: [
      { name: 'userId', required: true },
      { name: 'includeRoles', type: 'boolean' },
    ],
    response: [
      { name: 'userId', required: true },
      { name: 'displayName' },
      { name: 'effectiveRoles', type: 'string[]' },
    ],
  },
];

const orderOpenApiV270 = openApi('订单履约 API', '2.7.0', orderOperationsV270);
const orderOpenApiV280 = openApi('订单履约 API', '2.8.0', orderOperationsV280);
const paymentOpenApiV410 = openApi('支付清算 API', '4.1.0', paymentOperationsV410);
const paymentOpenApiV420 = openApi('支付清算 API', '4.2.0', paymentOperationsV420);
const userOpenApi = openApi('用户权限 API', '1.14.0', userOperationsV1140);

const orderBaseline = {
  id: 'ver-order-270',
  version: '2.7.0',
  checksum: stableChecksum(orderOpenApiV270),
};
const paymentBaseline = {
  id: 'ver-pay-410',
  version: '4.1.0',
  checksum: stableChecksum(paymentOpenApiV410),
};

const orderChanges = seedChanges('contract-order', orderOpenApiV270, orderOpenApiV280, orderBaseline, {
  'GET /orders/{orderId} field_added loyaltyDiscount': {
    reviewState: 'accepted',
    reviewer: '林墨',
    reviewComment: '可选响应字段，旧客户端忽略即可。',
    reviewedAt: '2026-09-29T02:10:00.000Z',
  },
  'POST /orders/{orderId}/cancel optionality_changed requestId': {
    impactStatement: '取消订单客户端 12 个，其中 3 个生产调用方尚未升级。',
    migrationPlan: '发布前完成三个调用方灰度升级，兼容层保留 30 天。',
  },
  'GET /orders/{orderId} enum_expanded status': {
    impactStatement: 'BI 报表和客服工作台会读取订单状态。',
    migrationPlan: '调用方增加未知状态兜底，项目组完成 SDK 4.7.0 升级。',
    reviewState: 'accepted',
    reviewer: '周言',
    reviewComment: '影响说明完整，允许进入兼容层观察。',
    reviewedAt: '2026-09-29T03:01:00.000Z',
  },
});

const paymentChanges = seedChanges(
  'contract-payment',
  paymentOpenApiV410,
  paymentOpenApiV420,
  paymentBaseline,
  {
    'GET /payments/{paymentId} field_removed settlementBatchId': {
      impactStatement: '财务对账服务仍使用该字段匹配批次。',
      migrationPlan: '先由对账服务切换 paymentId 匹配，稳定两周后删除字段。',
      reviewState: 'returned',
      reviewer: '韩度',
      reviewComment: '迁移方案未包含历史数据核对，退回补充。',
      reviewedAt: '2026-09-28T10:40:00.000Z',
    },
    'GET /payments/{paymentId} error_code_added RISK_HOLD': {
      impactStatement: '支付查询客户端会把未知错误码归类为系统异常。',
      migrationPlan: 'SDK 增加人工审核提示，旧客户端保持原错误兜底。',
      reviewState: 'accepted',
      reviewer: '韩度',
      reviewComment: '影响范围清晰。',
      reviewedAt: '2026-09-28T08:20:00.000Z',
    },
  },
);

const requestIdChange = orderChanges.find(
  (change) => change.kind === 'optionality_changed' && change.target === 'requestId',
);

const userManualChange: ContractChange = {
  id: 'chg-user-effectiveRoles',
  path: '/users/{userId}',
  method: 'GET',
  kind: 'field_added',
  target: 'effectiveRoles',
  side: 'response',
  before: '响应字段集合不含 effectiveRoles',
  after: '新增可选响应字段 effectiveRoles: string[]',
  ...classifyChange({
    kind: 'field_added',
    before: '响应字段集合不含 effectiveRoles',
    after: '新增可选响应字段 effectiveRoles: string[]',
  }),
  impactStatement: '',
  migrationPlan: '',
  reviewState: 'accepted',
  reviewer: '宋川',
  reviewComment: '可选字段，不影响旧客户端。',
  reviewedAt: '2026-09-27T06:15:00.000Z',
  // 契约尚无冻结版本，该差异未与基线核对，首次冻结时按首个冻结快照回填
  fingerprint: changeFingerprint({
    kind: 'field_added',
    path: '/users/{userId}',
    method: 'GET',
    before: '响应字段集合不含 effectiveRoles',
    after: '新增可选响应字段 effectiveRoles: string[]',
  }),
};

export const seedContracts: ApiContract[] = [
  {
    id: 'contract-order',
    name: '订单履约 API',
    version: '2.8.0',
    domain: '交易履约',
    owner: '订单平台组',
    protocol: 'REST',
    status: 'review',
    updatedAt: '2026-09-29T03:12:00.000Z',
    openapi: orderOpenApiV280,
    changes: orderChanges,
    consumers: [
      {
        id: 'consumer-app',
        name: '订单中心',
        owner: '交易应用组',
        environment: '生产',
        clientVersion: '4.6.2',
        requestsPerDay: 4800000,
        contact: 'app-order@example.com',
      },
      {
        id: 'consumer-cs',
        name: '客服工作台',
        owner: '服务体验组',
        environment: '生产',
        clientVersion: '3.9.0',
        requestsPerDay: 680000,
        contact: 'cs-platform@example.com',
      },
      {
        id: 'consumer-bi',
        name: '经营分析',
        owner: '数据产品组',
        environment: '预发',
        clientVersion: '2.1.5',
        requestsPerDay: 220000,
        contact: 'bi-api@example.com',
      },
    ],
    exemptions: [
      {
        id: 'ex-order-1',
        changeId: requestIdChange?.id ?? 'chg-order-requestId',
        scope: '取消订单接口 requestId 校验',
        reason: '三个遗留调用方需要分阶段升级，兼容层临时允许缺失。',
        approvedBy: '付航',
        expiresAt: '2026-10-31',
      },
    ],
    versions: [
      {
        id: orderBaseline.id,
        contractId: 'contract-order',
        version: orderBaseline.version,
        releasedAt: '2026-08-18T09:30:00.000Z',
        checksum: orderBaseline.checksum,
        notes: '新增批量查询能力。',
        changeIds: [],
        openapi: orderOpenApiV270,
      },
    ],
    confirmations: [],
  },
  {
    id: 'contract-payment',
    name: '支付清算 API',
    version: '4.2.0',
    domain: '支付结算',
    owner: '支付平台组',
    protocol: 'REST',
    status: 'ready',
    updatedAt: '2026-09-28T10:40:00.000Z',
    openapi: paymentOpenApiV420,
    changes: paymentChanges,
    consumers: [
      {
        id: 'consumer-finance',
        name: '财务对账',
        owner: '财务研发组',
        environment: '生产',
        clientVersion: '5.2.0',
        requestsPerDay: 1100000,
        contact: 'finance-api@example.com',
      },
      {
        id: 'consumer-pay-ops',
        name: '支付运营台',
        owner: '支付产品组',
        environment: '生产',
        clientVersion: '4.1.8',
        requestsPerDay: 320000,
        contact: 'pay-ops@example.com',
      },
      {
        id: 'consumer-cs-pay',
        name: '客服工作台',
        owner: '服务体验组',
        environment: '生产',
        clientVersion: '3.9.0',
        requestsPerDay: 150000,
        contact: 'cs-platform@example.com',
      },
    ],
    exemptions: [],
    versions: [
      {
        id: paymentBaseline.id,
        contractId: 'contract-payment',
        version: paymentBaseline.version,
        releasedAt: '2026-07-30T04:00:00.000Z',
        checksum: paymentBaseline.checksum,
        notes: '统一退款错误码。',
        changeIds: [],
        openapi: paymentOpenApiV410,
      },
    ],
    confirmations: [],
  },
  {
    id: 'contract-user',
    name: '用户权限 API',
    version: '1.14.0',
    domain: '身份权限',
    owner: '身份平台组',
    protocol: 'REST',
    status: 'review',
    updatedAt: '2026-09-27T06:15:00.000Z',
    openapi: userOpenApi,
    changes: [userManualChange],
    consumers: [
      {
        id: 'consumer-admin',
        name: '权限管理台',
        owner: '安全产品组',
        environment: '生产',
        clientVersion: '1.12.3',
        requestsPerDay: 180000,
        contact: 'iam-console@example.com',
      },
    ],
    exemptions: [],
    versions: [],
    confirmations: [],
  },
];
