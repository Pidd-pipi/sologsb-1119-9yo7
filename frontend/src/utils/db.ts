import Dexie, { type Table } from 'dexie';
import type { Specimen } from '../types/specimen';
import type { PrepProcedure } from '../types/procedure';
import type { SupplyLot } from '../types/supply';
import type { PrepPhoto } from '../types/photo';
import { makeSketchDataUrl } from '../types/photo';
import { newId } from './id';

/** 当前数据结构版本，写入 localStorage 便于回显 */
export const DB_VERSION = 3;
export const DB_NAME = 'gbfossilprep';
export const LS_VERSION_KEY = 'gbfossilprep:db-version';

class FossilPrepDB extends Dexie {
  specimens!: Table<Specimen, string>;
  procedures!: Table<PrepProcedure, string>;
  supplies!: Table<SupplyLot, string>;
  photos!: Table<PrepPhoto, string>;

  constructor() {
    super(DB_NAME);
    // v1：初版四张业务表
    this.version(1).stores({
      specimens: 'id, specimenNo, taxon, locality, status, createdAt',
      procedures: 'id, specimenId, seq, stepType, state',
      supplies: 'id, kind, lotNo, name',
      photos: 'id, specimenId, procedureId, stage',
    });
    // v2：工序增加 state 索引与 finishedAt；影像增加 stage 索引
    this.version(2)
      .stores({
        specimens: 'id, specimenNo, taxon, locality, status, createdAt',
        procedures: 'id, specimenId, seq, stepType, state, startedAt',
        supplies: 'id, kind, lotNo, name, openedAt',
        photos: 'id, specimenId, procedureId, stage, capturedAt',
      })
      .upgrade(async (tx) => {
        // 老版本记录缺字段，迁移时逐表补齐（用宽松类型，避免升级事务里做多余断言）
        await tx
          .table('procedures')
          .toCollection()
          .modify((row: any) => {
            if (!row.state) row.state = 'pending';
            if (row.tools === undefined) row.tools = [];
            if (row.photoBeforeIds === undefined) row.photoBeforeIds = [];
            if (row.photoAfterIds === undefined) row.photoAfterIds = [];
            if (row.adhesiveConc === undefined) row.adhesiveConc = 0;
          });
        await tx
          .table('supplies')
          .toCollection()
          .modify((row: any) => {
            if (!row.issues) row.issues = [];
            if (row.lowThreshold === undefined) row.lowThreshold = 1;
          });
      });
    // v3：工序与材料领用打通，工序增加 materialUsages 快照（老工序为空数组，回退不动库存）
    this.version(3)
      .stores({
        specimens: 'id, specimenNo, taxon, locality, status, createdAt',
        procedures: 'id, specimenId, seq, stepType, state, startedAt',
        supplies: 'id, kind, lotNo, name, openedAt',
        photos: 'id, specimenId, procedureId, stage, capturedAt',
      })
      .upgrade(async (tx) => {
        await tx
          .table('procedures')
          .toCollection()
          .modify((row: any) => {
            if (!Array.isArray(row.materialUsages)) row.materialUsages = [];
          });
      });
  }
}

export const db = new FossilPrepDB();

