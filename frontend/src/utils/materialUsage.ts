import type { MaterialUsage, MaterialRole } from '../types/procedure';
import { MATERIAL_ROLE_LABEL } from '../types/procedure';
import type { SupplyLot } from '../types/supply';
import { isLotExpired } from '../types/supply';

/** 表单中一条「材料 → 批次 + 用量」的待保存输入 */
export interface UsageLineInput {
  role: MaterialRole;
  materialName: string;
  lotId: string;
  qty: number;
}

/** 表单行的稳定 key（按用途 + 材料名） */
export function usageLineKey(role: MaterialRole, materialName: string): string {
  return `${role}:${materialName}`;
}

/** 行的中文定位文案，用于报错时指出是哪一项材料 */
export function lineLabel(line: Pick<UsageLineInput, 'role' | 'materialName'>): string {
  return `${MATERIAL_ROLE_LABEL[line.role]}「${line.materialName}」`;
}

/**
 * 在保存事务内校验全部领用行，并补全批号 / 单位等冗余字段。
 * 任一不满足都抛出带中文说明的 Error，由调用方整单回滚、不落单。
 *
 * 校验项：
 * 1. 必须选择批次、用量为正数；
 * 2. 批次仍存在且未过期；
 * 3. 库存足够（按本次拟扣后的余额，含同一批次多行合并计算）；
 * 4. 同一批次在一个节点内不得重复使用。
 */
export function prepareUsages(
  lines: UsageLineInput[],
  lotsById: Map<string, SupplyLot>,
): Array<Omit<MaterialUsage, 'key' | 'issueId'>> {
  // 按批次聚合，合并同一批次多行的用量
  const byLot = new Map<string, { lines: UsageLineInput[]; total: number }>();
  for (const line of lines) {
    if (!line.lotId) {
      throw new Error(`请为${lineLabel(line)}选择材料批次`);
    }
    if (!Number.isFinite(line.qty) || line.qty <= 0) {
      throw new Error(`请填写${lineLabel(line)}的领用用量（需大于 0）`);
    }
    const bucket = byLot.get(line.lotId) ?? { lines: [], total: 0 };
    bucket.lines.push(line);
    bucket.total += line.qty;
    byLot.set(line.lotId, bucket);
  }

  const prepared: Array<Omit<MaterialUsage, 'key' | 'issueId'>> = [];
  for (const [lotId, bucket] of byLot) {
    if (bucket.lines.length > 1) {
      throw new Error(
        `批次重复使用：${bucket.lines.map(lineLabel).join('、')} 选了同一批次，一个节点内同一批次只能领用一次`,
      );
    }
    const line = bucket.lines[0];
    const lot = lotsById.get(lotId);
    if (!lot) {
      throw new Error(`${lineLabel(line)}所选批次已不存在，请重新选择`);
    }
    if (isLotExpired(lot)) {
      throw new Error(`${lineLabel(line)}所选批次 ${lot.lotNo} 已过期，不能领用`);
    }
    if (bucket.total > lot.qty) {
      throw new Error(
        `${lineLabel(line)}库存不足：批次 ${lot.lotNo} 现存 ${lot.qty} ${lot.unit}，本次需 ${line.qty} ${lot.unit}`,
      );
    }
    prepared.push({
      role: line.role,
      materialName: line.materialName,
      lotId: lot.id,
      lotNo: lot.lotNo,
      qty: line.qty,
      unit: lot.unit,
    });
  }
  return prepared;
}
