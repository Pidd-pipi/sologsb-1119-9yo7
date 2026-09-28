# sologsb-1119 化石修复工序档案（gbfossilprep）

面向博物馆化石修复技师的工序留痕工作台：标本从入库、清修、加固到交付逐节点留痕，登记工具与胶种用量，并做修复前后对照。纯前端单页应用，数据全部保存在浏览器本地。

## Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

访问地址：**http://localhost:21819**

停止服务：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| UI | MUI（Material UI）v5 |
| 构建 | Vite 5 |
| 状态管理 | Zustand |
| 路由 | React Router v6（BrowserRouter） |
| 本地存储 | IndexedDB（Dexie 4），影像单独建表，含结构版本号与升级迁移 |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc 类型检查 + vite 构建
```

> 生产环境由 nginx 托管 `dist`，`nginx.conf` 已启用 `try_files $uri $uri/ /index.html;` 与 gzip。

## 目录结构

```
sologsb-1119/
├── docker-compose.yml
├── .env.example
├── .env
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── main.tsx
        ├── router/index.tsx
        ├── types/{specimen,procedure,supply,photo}.ts
        ├── stores/{specimen,procedure,supply}Store.ts
        ├── components/common/{ProcedureTimeline,BeforeAfterSlider,SpecimenCard,MeasureField}.tsx
        ├── hooks/{useSpecimenSearch,usePrepProgress}.ts
        ├── pages/{SpecimenList,SpecimenDetail,ProcedureForm,SupplyList,CompareView}.tsx
        └── utils/{db,unitConvert,id}.ts
```

## 页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/specimens` | 标本台账：按号/分类/产地/状态筛选，状态分栏 | Specimen |
| `/specimens/:id` | 标本详情 + 工序时间线 + 影像留痕 | Specimen、PrepProcedure、PrepPhoto |
| `/procedures/new` | 新建工序节点：按类型动态出工具/磨料/胶种字段，逐项选批次填用量，序号跳号报错；保存即事务扣库存 | PrepProcedure、Specimen、SupplyLot |
| `/supplies` | 工具材料台账：按种类分组、批号追溯、低量高亮、领用登记、行内展开用途/退库明细 | SupplyLot |
| `/compare/:specimenId` | 前后对照滑块联看 + 导出对照说明文本 | PrepPhoto、PrepProcedure |

`/` 重定向到 `/specimens`，未匹配路由同样兜底到 `/specimens`。

## 数据存储说明

- 数据库名 `gbfossilprep`，当前结构版本 **v3**（`localStorage['gbfossilprep:db-version']` 记录）。
- 四张表：`specimens`（标本）、`procedures`（修复工序）、`supplies`（工具材料批次 + 领用记录）、`photos`（修复影像 dataUrl 独立表）。
- v1 → v2 迁移：为老数据补齐 `state`、`tools`、`photoBeforeIds/AfterIds`、`issues`、`lowThreshold` 字段并新增索引。
- v2 → v3 迁移：工序增加 `materialUsages`（按批次的材料用量快照），`issues` 增加 `procedureId/procedureNode/usageId/itemName/returned/returnedAt` 关联与退库字段；老工序的用量为空数组，回退不影响库存，旧节点仍可正常打开与回退。
- 容器无状态、不挂载命名卷；换浏览器或清空站点数据即回到初始示范数据。
- 首次打开会灌入 2 件示范标本、2 个工序节点、8 个材料批次（含 1 个已过期、1 个零库存批次）与 2 张留痕影像，工序节点的用量与批次领用记录互相串联，便于直接查看。

## 功能要点

- **工序序号不跳号**：新建节点时若序号大于「当前最大序号 + 1」直接报错并给出建议序号。
- **工序 × 材料领用联动**：每项工具、磨料、胶种都须选择材料批次并填写用量；保存节点时在同一个 IndexedDB 事务内逐批校验并扣减库存，同时在批次上写入关联到「标本 + 工序节点」的领用记录、在工序上留用量快照。库存不足、批次已过期、同一批次重复选择、用量非法时整单不落库（表单先校验，事务内按库内实时数据兜底）。
- **回退即退库**：已完成（或待办）节点回退后，其未退回的用量逐批加回对应批次，领用记录标记「已退回」及退库时间，操作幂等；批次被删除时跳过该批、不阻断回退。
- **用途明细追溯**：材料台账每行可展开该批次全部领用/退库明细（时间、领用人、工序节点、标本号、数量、状态），工序时间线展开后同样可看每项用量的批号与退回状态。
- **工序回退**：已完成节点可回退，回退后计入待办与回退计数。
- **低量高亮**：在库 ≤ 低量阈值的批次整行高亮并标注「低量」，剩余保质期为负时红色标注。
- **批号追溯**：按批号片段检索，行内直接展开该批次的领用/退库明细。
- **前后对照**：滑块拖动联看修复前后影像，支持缩放与标注泡点，可导出/复制对照说明文本。
