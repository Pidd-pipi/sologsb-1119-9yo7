import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { isLotExpired } from '../types/supply';
import type { ManualIssueInput, SupplyLot, SupplyLotDraft } from '../types/supply';

interface SupplyState {
  items: SupplyLot[];
  loaded: boolean;
  load: () => Promise<void>;
  /** 从库中重新读取（工序保存 / 回退等跨表事务后调用，保证台账与库存一致） */
  refresh: () => Promise<void>;
  add: (draft: SupplyLotDraft) => Promise<SupplyLot>;
  /** 台账手动领用：库存不足或批次过期时抛错，不落单 */
  issue: (id: string, payload: ManualIssueInput) => Promise<void>;
  trace: (lotNo: string) => SupplyLot[];
}

export const useSupplyStore = create<SupplyState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    const items = await db.supplies.toArray();
    items.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    set({ items, loaded: true });
  },
  async refresh() {
    const items = await db.supplies.toArray();
    items.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    set({ items });
  },
  async add(draft) {
    const record: SupplyLot = { ...draft, id: newId('sup'), issues: [] };
    await db.supplies.put(record);
    set({ items: [...get().items, record] });
    return record;
  },
  async issue(id, payload) {
    const target = await db.supplies.get(id);
    if (!target) throw new Error('批次不存在，可能已被删除');
    if (isLotExpired(target)) {
      throw new Error(`批次 ${target.lotNo} 已过期，不能领用`);
    }
    if (!(payload.qty > 0)) {
      throw new Error('领用数量需大于 0');
    }
    if (payload.qty > target.qty) {
      throw new Error(`库存不足：现存 ${target.qty} ${target.unit}，本次需 ${payload.qty} ${target.unit}`);
    }
    const next: SupplyLot = {
      ...target,
      qty: target.qty - payload.qty,
      issues: [
        {
          ...payload,
          id: newId('iss'),
          issuedAt: Date.now(),
          purpose: 'manual',
          reversed: false,
        },
        ...target.issues,
      ],
    };
    await db.supplies.put(next);
    set({ items: get().items.map((it) => (it.id === id ? next : it)) });
  },
  trace(lotNo) {
    if (!lotNo) return get().items;
    return get().items.filter((it) => it.lotNo.includes(lotNo) || it.name.includes(lotNo));
  },
}));
