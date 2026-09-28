/** 工具材料种类 */
export type SupplyKind = '工具' | '磨料' | '胶种' | '耗材';

export const SUPPLY_KINDS: SupplyKind[] = ['工具', '磨料', '胶种', '耗材'];

/** 工具材料批次 */
export interface SupplyLot {
  id: string;
  name: string;
  kind: SupplyKind;
  /** 规格 */
  spec: string;
  /** 批号 */
  lotNo: string;
  /** 在库数量 */
  qty: number;
  unit: string;
  /** 开封时间 */
  openedAt: number;
  /** 保质期（月） */
  shelfLifeMonths: number;
  /** 低量阈值 */
  lowThreshold: number;
  /** 领用 / 退库记录（最近在前） */
  issues: SupplyIssue[];
}

/** 领用用途 */
export type IssuePurpose = 'procedure' | 'manual';

/** 领用登记（工序保存自动生成，或台账手动领用） */
export interface SupplyIssue {
  id: string;
  qty: number;
  operator: string;
  specimenNo: string;
  issuedAt: number;
  /** 领用方式：随工序录入 / 台账手动 */
  purpose: IssuePurpose;
  /** 关联标本 id（手动领用可空） */
  specimenId?: string;
  /** 关联工序节点 id（手动领用可空） */
  procedureId?: string;
  /** 用途说明，如「清修 #1 左侧肩胛区粗清」 */
  usageNote?: string;
  /** 所用材料名称（工具/磨料/胶种的候选项名） */
  materialName?: string;
  /** 是否已随节点回退而退库（退库后 qty 已加回批次） */
  reversed?: boolean;
  /** 退库时间 */
  reversedAt?: number;
}

export type SupplyLotDraft = Omit<SupplyLot, 'id' | 'issues'>;

/** 手动领用入参（id 与时间、方式由 store 补全） */
export type ManualIssueInput = Omit<
  SupplyIssue,
  'id' | 'issuedAt' | 'purpose' | 'specimenId' | 'procedureId' | 'usageNote' | 'materialName' | 'reversed' | 'reversedAt'
> & {
  specimenId?: string;
};

/** 是否低量 */
export function isLowStock(lot: SupplyLot): boolean {
  return lot.qty <= lot.lowThreshold;
}

/** 剩余保质期天数（负数表示已过期） */
export function shelfLifeLeftDays(lot: SupplyLot, now = Date.now()): number {
  const expireAt = lot.openedAt + lot.shelfLifeMonths * 30 * 24 * 3600 * 1000;
  return Math.floor((expireAt - now) / (24 * 3600 * 1000));
}

/** 批次是否已过期（剩余保质期为负） */
export function isLotExpired(lot: SupplyLot, now = Date.now()): boolean {
  return shelfLifeLeftDays(lot, now) < 0;
}
