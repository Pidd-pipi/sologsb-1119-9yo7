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
import Divider from '@mui/material/Divider';
import FormControlLabel from '@mui/material/FormControlLabel';
import Checkbox from '@mui/material/Checkbox';
import { useSpecimenStore } from '../stores/specimenStore';
import { useProcedureStore } from '../stores/procedureStore';
import { useSupplyStore } from '../stores/supplyStore';
import { usePrepProgress } from '../hooks/usePrepProgress';
import { ProcedureTimeline } from '../components/common/ProcedureTimeline';
import { MeasureField } from '../components/common/MeasureField';
import {
  STEP_FIELD_MAP,
  STEP_TYPES,
  MATERIAL_ROLE_LABEL,
  type StepType,
  type MaterialRole,
} from '../types/procedure';
import { isLotExpired, shelfLifeLeftDays, type SupplyKind, type SupplyLot } from '../types/supply';
import { makeSketchDataUrl, type PrepPhoto } from '../types/photo';
import { newId } from '../utils/id';
import { usageLineKey, type UsageLineInput } from '../utils/materialUsage';

/** 候选项名与批次名称的匹配（双向包含，容忍「800 目」↔「碳化硅磨料 800 目」这类写法） */
function lotMatches(lot: SupplyLot, materialName: string): boolean {
  const a = lot.name.trim();
  const b = materialName.trim();
  return a === b || a.includes(b) || b.includes(a);
}

/** 一条材料行的批次 / 用量填写状态 */
interface LineState {
  lotId: string;
  qty: number;
}

const ROLE_KIND: Record<MaterialRole, SupplyKind> = {
  tool: '工具',
  abrasive: '磨料',
  adhesive: '胶种',
};