/** 记录结构版本，迁移完成后回写 */
export async function markDbVersion(): Promise<void> {
  try {
    window.localStorage.setItem(LS_VERSION_KEY, String(DB_VERSION));
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

export function readDbVersion(): number {
  try {
    const raw = window.localStorage.getItem(LS_VERSION_KEY);
    return raw ? Number(raw) : DB_VERSION;
  } catch {
    return DB_VERSION;
  }
}

/** 首次进入时灌入一条示范档案，保证页面非空壳 */
export async function ensureSeedData(): Promise<void> {
  const count = await db.specimens.count();
  if (count > 0) return;

  const now = Date.now();
  const day = 24 * 3600 * 1000;
  const specimenId = newId('spm');
  const specimenId2 = newId('spm');

  const specimens: Specimen[] = [
    {
      id: specimenId,
      specimenNo: 'FP-2024-0031',
      taxon: 'Sinokannemeyeria yingchiaoensis（山西肯氏兽）',
      horizon: '中三叠统二马营组',
      locality: '山西武乡',
      lithology: '紫红色粉砂质泥岩',
      matrixHardness: 2.5,
      dimensions: '320×210×150',
      weight: 4820,
      storageBox: 'A 区 3 匣 2 格',
      status: '修复中',
      createdAt: now - 12 * day,
    },
    {
      id: specimenId2,
      specimenNo: 'FP-2024-0058',
      taxon: 'Psittacosaurus sp.（鹦鹉嘴龙）',
      horizon: '下白垩统义县组',
      locality: '辽宁北票',
      lithology: '灰绿色凝灰质砂岩',
      matrixHardness: 4.2,
      dimensions: '180×120×90',
      weight: 1640,
      storageBox: 'B 区 1 匣 4 格',
      status: '待清修',
      createdAt: now - 5 * day,
    },
  ];

  const prc1Id = newId('prc');
  const prc2Id = newId('prc');
  const supB72Id = newId('sup');
  const supSicId = newId('sup');
  const supPenId = newId('sup');
  const supPickId = newId('sup');
  const supBrushId = newId('sup');
  const supE44Id = newId('sup');
  const supNeedleId = newId('sup');
  const supUsId = newId('sup');

  // 节点 1（已完成）：气动笔 + 剔针 + 800 目磨料，三笔用量均已扣库存
  const use1PenId = newId('mu');
  const use1PickId = newId('mu');
  const use1SicId = newId('mu');
  const iss1PenId = newId('iss');
  const iss1PickId = newId('iss');
  const iss1SicId = newId('iss');
  // 节点 2（待办）：渗透滴管 + B-72，扣减已发生、尚未完成
  const use2DropperId = newId('mu');
  const use2B72Id = newId('mu');
  const iss2DropperId = newId('iss');
  const iss2B72Id = newId('iss');

  const procedures: PrepProcedure[] = [
    {
      id: prc1Id,
      specimenId,
      stepType: '清修',
      nodeName: '左侧肩胛区粗清',
      seq: 1,
      tools: ['气动笔', '剔针'],
      abrasive: '800 目',
      adhesive: '',
      adhesiveConc: 0,
      durationMin: 145,
      tempC: 22,
      rh: 48,
      photoBeforeIds: [],
      photoAfterIds: [],
      operator: '林砚秋',
      startedAt: now - 10 * day,
      state: 'done',
      finishedAt: now - 10 * day + 145 * 60000,
      materialUsages: [
        {
          id: use1PenId,
          kind: '工具',
          itemName: '气动笔',
          lotId: supPenId,
          lotNo: 'PEN-2308',
          qty: 1,
          unit: '支',
          issueId: iss1PenId,
        },
        {
          id: use1PickId,
          kind: '工具',
          itemName: '剔针',
          lotId: supPickId,
          lotNo: 'PICK-2310',
          qty: 2,
          unit: '支',
          issueId: iss1PickId,
        },
        {
          id: use1SicId,
          kind: '磨料',
          itemName: '800 目',
          lotId: supSicId,
          lotNo: 'SIC-800-2401',
          qty: 1,
          unit: '袋',
          issueId: iss1SicId,
        },
      ],
    },
    {
      id: prc2Id,
      specimenId,
      stepType: '加固',
      nodeName: '围岩裂隙渗透加固',
      seq: 2,
      tools: ['渗透滴管'],
      abrasive: '',
      adhesive: 'Paraloid B-72',
      adhesiveConc: 5,
      durationMin: 90,
      tempC: 23,
      rh: 45,
      photoBeforeIds: [],
      photoAfterIds: [],
      operator: '林砚秋',
      startedAt: now - 6 * day,
      state: 'pending',
      materialUsages: [
        {
          id: use2DropperId,
          kind: '工具',
          itemName: '渗透滴管',
          lotId: supBrushId,
          lotNo: 'DROP-1ML-2403',
          qty: 2,
          unit: '支',
          issueId: iss2DropperId,
        },
        {
          id: use2B72Id,
          kind: '胶种',
          itemName: 'Paraloid B-72',
          lotId: supB72Id,
          lotNo: 'B72-20240312',
          qty: 1,
          unit: '瓶',
          issueId: iss2B72Id,
        },
      ],
    },
  ];

  const photos: PrepPhoto[] = [
    {
      id: newId('pho'),
      specimenId,
      procedureId: procedures[0].id,
      stage: 'before',
      caption: '清修前 · 左侧肩胛区围岩包裹',
      dataUrl: makeSketchDataUrl('清修前 · FP-2024-0031', '#6b5844'),
      capturedAt: now - 10 * day,
    },
    {
      id: newId('pho'),
      specimenId,
      procedureId: procedures[0].id,
      stage: 'after',
      caption: '清修后 · 肩胛骨轮廓显露',
      dataUrl: makeSketchDataUrl('清修后 · FP-2024-0031', '#3f5a4a'),
      capturedAt: now - 9 * day,
    },
  ];
  procedures[0].photoBeforeIds = [photos[0].id];
  procedures[0].photoAfterIds = [photos[1].id];

  const supplies: SupplyLot[] = [
    {
      id: supB72Id,
      name: 'Paraloid B-72',
      kind: '胶种',
      spec: '分析纯 500 g',
      lotNo: 'B72-20240312',
      qty: 3,
      unit: '瓶',
      openedAt: now - 40 * day,
      shelfLifeMonths: 36,
      lowThreshold: 2,
      issues: [
        {
          id: iss2B72Id,
          qty: 1,
          operator: '林砚秋',
          specimenNo: 'FP-2024-0031',
          issuedAt: now - 6 * day,
          procedureId: prc2Id,
          procedureNode: '#2 加固 · 围岩裂隙渗透加固',
          usageId: use2B72Id,
          itemName: 'Paraloid B-72',
        },
        {
          id: newId('iss'),
          qty: 1,
          operator: '林砚秋',
          specimenNo: 'FP-2024-0031',
          issuedAt: now - 9 * day,
          itemName: 'Paraloid B-72',
        },
      ],
    },
    {
      id: supE44Id,
      name: '环氧树脂 E44',
      kind: '胶种',
      spec: '固化剂套装 1 kg',
      lotNo: 'E44-20220108',
      qty: 0,
      unit: '套',
      openedAt: now - 200 * day,
      shelfLifeMonths: 6,
      lowThreshold: 1,
      issues: [
        {
          id: newId('iss'),
          qty: 1,
          operator: '周慕白',
          specimenNo: 'FP-2024-0058',
          issuedAt: now - 150 * day,
          itemName: '环氧树脂 E44',
        },
      ],
    },
    {
      id: supSicId,
      name: '碳化硅磨料',
      kind: '磨料',
      spec: '800 目 1 kg',
      lotNo: 'SIC-800-2401',
      qty: 1,
      unit: '袋',
      openedAt: now - 60 * day,
      shelfLifeMonths: 60,
      lowThreshold: 2,
      issues: [
        {
          id: iss1SicId,
          qty: 1,
          operator: '林砚秋',
          specimenNo: 'FP-2024-0031',
          issuedAt: now - 10 * day,
          procedureId: prc1Id,
          procedureNode: '#1 清修 · 左侧肩胛区粗清',
          usageId: use1SicId,
          itemName: '800 目',
        },
      ],
    },
    {
      id: supPenId,
      name: '气动笔',
      kind: '工具',
      spec: '往复式 2.3 mm 夹头',
      lotNo: 'PEN-2308',
      qty: 1,
      unit: '支',
      openedAt: now - 120 * day,
      shelfLifeMonths: 120,
      lowThreshold: 2,
      issues: [
        {
          id: iss1PenId,
          qty: 1,
          operator: '林砚秋',
          specimenNo: 'FP-2024-0031',
          issuedAt: now - 10 * day,
          procedureId: prc1Id,
          procedureNode: '#1 清修 · 左侧肩胛区粗清',
          usageId: use1PenId,
          itemName: '气动笔',
        },
      ],
    },
    {
      id: supPickId,
      name: '剔针',
      kind: '工具',
      spec: '钨钢尖针 0.8 mm',
      lotNo: 'PICK-2310',
      qty: 3,
      unit: '支',
      openedAt: now - 90 * day,
      shelfLifeMonths: 120,
      lowThreshold: 5,
      issues: [
        {
          id: iss1PickId,
          qty: 2,
          operator: '林砚秋',
          specimenNo: 'FP-2024-0031',
          issuedAt: now - 10 * day,
          procedureId: prc1Id,
          procedureNode: '#1 清修 · 左侧肩胛区粗清',
          usageId: use1PickId,
          itemName: '剔针',
        },
      ],
    },
    {
      id: supBrushId,
      name: '渗透滴管',
      kind: '工具',
      spec: '一次性 1 mL',
      lotNo: 'DROP-1ML-2403',
      qty: 8,
      unit: '支',
      openedAt: now - 30 * day,
      shelfLifeMonths: 36,
      lowThreshold: 10,
      issues: [
        {
          id: iss2DropperId,
          qty: 2,
          operator: '林砚秋',
          specimenNo: 'FP-2024-0031',
          issuedAt: now - 6 * day,
          procedureId: prc2Id,
          procedureNode: '#2 加固 · 围岩裂隙渗透加固',
          usageId: use2DropperId,
          itemName: '渗透滴管',
        },
      ],
    },
    {
      id: supNeedleId,
      name: '气动笔针头',
      kind: '耗材',
      spec: '钨钢 2.3 mm',
      lotNo: 'NEEDLE-2312',
      qty: 18,
      unit: '支',
      openedAt: now - 90 * day,
      shelfLifeMonths: 120,
      lowThreshold: 5,
      issues: [],
    },
    {
      id: supUsId,
      name: '超声波清洗机',
      kind: '工具',
      spec: '6 L / 40 kHz',
      lotNo: 'US-6L-01',
      qty: 1,
      unit: '台',
      openedAt: now - 200 * day,
      shelfLifeMonths: 120,
      lowThreshold: 1,
      issues: [],
    },
  ];

  await db.transaction('rw', db.specimens, db.procedures, db.supplies, db.photos, async () => {
    await db.specimens.bulkPut(specimens);
    await db.procedures.bulkPut(procedures);
    await db.supplies.bulkPut(supplies);
    await db.photos.bulkPut(photos);
  });
}
