import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { useSupplyStore } from './supplyStore';
import type { MaterialUsage, PrepProcedure, PrepProcedureDraft } from '../types/procedure';
import type { SupplyIssue, SupplyLot } from '../types/supply';
import { shelfLifeLeftDays } from '../types/supply';

/** 工序保存前的材料领用校验失败（库存不足 / 批次过期 / 重复使用），整条工序不落单 */
export class MaterialCheckError extends Error {}

/** 生成一条工序关联的领用记录 */
function buildIssue(
  usage: MaterialUsage,
  lot: SupplyLot,
  specimenNo: string,
  nodeLabel: string,
  procedureId: string,
  issuedAt: number,
  operator: string,
): SupplyIssue {
  return {
    id: newId('iss'),
    qty: usage.qty,
    operator,
    specimenNo,
    issuedAt,
    procedureId,
    procedureNode: nodeLabel,
    usageId: usage.id,
    itemName: usage.itemName,
  };
}

interface ProcedureState {
  items: PrepProcedure[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (draft: PrepProcedureDraft) => Promise<PrepProcedure>;
  finish: (id: string) => Promise<void>;
  rollback: (id: string, reason?: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  bySpecimen: (specimenId: string) => PrepProcedure[];
}

export const useProcedureStore = create<ProcedureState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    const items = await db.procedures.toArray();
    items.sort((a, b) => a.seq - b.seq || a.startedAt - b.startedAt);
    set({ items, loaded: true });
  },
  async add(draft) {
    // 表单层先筛过一遍，这里再在事务内按库内实时数据兜底，杜绝并发下的超扣/过期/重复
    const specimen = await db.specimens.get(draft.specimenId);
    const specimenNo = specimen?.specimenNo ?? '未关联标本';
    const nodeLabel = `#${draft.seq} ${draft.stepType} · ${draft.nodeName}`;
    const issuedAt = draft.startedAt;
    const procedureId = newId('prc');

    const record: PrepProcedure = { ...draft, id: procedureId };
    record.materialUsages = (draft.materialUsages ?? []).map((u) => ({ ...u }));

    await db.transaction('rw', db.procedures, db.supplies, db.specimens, async () => {
      const lotRows = new Map<string, SupplyLot>();
      for (const usage of record.materialUsages) {
        if (!(usage.qty > 0)) {
          throw new MaterialCheckError(`「${usage.itemName}」用量需大于 0`);
        }
        if (lotRows.has(usage.lotId)) {
          throw new MaterialCheckError(`批次 ${usage.lotNo} 在本节点被重复使用，同一批次请勿重复选择`);
        }
        const lot = await db.supplies.get(usage.lotId);
        if (!lot) {
          throw new MaterialCheckError(`「${usage.itemName}」所选批次 ${usage.lotNo} 已不存在，请重新选择`);
        }
        if (shelfLifeLeftDays(lot, issuedAt) < 0) {
          throw new MaterialCheckError(`「${usage.itemName}」批次 ${lot.lotNo} 已过期，禁止领用`);
        }
        if (lot.qty < usage.qty) {
          throw new MaterialCheckError(
            `「${usage.itemName}」批次 ${lot.lotNo} 在库仅 ${lot.qty} ${lot.unit}，不足 ${usage.qty} ${lot.unit}`,
          );
        }
        lotRows.set(lot.id, lot);
      }
      for (const [, lot] of lotRows) {
        // 同一事务里多个用量命中同一批次已在上面拦截，这里按批次汇总扣减
        const usages = record.materialUsages.filter((u) => u.lotId === lot.id);
        const total = usages.reduce((sum, u) => sum + u.qty, 0);
        const issues: SupplyIssue[] = usages.map((u) =>
          buildIssue(u, lot, specimenNo, nodeLabel, procedureId, issuedAt, draft.operator),
        );
        // 用已生成的 issueId 回填用量快照
        usages.forEach((u, i) => {
          u.issueId = issues[i].id;
          u.unit = lot.unit;
          u.lotNo = lot.lotNo;
        });
        await db.supplies.put({ ...lot, qty: lot.qty - total, issues: [...issues, ...lot.issues] });
      }
      await db.procedures.put(record);
    });

    set({ items: [...get().items, record] });
    void useSupplyStore.getState().load();
    return record;
  },
  async finish(id) {
    const patch: Partial<PrepProcedure> = { state: 'done', finishedAt: Date.now() };
    await db.procedures.update(id, patch);
    set({ items: get().items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
  },
  async rollback(id) {
    // 回退即退库：该节点尚未退回的用量逐批加回，issues 标记为已退库，全部在同一事务内
    const now = Date.now();
    await db.transaction('rw', db.procedures, db.supplies, async () => {
      const procedure = await db.procedures.get(id);
      if (!procedure) throw new Error('工序节点不存在');
      const restore = new Map<string, number>();
      for (const usage of procedure.materialUsages ?? []) {
        if (usage.returned) continue;
        restore.set(usage.lotId, (restore.get(usage.lotId) ?? 0) + usage.qty);
      }
      for (const [lotId, qty] of restore) {
        const lot = await db.supplies.get(lotId);
        if (!lot) continue; // 批次台账已被删除时无法退库，保持记录可查，不阻断回退
        const issues = lot.issues.map((iss) =>
          iss.procedureId === id && !iss.returned
            ? { ...iss, returned: true, returnedAt: now }
            : iss,
        );
        await db.supplies.put({ ...lot, qty: lot.qty + qty, issues });
      }
      const materialUsages = (procedure.materialUsages ?? []).map((u) =>
        u.returned ? u : { ...u, returned: true },
      );
      const patch: Partial<PrepProcedure> = { state: 'rolledback', finishedAt: undefined, materialUsages };
      await db.procedures.update(id, patch);
    });
    const updated = await db.procedures.get(id);
    set({ items: get().items.map((it) => (it.id === id && updated ? updated : it)) });
    void useSupplyStore.getState().load();
  },
  async remove(id) {
    // 删除节点同样要先退库（防止已扣库存凭空消失），与删除放在同一事务
    await db.transaction('rw', db.procedures, db.supplies, async () => {
      const procedure = await db.procedures.get(id);
      if (procedure) {
        const restore = new Map<string, number>();
        for (const usage of procedure.materialUsages ?? []) {
          if (usage.returned) continue;
          restore.set(usage.lotId, (restore.get(usage.lotId) ?? 0) + usage.qty);
        }
        for (const [lotId, qty] of restore) {
          const lot = await db.supplies.get(lotId);
          if (!lot) continue;
          const now = Date.now();
          const issues = lot.issues.map((iss) =>
            iss.procedureId === id && !iss.returned
              ? { ...iss, returned: true, returnedAt: now }
              : iss,
          );
          await db.supplies.put({ ...lot, qty: lot.qty + qty, issues });
        }
      }
      await db.procedures.delete(id);
    });
    set({ items: get().items.filter((it) => it.id !== id) });
    void useSupplyStore.getState().load();
  },
  bySpecimen(specimenId) {
    return get()
      .items.filter((it) => it.specimenId === specimenId)
      .sort((a, b) => a.seq - b.seq);
  },
}));
