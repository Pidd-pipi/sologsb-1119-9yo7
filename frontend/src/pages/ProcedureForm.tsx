import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import FormControlLabel from '@mui/material/FormControlLabel';
import Checkbox from '@mui/material/Checkbox';
import InputLabel from '@mui/material/InputLabel';
import { useSpecimenStore } from '../stores/specimenStore';
import { useProcedureStore, MaterialCheckError } from '../stores/procedureStore';
import { useSupplyStore } from '../stores/supplyStore';
import { usePrepProgress } from '../hooks/usePrepProgress';
import { ProcedureTimeline } from '../components/common/ProcedureTimeline';
import { MeasureField } from '../components/common/MeasureField';
import { STEP_FIELD_MAP, STEP_TYPES, type MaterialKind, type StepType } from '../types/procedure';
import { isLowStock, shelfLifeLeftDays, type SupplyLot } from '../types/supply';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { makeSketchDataUrl, type PrepPhoto } from '../types/photo';

/** 表单里一项待领用材料的草稿 */
interface UsageDraft {
  key: string;
  kind: MaterialKind;
  itemName: string;
  lotId: string;
  qty: number;
}

/** 批次与品名的匹配度：同名 > 名称互含 > 同种类其它批次 */
function lotRelevance(lot: SupplyLot, itemName: string): number {
  if (lot.name === itemName) return 0;
  if (lot.name.includes(itemName) || itemName.includes(lot.name)) return 1;
  return 2;
}

/** 材料批次下拉：按种类过滤并按与品名的相关度排序，过期/零库存批次标注但不禁用 */
function lotOptions(lots: SupplyLot[], kind: MaterialKind, itemName: string): SupplyLot[] {
  return lots
    .filter((lot) => lot.kind === kind)
    .sort((a, b) => lotRelevance(a, itemName) - lotRelevance(b, itemName) || b.openedAt - a.openedAt);
}

/** 依据勾选的工具/磨料/胶种生成键行（批次、用量在草稿里补） */
function buildKeyRows(tools: string[], abrasive: string, adhesive: string) {
  return [
    ...tools.map((name) => ({ key: `tool:${name}`, kind: '工具' as const, itemName: name })),
    ...(abrasive ? [{ key: `abrasive:${abrasive}`, kind: '磨料' as const, itemName: abrasive }] : []),
    ...(adhesive ? [{ key: `adhesive:${adhesive}`, kind: '胶种' as const, itemName: adhesive }] : []),
  ];
}