/** /procedures/new 新建工序节点：选类型动态出字段，工具/磨料/胶种按批次领用，序号跳号报错 */
export default function ProcedureForm() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const specimens = useSpecimenStore((s) => s.items);
  const addProcedure = useProcedureStore((s) => s.create);
  const finish = useProcedureStore((s) => s.finish);
  const rollback = useProcedureStore((s) => s.rollback);
  const lots = useSupplyStore((s) => s.items);

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
  /** key = role:materialName */
  const [lines, setLines] = useState<Record<string, LineState>>({});
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');

  const progress = usePrepProgress(specimenId || undefined);
  const fieldMap = STEP_FIELD_MAP[stepType];
  const nextSeq = progress.list.length === 0 ? 1 : Math.max(...progress.list.map((it) => it.seq)) + 1;

  const specimen = useMemo(() => specimens.find((it) => it.id === specimenId), [specimens, specimenId]);

  /** 当前已选材料行（工具多选 + 磨料单选 + 胶种单选） */
  const selectedLines = useMemo(
    () => [
      ...tools.map((name) => ({ role: 'tool' as MaterialRole, materialName: name })),
      ...(abrasive ? [{ role: 'abrasive' as MaterialRole, materialName: abrasive }] : []),
      ...(adhesive ? [{ role: 'adhesive' as MaterialRole, materialName: adhesive }] : []),
    ],
    [tools, abrasive, adhesive],
  );

  /** 每种材料候选的有效批次（未过期、同种类，按名称匹配） */
  const lotsFor = (role: MaterialRole, materialName: string): SupplyLot[] => {
    const kind = ROLE_KIND[role];
    return lots
      .filter((lot) => lot.kind === kind && lotMatches(lot, materialName))
      .sort((a, b) => a.lotNo.localeCompare(b.lotNo));
  };

  const setLine = (key: string, patch: Partial<LineState>) => {
    setLines((prev) => {
      const cur = prev[key] ?? { lotId: '', qty: 1 };
      return { ...prev, [key]: { ...cur, ...patch } };
    });
  };

  const resetLineStates = () => setLines({});

  const submit = async () => {
    setError('');
    if (!specimenId) {
      setError('请先选择标本');
      return;
    }
    if (!nodeName.trim()) {
      setError('节点名称必填');
      return;
    }
    if (!operator.trim()) {
      setError('责任人必填');
      return;
    }
    const used = progress.list.map((it) => it.seq);
    if (used.includes(seq)) {
      setError(`序号 ${seq} 已被占用，请改用 ${nextSeq}`);
      return;
    }
    if (seq > nextSeq) {
      setError(`序号跳号：当前最大序号为 ${Math.max(0, nextSeq - 1)}，新节点必须用 ${nextSeq}`);
      return;
    }
    if (!Number.isFinite(adhesiveConc) || adhesiveConc < 0 || adhesiveConc > 100) {
      setError('胶液浓度需在 0 ~ 100 % 之间');
      return;
    }

    // 组装领用行（事务内会再做批次 / 用量 / 库存 / 过期 / 重复批次校验）
    const usageLines: UsageLineInput[] = selectedLines.map((line) => {
      const key = usageLineKey(line.role, line.materialName);
      const state = lines[key] ?? { lotId: '', qty: NaN };
      return { ...line, lotId: state.lotId, qty: state.qty };
    });

    let photos: PrepPhoto[] = [];
    if (withPhotos && specimen) {
      photos = [
        {
          id: newId('pho'),
          specimenId,
          procedureId: '',
          stage: 'before',
          caption: `${nodeName.trim()} · 修复前（${specimen.specimenNo}）`,
          dataUrl: makeSketchDataUrl(`修复前 · ${specimen.specimenNo}`, '#6b5844'),
          capturedAt: Date.now(),
        },
        {
          id: newId('pho'),
          specimenId,
          procedureId: '',
          stage: 'after',
          caption: `${nodeName.trim()} · 修复后（${specimen.specimenNo}）`,
          dataUrl: makeSketchDataUrl(`修复后 · ${specimen.specimenNo}`, '#3f5a4a'),
          capturedAt: Date.now() + 1,
        },
      ];
    }

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
        photoBeforeIds: photos.filter((p) => p.stage === 'before').map((p) => p.id),
        photoAfterIds: photos.filter((p) => p.stage === 'after').map((p) => p.id),
        operator: operator.trim(),
        usages: usageLines,
        photos,
      });

      setToast(`已保存节点 #${seq} ${stepType} · ${record.nodeName}，材料已按批次扣减库存`);
      setNodeName('');
      setTools([]);
      setAbrasive('');
      setAdhesive('');
      resetLineStates();
      setSeq(nextSeq + 1);
    } catch (e) {
      // 库存不足 / 已过期 / 重复批次等：事务整体回滚，工序与库存均未落单
      setError(e instanceof Error ? e.message : '保存失败，请检查材料批次与用量');
    }
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
                  resetLineStates();
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
                  setTools(typeof v === 'string' ? v.split(',') : v);
                }}
                helperText="气动笔 / 剔针 / 超声波 等，可多选；选中后需在下方逐件选批次、填用量"
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
                onChange={(e) => setAbrasive(e.target.value)}
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
                  onChange={(e) => setAdhesive(e.target.value)}
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

            {/* 材料领用：每件已选工具 / 磨料 / 胶种都要选批次并填用量，保存时按批次扣减 */}
            <Paper variant="outlined" sx={{ p: 1.5, bgcolor: 'grey.50' }} data-testid="material-usages">
              <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: selectedLines.length ? 1 : 0 }}>
                <Typography variant="subtitle2" fontWeight={700}>
                  材料领用明细
                </Typography>
                <Chip size="small" label={`${selectedLines.length} 项`} />
                <Typography variant="caption" color="text.secondary">
                  保存即按所选批次扣减库存；批次过期或库存不足将无法保存
                </Typography>
              </Stack>
              {selectedLines.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  先在上方选择工具 / 磨料 / 胶种，这里会逐项列出批次与用量。
                </Typography>
              ) : (
                <Stack spacing={1.5}>
                  {selectedLines.map((line) => {
                    const key = usageLineKey(line.role, line.materialName);
                    const candidates = lotsFor(line.role, line.materialName);
                    const state = lines[key] ?? { lotId: '', qty: 1 };
                    const chosen = lots.find((lot) => lot.id === state.lotId);
                    const expired = chosen ? isLotExpired(chosen) : false;
                    const short = chosen ? state.qty > chosen.qty : false;
                    const noBatch = candidates.length === 0;
                    return (
                      <Box
                        key={key}
                        data-testid={`usage-row-${key}`}
                        sx={{
                          display: 'grid',
                          gridTemplateColumns: { xs: '1fr', sm: '150px 1fr 170px' },
                          gap: 1.5,
                          alignItems: 'start',
                        }}
                      >
                        <Stack direction="row" spacing={0.5} alignItems="center" sx={{ pt: 1 }}>
                          <Chip size="small" variant="outlined" label={MATERIAL_ROLE_LABEL[line.role]} />
                          <Typography variant="body2" noWrap title={line.materialName}>
                            {line.materialName}
                          </Typography>
                        </Stack>
                        <TextField
                          select
                          size="small"
                          fullWidth
                          label="批次"
                          required
                          value={state.lotId}
                          onChange={(e) => setLine(key, { lotId: e.target.value })}
                          error={noBatch || expired}
                          helperText={
                            noBatch
                              ? '台账中没有该材料的批次，请到「材料台账」登记'
                              : chosen
                                ? `批号 ${chosen.lotNo} · 现存 ${chosen.qty} ${chosen.unit}${
                                    expired
                                      ? ' · 已过期'
                                      : shelfLifeLeftDays(chosen) <= 30
                                        ? ` · ${shelfLifeLeftDays(chosen)} 天后到期`
                                        : ''
                                  }`
                                : '请选择批次'
                          }
                        >
                          {candidates.map((lot) => {
                            const lotExpired = isLotExpired(lot);
                            return (
                              <MenuItem key={lot.id} value={lot.id} disabled={lotExpired || lot.qty <= 0}>
                                {lot.lotNo} · {lot.name}
                                {lot.spec ? `（${lot.spec}）` : ''} · 在库 {lot.qty} {lot.unit}
                                {lotExpired ? ' · 已过期' : lot.qty <= 0 ? ' · 无库存' : ''}
                              </MenuItem>
                            );
                          })}
                        </TextField>
                        <Box>
                          <MeasureField
                            label="用量"
                            unit={chosen?.unit ?? '—'}
                            min={0.1}
                            max={chosen?.qty ?? 100000}
                            step={0.1}
                            value={state.qty}
                            onChange={(v) => setLine(key, { qty: v })}
                            hint={
                              chosen
                                ? short
                                  ? `超出在库 ${chosen.qty} ${chosen.unit}`
                                  : `在库 ${chosen.qty} ${chosen.unit}`
                                : '先选批次'
                            }
                          />
                        </Box>
                      </Box>
                    );
                  })}
                </Stack>
              )}
            </Paper>

            <Divider />

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
              try {
                await finish(pid);
                setToast('节点已完成');
              } catch (e) {
                setToast(e instanceof Error ? e.message : '完成失败');
              }
            }}
            onRollback={async (pid) => {
              try {
                await rollback(pid);
                setToast('节点已回退，材料用量已退回对应批次');
              } catch (e) {
                setToast(e instanceof Error ? e.message : '回退失败');
              }
            }}
          />
        </Paper>
      </Box>

      <Snackbar open={!!toast} autoHideDuration={2600} onClose={() => setToast('')} message={toast} />
    </Stack>
  );
}
