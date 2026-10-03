# API 契约兼容性审查与版本发布平台

用于后端维护者、接口评审人和调用方负责人协作处理 API 契约变化的独立前端工程。工程没有真实后端，首次运行加载本地模拟契约，后续状态写入浏览器 `localStorage`。

## 技术栈

- React 19 + TypeScript + Vite 8
- shadcn/ui 风格本地组件 + Radix UI primitives
- Zustand + persist
- TanStack Router
- TanStack Query
- Monaco Editor / Diff Editor
- Tailwind CSS 4

## 功能

- OpenAPI JSON 导入、契约列表搜索和领域/状态筛选
- 以**冻结版本为比较基线**自动重算字段增删、类型、枚举扩展/收窄与必填变化
- 保存定义后差异清单即时与定义对齐；定义再改动使旧评审与调用方确认失效（归档保留可查），差异回到待重新确认并阻断发布门禁
- 调用方逐条确认；共享调用方在任一关联契约重算后确认跨契约联动失效，关联契约的发布门禁同步阻断
- 发布中心多契约勾选、批量冻结；写入失败或并发冲突保留待恢复批次，恢复只补未完成契约，同版本号幂等不重复生成
- 两窗口并发保存基于 revision 乐观锁拦截后写者，并通过 storage 事件跨窗口同步
- 旧数据缺少基线时按首个冻结快照回填，版本历史与 Markdown 报告标注所采用基线及回填来源
- 自动判定兼容、警告或不兼容，并要求调用方影响说明与迁移方案
- Monaco Editor 编辑契约定义，Monaco Diff Editor 比较冻结基线快照
- 调用方列表、示例请求生成、逐条接受、退回和兼容层豁免
- 跨契约批量评审、发布门禁、正式版本冻结与版本历史
- Markdown 变更报告与 JSON 导出

## 运行

```bash
npm install
npm run dev
```

默认开发地址为 `http://localhost:18470`。

生产构建：

```bash
npm run build
```

构建输出位于 `dist`。

## 目录

```text
src/
  components/             shadcn/Radix 基础组件、业务组件、应用外壳
  data/                   本地模拟契约
  lib/                    通用工具
  models/                 契约模型、兼容性与发布门禁规则
  pages/                  工作台、详情、批量评审、发布、报告
  services/               本地持久化服务和 TanStack Query hooks
  store/                  Zustand 评审工作区状态
```