/** /procedures/new 新建工序节点：选类型动态出字段，序号跳号报错；每项材料按批次领用 */
export default function ProcedureForm() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const specimens = useSpecimenStore((s) => s.items);
  const lots = useSupplyStore((s) => s.items);
  const addProcedure = useProcedureStore((s) => s.add);
  const finish = useProcedureStore((s) => s.finish);
  const rollback = useProcedureStore((s) => s.rollback);

  const [specimenId, setSpecimenId] = useState(params.get('specimenId') ?? specimens[0]?.id ?? '');
  const [stepType, setStepType] = useState<StepType>('清修');
  const [nodeName, setNodeName] = useState('');
  const [seq, setSeq] = useState(1);
  const [tools, setTools] = useState<string[]>([]);
  const [abrasive, setAbrasive] = useState('');
  const [adhesive, setAdhesive] = useState('');
  const [adhesiveConc, setAdhesiveConc] = useState(5);
  const [durationMin, setDurationMin] = useState(60);
  const [tempC, setTempC] = useState(22);
  const [rh, setRh] = useState(50);
  const [operator, setOperator] = useState('');
  const [withPhotos, setWithPhotos] = useState(true);
  const [usageDrafts, setUsageDrafts] = useState<Record<string, UsageDraft>>({});
  const [error, setError] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [toast, setToast] = useState('');

  const progress = usePrepProgress(specimenId || undefined);
  const fieldMap = STEP_FIELD_MAP[stepType];
  const nextSeq = progress.list.length === 0 ? 1 : Math.max(...progress.list.map((it) => it.seq)) + 1;

  const specimen = useMemo(() => specimens.find((it) => it.id === specimenId), [specimens, specimenId]);

  /** 依据当前勾选项同步领用草稿：新增项给默认批次/用量，取消的项移除 */
  const syncUsageDrafts = (next: { tools: string[]; abrasive: string; adhesive: string }) => {
    setUsageDrafts((prev) => {
      const out: Record<string, UsageDraft> = {};
      for (const row of buildKeyRows(next.tools, next.abrasive, next.adhesive)) {
        const old = prev[row.key];
        if (old) {
          out[row.key] = old;
          continue;
        }
        const candidate = lotOptions(lots, row.kind, row.itemName).find(
          (lot) => lot.qty > 0 && shelfLifeLeftDays(lot) >= 0,
        );
        out[row.key] = { ...row, lotId: candidate?.id ?? '', qty: 1 };
      }
      return out;
    });
  };

  const usageRows = useMemo<UsageDraft[]>(() => {
    return buildKeyRows(tools, abrasive, adhesive).map(
      (row) => usageDrafts[row.key] ?? { ...row, lotId: '', qty: 1 },
    );
  }, [tools, abrasive, adhesive, usageDrafts]);

  /** 提交前的表单侧校验，返回全部问题；事务内会按库内实时数据再兜底一次 */
  const validateUsages = (rows: UsageDraft[]): string[] => {
    const problems: string[] = [];
    const chosenLots = new Map<string, string>();
    for (const row of rows) {
      if (!row.lotId) {
        problems.push(`「${row.itemName}」未选择批次`);
        continue;
      }
      if (chosenLots.has(row.lotId)) {
        problems.push(
          `批次被「${chosenLots.get(row.lotId)}」与「${row.itemName}」重复使用，同一批次只能选择一次`,
        );
        continue;
      }
      const lot = lots.find((it) => it.id === row.lotId);
      if (!lot) {
        problems.push(`「${row.itemName}」所选批次已不存在，请重新选择`);
        continue;
      }
      chosenLots.set(row.lotId, row.itemName);
      const left = shelfLifeLeftDays(lot);
      if (left < 0) {
        problems.push(`「${row.itemName}」批次 ${lot.lotNo} 已过期 ${-left} 天，禁止领用`);
      }
      if (!(row.qty > 0)) {
        problems.push(`「${row.itemName}」用量需大于 0`);
      } else if (row.qty > lot.qty) {
        problems.push(`「${row.itemName}」批次 ${lot.lotNo} 在库仅 ${lot.qty} ${lot.unit}，不足 ${row.qty} ${lot.unit}`);
      }
    }
    return problems;
  };

  const submit = async () => {
    if (!specimenId) {
      setError('请先选择标本');
      setErrors([]);
      return;
    }
    if (!nodeName.trim()) {
      setError('节点名称必填');
      setErrors([]);
      return;
    }
    if (!operator.trim()) {
      setError('责任人必填');
      setErrors([]);
      return;
    }
    const used = progress.list.map((it) => it.seq);
    if (used.includes(seq)) {
      setError(`序号 ${seq} 已被占用，请改用 ${nextSeq}`);
      setErrors([]);
      return;
    }
    if (seq > nextSeq) {
      setError(`序号跳号：当前最大序号为 ${Math.max(0, nextSeq - 1)}，新节点必须用 ${nextSeq}`);
      setErrors([]);
      return;
    }
    if (!Number.isFinite(adhesiveConc) || adhesiveConc < 0 || adhesiveConc > 100) {
      setError('胶液浓度需在 0 ~ 100 % 之间');
      setErrors([]);
      return;
    }
    const problems = validateUsages(usageRows);
    if (problems.length > 0) {
      setError('材料领用校验未通过，请修正后再保存');
      setErrors(problems);
      return;
    }

    const materialUsages = usageRows.map((row) => {
      const lot = lots.find((it) => it.id === row.lotId)!;
      return {
        id: newId('mu'),
        kind: row.kind,
        itemName: row.itemName,
        lotId: row.lotId,
        lotNo: lot.lotNo,
        qty: row.qty,
        unit: lot.unit,
      };
    });

    let recordId = '';
    try {
      const record = await addProcedure({
        specimenId,
        stepType,
        nodeName: nodeName.trim(),
        seq,
        tools,
        abrasive,
        adhesive: fieldMap.adhesives.length > 0 ? adhesive : '',
        adhesiveConc: fieldMap.needConc ? adhesiveConc : 0,
        durationMin,
        tempC,
        rh,
        photoBeforeIds: [],
        photoAfterIds: [],
        operator: operator.trim(),
        startedAt: Date.now(),
        state: 'pending',
        materialUsages,
      });
      recordId = record.id;
    } catch (err) {
      setError(err instanceof MaterialCheckError ? err.message : '保存失败，请重试');
      setErrors([]);
      return;
    }

    if (withPhotos && specimen) {
      const before: PrepPhoto = {
        id: newId('pho'),
        specimenId,
        procedureId: recordId,
        stage: 'before',
        caption: `${nodeName.trim()} · 修复前（${specimen.specimenNo}）`,
        dataUrl: makeSketchDataUrl(`修复前 · ${specimen.specimenNo}`, '#6b5844'),
        capturedAt: Date.now(),
      };
      const after: PrepPhoto = {
        id: newId('pho'),
        specimenId,
        procedureId: recordId,
        stage: 'after',
        caption: `${nodeName.trim()} · 修复后（${specimen.specimenNo}）`,
        dataUrl: makeSketchDataUrl(`修复后 · ${specimen.specimenNo}`, '#3f5a4a'),
        capturedAt: Date.now() + 1,
      };
      await db.photos.bulkPut([before, after]);
    }

    setError('');
    setErrors([]);
    setToast(`已保存节点 #${seq} ${stepType} · ${nodeName.trim()}，已按批次扣减 ${materialUsages.length} 项库存`);
    setNodeName('');
    setTools([]);
    setAbrasive('');
    setAdhesive('');
    setUsageDrafts({});
    setSeq(nextSeq + 1);
  };

  /** 渲染一项材料的「批次 + 用量」行 */
  const renderUsageRow = (row: UsageDraft) => {
    const options = lotOptions(lots, row.kind, row.itemName);
    const selected = lots.find((it) => it.id === row.lotId);
    const left = selected ? shelfLifeLeftDays(selected) : null;
    const overStock = selected ? row.qty > selected.qty : false;
    return (
      <Stack
        key={row.key}
        direction={{ xs: 'column', md: 'row' }}
        spacing={1.5}
        alignItems={{ md: 'center' }}
        sx={{ px: 1.5, py: 1, borderRadius: 1, bgcolor: 'grey.50' }}
      >
        <Chip size="small" label={row.kind} variant="outlined" sx={{ width: 52 }} />
        <Typography variant="body2" sx={{ width: { md: 150 }, fontWeight: 600 }} noWrap>
          {row.itemName}
        </Typography>
        <TextField
          select
          size="small"
          label="批次"
          required
          value={row.lotId}
          sx={{ flex: 2 }}
          onChange={(e) =>
            setUsageDrafts((prev) => ({
              ...prev,
              [row.key]: { ...row, lotId: e.target.value },
            }))
          }
        >
          <MenuItem value="">
            <em>请选择批次</em>
          </MenuItem>
          {options.map((lot) => {
            const days = shelfLifeLeftDays(lot);
            return (
              <MenuItem key={lot.id} value={lot.id}>
                {lot.lotNo} · {lot.name}（{lot.spec}）· 在库 {lot.qty} {lot.unit}
                {days < 0 ? ` · 已过期${-days}天` : ` · 剩余保质 ${days} 天`}
                {lot.qty <= 0 ? ' · 无库存' : ''}
              </MenuItem>
            );
          })}
        </TextField>
        <Box sx={{ width: { md: 170 } }}>
          <MeasureField
            label="用量"
            unit={selected?.unit ?? ''}
            min={0}
            max={selected?.qty ?? undefined}
            step={1}
            value={row.qty}
            onChange={(v) => setUsageDrafts((prev) => ({ ...prev, [row.key]: { ...row, qty: v } }))}
          />
        </Box>
        <Box sx={{ width: { md: 200 }, minHeight: 20 }}>
          {selected ? (
            left !== null && left < 0 ? (
              <Chip size="small" color="error" label={`已过期 ${-left} 天`} />
            ) : overStock ? (
              <Chip size="small" color="error" label={`库存不足（在库 ${selected.qty} ${selected.unit}）`} />
            ) : isLowStock(selected) ? (
              <Chip size="small" color="warning" label={`在库 ${selected.qty} ${selected.unit} · 低量`} />
            ) : (
              <Typography variant="caption" color="text.secondary">
                在库 {selected.qty} {selected.unit} · 剩余保质 {left} 天
              </Typography>
            )
          ) : options.length === 0 ? (
            <Typography variant="caption" color="error">
              暂无「{row.kind}」批次，请到材料台账登记
            </Typography>
          ) : (
            <Typography variant="caption" color="text.secondary">
              请选择批次
            </Typography>
          )}
        </Box>
      </Stack>
    );
  };

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" spacing={1}>
        <Typography variant="h5" fontWeight={700}>
          新建工序节点
        </Typography>
        <Chip size="small" variant="outlined" label={`建议序号 ${nextSeq}`} />
        <Chip size="small" variant="outlined" label={`现有节点 ${progress.total} 个`} />
        <Box sx={{ flex: 1 }} />
        <Button onClick={() => navigate(`/specimens/${specimenId}`)} disabled={!specimenId}>
          查看标本详情
        </Button>
      </Stack>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 420px' }, gap: 2 }}>
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack spacing={1.5}>
            {error ? <Alert severity="error" data-testid="procedure-error">{error}</Alert> : null}
            {errors.length > 0 ? (
              <Alert severity="warning" data-testid="usage-errors">
                <Stack spacing={0.25}>
                  {errors.map((msg, i) => (
                    <Typography key={i} variant="body2">
                      · {msg}
                    </Typography>
                  ))}
                </Stack>
              </Alert>
            ) : null}
            <TextField
              select
              size="small"
              label="标本"
              value={specimenId}
              onChange={(e) => {
                setSpecimenId(e.target.value);
                setSeq(1);
              }}
            >
              {specimens.map((it) => (
                <MenuItem key={it.id} value={it.id}>
                  {it.specimenNo} · {it.taxon}
                </MenuItem>
              ))}
            </TextField>

            <Stack direction="row" spacing={1.5}>
              <TextField
                select
                size="small"
                fullWidth
                label="工序类型"
                value={stepType}
                onChange={(e) => {
                  const next = e.target.value as StepType;
                  setStepType(next);
                  setTools([]);
                  setAbrasive('');
                  setAdhesive('');
                  setUsageDrafts({});
                }}
              >
                {STEP_TYPES.map((t) => (
                  <MenuItem key={t} value={t}>
                    {t}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                size="small"
                fullWidth
                label="节点名称"
                required
                value={nodeName}
                onChange={(e) => setNodeName(e.target.value)}
              />
              <Box sx={{ width: 120 }}>
                <MeasureField
                  label="序号"
                  unit="seq"
                  min={1}
                  max={999}
                  step={1}
                  value={seq}
                  onChange={setSeq}
                  hint={`不得跳号，建议 ${nextSeq}`}
                />
              </Box>
            </Stack>

            {fieldMap.tools.length > 0 ? (
              <TextField
                select
                size="small"
                label="使用工具"
                SelectProps={{ multiple: true }}
                value={tools}
                onChange={(e) => {
                  const v = e.target.value;
                  const nextTools = typeof v === 'string' ? v.split(',') : v;
                  setTools(nextTools);
                  syncUsageDrafts({ tools: nextTools, abrasive, adhesive });
                }}
                helperText="气动笔 / 剔针 / 超声波 等，可多选；选中后逐项选择批次并填写用量"
              >
                {fieldMap.tools.map((t) => (
                  <MenuItem key={t} value={t}>
                    {t}
                  </MenuItem>
                ))}
              </TextField>
            ) : (
              <Alert severity="info">该工序类型无需工具清单</Alert>
            )}

            {fieldMap.abrasives.length > 0 ? (
              <TextField
                select
                size="small"
                label="磨料目数"
                value={abrasive}
                onChange={(e) => {
                  const v = e.target.value;
                  setAbrasive(v);
                  syncUsageDrafts({ tools, abrasive: v, adhesive });
                }}
              >
                <MenuItem value="">不适用</MenuItem>
                {fieldMap.abrasives.map((a) => (
                  <MenuItem key={a} value={a}>
                    {a}
                  </MenuItem>
                ))}
              </TextField>
            ) : null}

            {fieldMap.adhesives.length > 0 ? (
              <Stack direction="row" spacing={1.5}>
                <TextField
                  select
                  size="small"
                  fullWidth
                  label="胶种"
                  value={adhesive}
                  onChange={(e) => {
                    const v = e.target.value;
                    setAdhesive(v);
                    syncUsageDrafts({ tools, abrasive, adhesive: v });
                  }}
                >
                  <MenuItem value="">未选定</MenuItem>
                  {fieldMap.adhesives.map((a) => (
                    <MenuItem key={a} value={a}>
                      {a}
                    </MenuItem>
                  ))}
                </TextField>
                {fieldMap.needConc ? (
                  <Box sx={{ flex: 1 }}>
                    <MeasureField
                      label="胶液浓度"
                      unit="%"
                      min={0}
                      max={100}
                      step={0.5}
                      value={adhesiveConc}
                      onChange={setAdhesiveConc}
                    />
                  </Box>
                ) : null}
              </Stack>
            ) : null}

            {usageRows.length > 0 ? (
              <Box>
                <InputLabel shrink sx={{ mb: 0.5 }}>
                  材料领用（按批次扣减库存，保存后不可超扣/领用过期批次）
                </InputLabel>
                <Stack spacing={1}>{usageRows.map(renderUsageRow)}</Stack>
              </Box>
            ) : (
              <Typography variant="caption" color="text.secondary">
                选择工具 / 磨料 / 胶种后，在此逐项选择批次并填写用量。
              </Typography>
            )}

            <Stack direction="row" spacing={1.5}>
              <Box sx={{ flex: 1 }}>
                <MeasureField
                  label="耗时"
                  unit="min"
                  min={1}
                  max={1440}
                  step={1}
                  value={durationMin}
                  onChange={setDurationMin}
                />
              </Box>
              <Box sx={{ flex: 1 }}>
                <MeasureField label="环境温度" unit="℃" min={-10} max={60} step={0.5} value={tempC} onChange={setTempC} />
              </Box>
              <Box sx={{ flex: 1 }}>
                <MeasureField label="相对湿度" unit="%" min={0} max={100} step={1} value={rh} onChange={setRh} />
              </Box>
            </Stack>

            <TextField
              size="small"
              label="责任人"
              required
              value={operator}
              onChange={(e) => setOperator(e.target.value)}
            />

            <FormControlLabel
              control={<Checkbox checked={withPhotos} onChange={(e) => setWithPhotos(e.target.checked)} />}
              label="同时挂接修复前 / 修复后留痕影像（本地生成）"
            />

            <Stack direction="row" spacing={1}>
              <Button variant="contained" onClick={submit}>
                保存节点
              </Button>
              <Button onClick={() => navigate('/procedures/new')}>清空重填</Button>
            </Stack>
          </Stack>
        </Paper>

        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle1" fontWeight={700} gutterBottom>
            该标本现有工序
          </Typography>
          {specimen ? (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              {specimen.specimenNo} · 完成度 {progress.percent}% · 待办{' '}
              {progress.current ? `#${progress.current.seq} ${progress.current.nodeName}` : '无'}
            </Typography>
          ) : null}
          <ProcedureTimeline
            items={progress.list}
            onFinish={async (pid) => {
              await finish(pid);
              setToast('节点已完成');
            }}
            onRollback={async (pid) => {
              await rollback(pid);
              setToast('节点已回退，用量已退回对应批次');
            }}
          />
        </Paper>
      </Box>

      <Snackbar open={!!toast} autoHideDuration={2600} onClose={() => setToast('')} message={toast} />
    </Stack>
  );
}
