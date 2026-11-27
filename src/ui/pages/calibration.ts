// 标定管理页：按「钢材 + 坯料尺寸」管理测温枪标定曲线。
// 支持手工录入 (温度, f1, tau1)、用合成参考值一键生成示例标定、删除整条曲线。
import { f1AtTemperature, SIZE_PARAMS, STEEL_PARAMS, tauAtTemperature, mulberry32 } from '../../dsp/synth.ts';
import type { CalibrationPoint, CalibrationProfile } from '../../dsp/types.ts';
import { BILLET_SIZES, STEEL_GRADES } from '../../dsp/types.ts';
import { store } from '../../state/store.ts';
import { drawChart } from '../chart.ts';
import { el, toast } from '../dom.ts';

export function renderCalibrationPage(container: HTMLElement): void {
  container.replaceChildren();
  const state = store.getState();

  const gradeSel = el('select', {}, ...STEEL_GRADES.map((g) =>
    el('option', { value: g.id }, g.label))) as HTMLSelectElement;
  const sizeSel = el('select', {}, ...BILLET_SIZES.map((g) =>
    el('option', { value: g.id }, g.label))) as HTMLSelectElement;
  gradeSel.value = state.grade;
  sizeSel.value = state.size;

  const tempInput = numberInput('测温枪温度 °C', 1000);
  const f1Input = numberInput('基频 f1 Hz', 600);
  const tauInput = numberInput('衰减 tau ms', 30);

  const pointsBody = el('tbody');
  const curveCanvas = el('canvas', { className: 'chart' }) as HTMLCanvasElement;
  const profileMeta = el('div', { className: 'muted' }, '');

  function currentProfile(): CalibrationProfile | undefined {
    return store.getState().profiles.find(
      (p) => p.grade === gradeSel.value && p.size === sizeSel.value,
    );
  }

  function renderPoints(): void {
    const profile = currentProfile();
    const points = profile?.points ?? [];
    pointsBody.replaceChildren();
    if (points.length === 0) {
      pointsBody.append(el('tr', {}, el('td', { colSpan: '5', className: 'empty' }, '尚无标定点')));
    }
    const sorted = [...points].sort((a, b) => b.temperatureC - a.temperatureC);
    sorted.forEach((p, idx) => {
      const tr = el('tr');
      tr.append(
        el('td', {}, `${p.temperatureC}`),
        el('td', {}, p.f1.toFixed(1)),
        el('td', {}, (p.tau1 * 1000).toFixed(1)),
        el('td', {}, new Date(profile?.updatedAt ?? Date.now()).toLocaleDateString('zh-CN')),
        el('td', {}, (() => {
          const del = el('button', { className: 'danger' }, '删除');
          del.addEventListener('click', () => removePoint(p));
          return del;
        })()),
      );
      void idx;
      pointsBody.append(tr);
    });
    profileMeta.textContent = profile
      ? `当前曲线 ${points.length} 个标定点（${gradeSel.value} / ${sizeSel.value}）`
      : '该钢材+尺寸组合还没有标定，温度将使用物理兜底估算';

    drawChart(curveCanvas, [
      {
        label: 'f1 Hz',
        color: '#5aa9e6',
        points: [...points].sort((a, b) => a.temperatureC - b.temperatureC)
          .map((p) => ({ x: p.temperatureC, y: p.f1 })),
      },
      {
        label: 'tau×100 (ms/10)',
        color: '#6fbf6f',
        points: [...points].sort((a, b) => a.temperatureC - b.temperatureC)
          .map((p) => ({ x: p.temperatureC, y: p.tau1 * 1000 })),
        dashed: true,
      },
    ], { xLabel: '温度 °C', yLabel: 'f1 Hz / tau ms' });
  }

  function persist(nextPoints: CalibrationPoint[]): void {
    const existing = currentProfile();
    const profile: CalibrationProfile = {
      id: existing?.id ?? `cal-${gradeSel.value}-${sizeSel.value}-${Date.now()}`,
      grade: gradeSel.value as CalibrationProfile['grade'],
      size: sizeSel.value as CalibrationProfile['size'],
      points: nextPoints,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    store.upsertProfile(profile);
    renderPoints();
  }

  function addPoint(): void {
    const temperatureC = Number(tempInput.value);
    const f1 = Number(f1Input.value);
    const tauMs = Number(tauInput.value);
    if (!temperatureC || !f1 || !tauMs) {
      toast('请填写完整的温度、f1、tau');
      return;
    }
    const points = currentProfile()?.points ?? [];
    // 同温度覆盖
    const filtered = points.filter((p) => p.temperatureC !== temperatureC);
    filtered.push({ temperatureC, f1, tau1: tauMs / 1000 });
    persist(filtered);
    toast(`已加入标定点 ${temperatureC}°C`);
  }

  function removePoint(target: CalibrationPoint): void {
    const points = currentProfile()?.points ?? [];
    persist(points.filter((p) => p.temperatureC !== target.temperatureC));
  }

  // 用合成器的物理参考值生成一条示例标定，便于无测温枪时先跑通流程
  function generateDemo(): void {
    const steel = STEEL_PARAMS[gradeSel.value as keyof typeof STEEL_PARAMS];
    const sizeCfg = SIZE_PARAMS[sizeSel.value as keyof typeof SIZE_PARAMS];
    const rng = mulberry32(1234);
    const temps = [1250, 1150, 1050, 950, 850, 750];
    const points: CalibrationPoint[] = temps.map((temperatureC) => ({
      temperatureC,
      f1: f1AtTemperature(steel.baseF1, temperatureC, sizeCfg.freqScale),
      tau1: tauAtTemperature(temperatureC, sizeCfg.tauScale, rng),
    }));
    persist(points);
    toast('已生成示例标定（实际使用请用测温枪数据替换）');
  }

  function deleteAll(): void {
    const profile = currentProfile();
    if (!profile) return;
    if (window.confirm('确定删除这条标定曲线？')) {
      store.deleteProfile(profile.id);
      renderPoints();
    }
  }

  for (const sel of [gradeSel, sizeSel]) {
    sel.addEventListener('change', () => {
      store.setGrade(gradeSel.value as typeof state.grade);
      store.setSize(sizeSel.value as typeof state.size);
      renderPoints();
    });
  }

  const addBtn = el('button', { className: 'primary' }, '加入标定点');
  addBtn.addEventListener('click', addPoint);
  const demoBtn = el('button', {}, '生成示例标定');
  demoBtn.addEventListener('click', generateDemo);
  const delBtn = el('button', { className: 'danger' }, '删除整条曲线');
  delBtn.addEventListener('click', deleteAll);

  const table = el('table', {},
    el('thead', {}, el('tr', {},
      el('th', {}, '温度 °C'), el('th', {}, 'f1 Hz'), el('th', {}, 'tau ms'),
      el('th', {}, '更新'), el('th', {}, '操作'))),
    pointsBody,
  );

  container.append(
    el('div', { className: 'card' },
      el('h2', {}, '标定对象'),
      el('div', { className: 'row' },
        el('label', {}, '钢材 ', gradeSel),
        el('label', {}, '坯料尺寸 ', sizeSel),
        el('div', { className: 'spacer' }), profileMeta),
    ),
    el('div', { className: 'grid cols-2', style: 'margin-top:16px' },
      el('div', { className: 'card' },
        el('h2', {}, '录入标定点'),
        el('div', { className: 'grid cols-3' }, tempInput.wrap, f1Input.wrap, tauInput.wrap),
        el('div', { className: 'row', style: 'margin-top:12px' }, addBtn, demoBtn, delBtn),
        el('p', { className: 'muted', style: 'margin-top:10px;font-size:12px' },
          '操作方法：用测温枪测坯料温度，同时打一锤，把界面读出的 f1、tau 连同温度录入。建议在 750~1250°C 间均匀取 5~6 个点。'),
      ),
      el('div', { className: 'card' },
        el('h2', {}, '标定曲线'), curveCanvas),
    ),
    el('div', { className: 'card', style: 'margin-top:16px' },
      el('h2', {}, '标定点明细'),
      el('div', { className: 'table-wrap' }, table)),
  );

  renderPoints();
}

function numberInput(label: string, value: number): { wrap: HTMLElement; value: string } {
  const input = el('input', { type: 'number', step: 'any' }) as HTMLInputElement;
  input.value = value.toString();
  const wrap = el('label', { className: 'metric', style: 'gap:4px' },
    el('span', { className: 'label' }, label), input);
  return { wrap, get value() { return input.value; } };
}
