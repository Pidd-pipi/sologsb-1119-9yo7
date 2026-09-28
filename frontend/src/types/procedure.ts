/** 工序类型 */
export type StepType = '清修' | '加固' | '粘接' | '补配' | '翻模';

export const STEP_TYPES: StepType[] = ['清修', '加固', '粘接', '补配', '翻模'];

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

/** 工序可领用的材料种类 */
export type MaterialKind = '工具' | '磨料' | '胶种';

/** 工序上的一笔材料用量（按批次扣减库存后留下的使用记录） */
export interface MaterialUsage {
  id: string;
  kind: MaterialKind;
  /** 品名（工具名 / 磨料目数 / 胶种名） */
  itemName: string;
  /** 所选材料批次 id */
  lotId: string;
  /** 批号快照 */
  lotNo: string;
  /** 用量 */
  qty: number;
  /** 单位快照 */
  unit: string;
  /** 扣库存时写入的领用记录 id（SupplyIssue.id） */
  issueId?: string;
  /** 工序节点回退后该笔用量已退回对应批次 */
  returned?: boolean;
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
  /** 工具 */
  tools: string[];
  /** 磨料目数 */
  abrasive: string;
  /** 胶种 */
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
  /** 按批次领用的材料用量（v3 起；老工序为空数组，回退时不影响库存） */
  materialUsages: MaterialUsage[];
}

export type PrepProcedureDraft = Omit<PrepProcedure, 'id'>;
