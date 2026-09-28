/** 工序类型 */
export type StepType = '清修' | '加固' | '粘接' | '补配' | '翻模';

export const STEP_TYPES: StepType[] = ['清修', '加固', '粘接', '补配', '翻模'];

/** 材料用途分类（对应台账种类） */
export type MaterialRole = 'tool' | 'abrasive' | 'adhesive';

export const MATERIAL_ROLE_LABEL: Record<MaterialRole, string> = {
  tool: '工具',
  abrasive: '磨料',
  adhesive: '胶种',
};

/** 各工序类型适用的工具、磨料、胶种候选（表单动态字段用） */
export const STEP_FIELD_MAP: Record<
  StepType,
  { tools: string[]; abrasives: string[]; adhesives: string[]; needConc: boolean }
> = {
  清修: {
    tools: ['气动笔', '剔针', '超声波清洗机', '软毛刷'],
    abrasives: ['400 目', '800 目', '1200 目'],
    adhesives: [],
    needConc: false,
  },
  加固: {
    tools: ['渗透滴管', '真空浸渗罐', '加热台'],
    abrasives: [],
    adhesives: ['Paraloid B-72', '氰基丙烯酸酯', '环氧树脂 E44'],
    needConc: true,
  },
  粘接: {
    tools: ['点胶针', '夹持架', '热风枪'],
    abrasives: [],
    adhesives: ['Paraloid B-72', '氰基丙烯酸酯', '动物胶'],
    needConc: true,
  },
  补配: {
    tools: ['刮刀', '雕刻刀', '石膏模'],
    abrasives: ['600 目', '1000 目'],
    adhesives: ['环氧树脂 E44', 'Paraloid B-72'],
    needConc: true,
  },
  翻模: {
    tools: ['硅胶模具', '真空脱泡机', '石膏桶'],
    abrasives: [],
    adhesives: ['硅橡胶', '石膏浆料'],
    needConc: false,
  },
};

/** 工序节点状态 */
export type ProcedureState = 'pending' | 'done' | 'rolledback';

/**
 * 单项材料领用明细：表单中每选一件工具 / 磨料 / 胶种，
 * 都要选定批次并填写用量，保存时按批次扣减库存。
 */
export interface MaterialUsage {
  /** 行唯一标识（表单内部用，保存时可随记录持久化） */
  key: string;
  /** 材料用途分类 */
  role: MaterialRole;
  /** 材料名称（工具/磨料/胶种候选项名） */
  materialName: string;
  /** 所选材料批次 id（SupplyLot.id） */
  lotId: string;
  /** 批号（冗余落单，批次日后被删也能留痕） */
  lotNo: string;
  /** 用量（按批次单位计） */
  qty: number;
  /** 单位（冗余，取批次单位） */
  unit: string;
  /** 对应的领用记录 id（SupplyIssue.id），回退时据此标记退库 */
  issueId?: string;
}

/** 修复工序 */
export interface PrepProcedure {
  id: string;
  specimenId: string;
  stepType: StepType;
  /** 节点名称 */
  nodeName: string;
  /** 序号，不得跳号 */
  seq: number;
  /** 工具（旧字段保留，老数据兼容；新数据与 usages 同步写入） */
  tools: string[];
  /** 磨料目数（旧字段保留） */
  abrasive: string;
  /** 胶种（旧字段保留） */
  adhesive: string;
  /** 胶液浓度 % */
  adhesiveConc: number;
  /** 耗时 min */
  durationMin: number;
  /** 环境温度 ℃ */
  tempC: number;
  /** 相对湿度 % */
  rh: number;
  photoBeforeIds: string[];
  photoAfterIds: string[];
  operator: string;
  startedAt: number;
  state: ProcedureState;
  finishedAt?: number;
  /** 材料领用明细（v3 新增，旧工序为空数组） */
  usages: MaterialUsage[];
}

export type PrepProcedureDraft = Omit<PrepProcedure, 'id'>;
