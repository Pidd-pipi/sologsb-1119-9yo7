import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import type { PrepProcedure } from '../types/procedure';
import type { MaterialUsage } from '../types/procedure';
import type { PrepPhoto } from '../types/photo';
import type { SupplyIssue } from '../types/supply';
import { prepareUsages, type UsageLineInput } from '../utils/materialUsage';
// 跨 store 联动：保存 / 回退会修改库存表，之后刷新材料台账缓存
import { useSupplyStore } from './supplyStore';

/** 新建工序入参：字段同 PrepProcedure，但 usages 是尚未补全批号 / 单位的表单行 */
export interface CreateProcedureInput
  extends Omit<PrepProcedure, 'id' | 'usages' | 'startedAt' | 'state' | 'finishedAt'> {
  startedAt?: number;
  usages: UsageLineInput[];
  photos?: PrepPhoto[];
}

interface ProcedureState {
  items: PrepProcedure[];
  loaded: boolean;
  load: () => Promise<void>;
  /**
   * 保存工序节点：在单个事务内校验全部领用行并按批次扣减库存，
   * 任一条件（缺批次 / 用量非正 / 库存不足 / 已过期 / 同单重复批次）不满足则整体抛错，
   * 工序与库存都不会落单。
   */
  create: (input: CreateProcedureInput) => Promise<PrepProcedure>;
  /** 完成节点；若节点是「已回退」重新完成，则再次校验并扣减库存 */
  finish: (id: string) => Promise<void>;
  /** 回退已完成节点：用量退回对应批次，领用记录标记退库 */
  rollback: (id: string, reason?: string) => Promise<void>;
  /** 删除节点：若仍占用库存则一并退回 */
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

  async create(input) {
    const { usages: lines, photos = [], startedAt = Date.now(), ...rest } = input;
    const recordId = newId('prc');
    const now = startedAt;

    let record: PrepProcedure | undefined;
    await db.transaction(
      'rw',
      db.procedures,
      db.supplies,
      db.photos,
      db.specimens,
      async () => {
        const specimen = await db.specimens.get(input.specimenId);
        if (!specimen) throw new Error('所选标本不存在，请重新选择');
        const lots = await db.supplies.toArray();
        const lotsById = new Map(lots.map((lot) => [lot.id, lot]));

        // 事务内校验并补全批号 / 单位；失败即抛错，整单回滚
        const prepared = prepareUsages(lines, lotsById);

        const notePrefix = `${input.stepType} #${input.seq}`;
        const usages: MaterialUsage[] = prepared.map((u) => ({
          ...u,
          key: `${u.role}:${u.materialName}`,
          issueId: newId('iss'),
        }));

        // 按批次归集本次扣减，逐批次写回库存并追加领用记录
        const issueByLotId = new Map(usages.map((u) => [u.lotId, u]));
        for (const lot of lots) {
          const usage = issueByLotId.get(lot.id);
          if (!usage) continue;
          const issue: SupplyIssue = {
            id: usage.issueId!,
            qty: usage.qty,
            operator: input.operator,
            specimenNo: specimen.specimenNo,
            issuedAt: now,
            purpose: 'procedure',
            specimenId: specimen.id,
            procedureId: recordId,
            usageNote: `${notePrefix} ${input.nodeName}`,
            materialName: usage.materialName,
            reversed: false,
          };
          await db.supplies.put({
            ...lot,
            qty: lot.qty - usage.qty,
            issues: [issue, ...lot.issues],
          });
        }

        record = { ...rest, id: recordId, startedAt: now, state: 'pending', usages };
        await db.procedures.put(record);

        if (photos.length > 0) {
          await db.photos.bulkPut(photos.map((p) => ({ ...p, procedureId: recordId })));
        }
      },
    );

    const saved = record!;
    set({ items: [...get().items, saved] });
    // 跨表事务已改库存，刷新材料台账缓存
    await useSupplyStore.getState().refresh();
    return saved;
  },

  async finish(id) {
    const target = get().items.find((it) => it.id === id);
    if (!target) return;

    if (target.state === 'rolledback') {
      // 回退后重新完成：库存再次校验扣减，领用记录重新生效（换新的领用工单）
      const specimen = await db.specimens.get(target.specimenId);
      await db.transaction('rw', db.procedures, db.supplies, async () => {
        const lots = await db.supplies.toArray();
        const lotsById = new Map(lots.map((lot) => [lot.id, lot]));
        const lines: UsageLineInput[] = target.usages.map((u) => ({
          role: u.role,
          materialName: u.materialName,
          lotId: u.lotId,
          qty: u.qty,
        }));
        const prepared = prepareUsages(lines, lotsById);

        const finishedAt = Date.now();
        const newUsages: MaterialUsage[] = prepared.map((u) => ({
          ...u,
          key: `${u.role}:${u.materialName}`,
          issueId: newId('iss'),
        }));
        const byLotId = new Map(newUsages.map((u) => [u.lotId, u]));
        for (const lot of lots) {
          const usage = byLotId.get(lot.id);
          if (!usage) continue;
          const issue: SupplyIssue = {
            id: usage.issueId!,
            qty: usage.qty,
            operator: target.operator,
            specimenNo: specimen?.specimenNo ?? '未关联标本',
            issuedAt: finishedAt,
            purpose: 'procedure',
            specimenId: target.specimenId,
            procedureId: target.id,
            usageNote: `${target.stepType} #${target.seq} ${target.nodeName}（回退后重新完成）`,
            materialName: usage.materialName,
            reversed: false,
          };
          await db.supplies.put({
            ...lot,
            qty: lot.qty - usage.qty,
            issues: [issue, ...lot.issues],
          });
        }
        await db.procedures.update(id, { state: 'done', finishedAt, usages: newUsages });
      });
    } else {
      const patch: Partial<PrepProcedure> = { state: 'done', finishedAt: Date.now() };
      await db.procedures.update(id, patch);
    }

    // 事务可能更新了 usages（回退后重新完成会换新领用记录），从库重读保证状态一致
    const refreshed = await db.procedures.toArray();
    refreshed.sort((a, b) => a.seq - b.seq || a.startedAt - b.startedAt);
    set({ items: refreshed });
    await useSupplyStore.getState().refresh();
  },

  async rollback(id) {
    const target = get().items.find((it) => it.id === id);
    if (!target) return;
    if (target.state !== 'done') {
      throw new Error('只有已完成的节点才能回退');
    }

    const reversedAt = Date.now();
    await db.transaction('rw', db.procedures, db.supplies, async () => {
      const issueIds = new Set(target.usages.map((u) => u.issueId).filter(Boolean) as string[]);
      if (issueIds.size > 0) {
        const lots = await db.supplies.toArray();
        for (const lot of lots) {
          const hit = lot.issues.filter((iss) => issueIds.has(iss.id) && !iss.reversed);
          if (hit.length === 0) continue;
          const returnQty = hit.reduce((sum, iss) => sum + iss.qty, 0);
          const reversedIds = new Set(hit.map((iss) => iss.id));
          await db.supplies.put({
            ...lot,
            qty: lot.qty + returnQty,
            issues: lot.issues.map((iss) =>
              reversedIds.has(iss.id) ? { ...iss, reversed: true, reversedAt } : iss,
            ),
          });
        }
      }
      await db.procedures.update(id, { state: 'rolledback', finishedAt: undefined });
    });

    set({
      items: get().items.map((it) =>
        it.id === id ? { ...it, state: 'rolledback', finishedAt: undefined } : it,
      ),
    });
    await useSupplyStore.getState().refresh();
  },

  async remove(id) {
    const target = get().items.find((it) => it.id === id);
    await db.transaction('rw', db.procedures, db.supplies, db.photos, async () => {
      if (target && target.state !== 'rolledback') {
        // 删除非已回退节点：仍占用的库存退回，对应领用记录标记退库
        const issueIds = new Set(target.usages.map((u) => u.issueId).filter(Boolean) as string[]);
        if (issueIds.size > 0) {
          const lots = await db.supplies.toArray();
          for (const lot of lots) {
            const hit = lot.issues.filter((iss) => issueIds.has(iss.id) && !iss.reversed);
            if (hit.length === 0) continue;
            const returnQty = hit.reduce((sum, iss) => sum + iss.qty, 0);
            const hitIds = new Set(hit.map((iss) => iss.id));
            await db.supplies.put({
              ...lot,
              qty: lot.qty + returnQty,
              issues: lot.issues.map((iss) =>
                hitIds.has(iss.id) ? { ...iss, reversed: true, reversedAt: Date.now() } : iss,
              ),
            });
          }
        }
      }
      await db.photos.where('procedureId').equals(id).delete();
      await db.procedures.delete(id);
    });
    set({ items: get().items.filter((it) => it.id !== id) });
    await useSupplyStore.getState().refresh();
  },

  bySpecimen(specimenId) {
    return get()
      .items.filter((it) => it.specimenId === specimenId)
      .sort((a, b) => a.seq - b.seq);
  },
}));
