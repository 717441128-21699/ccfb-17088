import { runSyntheticSelfTest, type SelfTestReport } from '../../core/selftest';
import { synthesizeStrike } from '../../core/synth';
import { uid } from '../../core/pipeline';
import { store } from '../../state/store';
import type { AppData, CalibrationPoint } from '../../core/types';
import { downloadText, h } from '../dom';
import { profileLabel } from '../labels';
import type { PageHandle } from './types';

export function renderCalibration(): PageHandle {
  const data = store.data;
  const key = data.settings.profileKey;
  const [steelId, sizeId] = key.split('::');
  const steel = data.steels.find((s) => s.id === steelId) ?? data.steels[0];
  const size = data.sizes.find((s) => s.id === sizeId) ?? data.sizes[0];
  const points = data.calibration.filter((p) => p.profileKey === key).sort((a, b) => b.tempC - a.tempC);

  const profileSelect = h('select', {
    class: 'input',
    on: { change: (e) => store.updateSettings({ profileKey: (e.currentTarget as HTMLSelectElement).value }) },
  }, ...data.steels.flatMap((s) =>
    data.sizes.map((z) => {
      const k = `${s.id}::${z.id}`;
      return h('option', { attrs: { value: k, selected: k === key } }, `${s.name} · ${z.label}`);
    }),
  )) as HTMLSelectElement;

  const info = h('div', { class: 'profile-info' },
    infoRow('弹性模量', `${steel.elasticModulusGpa} GPa`),
    infoRow('密度', `${steel.densityKgM3} kg/m³`),
    infoRow('最低锻造温度', `${steel.minForgingTempC} °C`),
    infoRow('温降经验值', `${size.tempLossPerBlowC} °C/锤 + ${size.coolingCPerSec} °C/s`),
  );

  const tempInput = h('input', { class: 'input', attrs: { type: 'number', min: '400', max: '1200', value: '900' } }) as HTMLInputElement;
  const modesInput = h('input', { class: 'input', attrs: { placeholder: '例如 286.4, 789.1, 1547.2' } }) as HTMLInputElement;
  const tauInput = h('input', { class: 'input', attrs: { placeholder: '例如 118, 74, 43' } }) as HTMLInputElement;
  const noteInput = h('input', { class: 'input', attrs: { placeholder: '测温枪距离 / 发射率 / 现场备注' } }) as HTMLInputElement;
  const formError = h('div', { class: 'form-error' });

  const latest = data.strikes.find((s) => s.profileKey === key && s.matchedModeHz.length >= 2 && s.verdict !== 'rejected');
  const fillLatest = h('button', {
    class: 'btn btn-ghost',
    on: {
      click: () => {
        if (!latest) {
          formError.textContent = '当前标定对象还没有可用锤击特征。';
          return;
        }
        modesInput.value = latest.matchedModeHz.map((v) => v.toFixed(1)).join(', ');
        tauInput.value = latest.tauMs.map((v) => Math.round(v)).join(', ');
        if (latest.tempC) tempInput.value = String(Math.round(latest.tempC));
        formError.textContent = '';
      },
    },
  }, '取最近一锤特征');

  const savePoint = h('button', { class: 'btn btn-primary' }, '保存温枪标定点');
  savePoint.addEventListener('click', () => {
    const tempC = Number(tempInput.value);
    const modes = parseNumberList(modesInput.value);
    const taus = parseNumberList(tauInput.value);
    if (!Number.isFinite(tempC) || tempC < 300 || tempC > 1300) {
      formError.textContent = '请输入 300–1300°C 之间的温枪读数。';
      return;
    }
    if (modes.length < 2) {
      formError.textContent = '至少需要两个坯料模态频率。';
      return;
    }
    const point: CalibrationPoint = {
      id: uid('cal'),
      profileKey: key,
      tempC,
      measuredAt: new Date().toISOString(),
      modesHz: modes,
      tauMs: taus.length ? taus : modes.map(() => 180),
      note: noteInput.value || '现场温枪标定',
    };
    store.addCalibrationPoint(point);
    modesInput.value = '';
    tauInput.value = '';
    noteInput.value = '';
    formError.textContent = '已保存。温度推断会立即使用新的插值曲线。';
  });

  const table = h('div', { class: 'table-wrap calibration-table' },
    h('table', { class: 'data-table' },
      h('thead', null, h('tr', null, h('th', null, '温枪温度'), h('th', null, '模态 Hz'), h('th', null, '衰减 ms'), h('th', null, '来源/时间'), h('th', null, ''))),
      h('tbody', null, ...points.slice(0, 30).map((p) =>
        h('tr', null,
          h('td', { class: 'num strong' }, `${p.tempC}°C`),
          h('td', null, p.modesHz.map((f) => f.toFixed(1)).join(' / ')),
          h('td', null, p.tauMs.map((t) => Math.round(t)).join(' / ')),
          h('td', { class: 'muted' }, p.synthetic ? `合成标定 · ${p.note ?? ''}` : `${new Date(p.measuredAt).toLocaleDateString('zh-CN')} · ${p.note ?? ''}`),
          h('td', null, h('button', { class: 'icon-btn danger', on: { click: () => store.deleteCalibrationPoint(p.id) } }, '×')),
        ),
      )),
    ),
  );

  const selfTestCard = renderSelfTest(data);
  const synthCard = renderSynthAudition(steel.id, size.id);

  const dataCard = h('div', { class: 'panel' },
    h('h3', null, '标定数据管理'),
    h('p', { class: 'muted' }, `当前共有 ${data.calibration.length} 个标定点，覆盖 ${data.steels.length} 种钢和 ${data.sizes.length} 种尺寸。`),
    h('div', { class: 'button-row' },
      h('button', { class: 'btn btn-ghost', on: { click: () => downloadText('smith-ear-calibration.json', JSON.stringify(data.calibration, null, 2), 'application/json') } }, '导出标定 JSON'),
      h('label', { class: 'btn btn-ghost file-label' }, '导入 JSON',
        h('input', {
          attrs: { type: 'file', accept: 'application/json,.json' },
          on: {
            change: async (e) => {
              const file = (e.currentTarget as HTMLInputElement).files?.[0];
              if (!file) return;
              try {
                const parsed = JSON.parse(await file.text()) as CalibrationPoint[];
                if (!Array.isArray(parsed)) throw new Error('格式应为 CalibrationPoint[]');
                store.replaceData({ ...store.data, calibration: parsed });
              } catch (err) {
                window.alert(`导入失败：${err instanceof Error ? err.message : String(err)}`);
              }
            },
          },
        }),
      ),
      h('button', {
        class: 'btn btn-danger-ghost',
        on: { click: () => { if (window.confirm('恢复全部默认数据？当前锤击和标定修改会被替换。')) store.resetAll(); } },
      }, '恢复出厂合成标定'),
    ),
  );

  return {
    root: h('section', { class: 'page calibration-page' },
      h('div', { class: 'page-header' },
        h('div', null, h('h2', null, '标定管理'), h('p', null, '用测温枪在不同颜色温度下取样；频率为主、衰减为辅，建立该钢种和尺寸的曲线。')),
      ),
      h('div', { class: 'calibration-grid' },
        h('div', { class: 'calibration-left' },
          h('div', { class: 'panel' },
            h('h3', null, '钢材 / 坯料'),
            h('label', { class: 'field' }, h('span', null, '标定对象'), profileSelect),
            info,
          ),
          h('div', { class: 'panel' },
            h('div', { class: 'panel-title-row' }, h('h3', null, '新增温枪读数'), fillLatest),
            h('div', { class: 'form-grid' },
              label('温枪温度 °C', tempInput),
              label('模态频率 Hz（至少两个）', modesInput),
              label('衰减时间 ms', tauInput),
              label('备注', noteInput),
            ),
            formError,
            savePoint,
          ),
          table,
        ),
        h('div', { class: 'calibration-right' }, selfTestCard, synthCard, dataCard),
      ),
    ),
  };
}

function renderSelfTest(data: AppData): HTMLElement {
  const progress = h('div', { class: 'selftest-progress muted' }, '将合成 9 个钢/尺寸组合、每组 8 锤，并混入鼓风机和远处锤声。');
  const result = h('div', { class: 'selftest-result' });
  const button = h('button', { class: 'btn btn-primary' }, '运行浏览器合成自检') as HTMLButtonElement;
  button.addEventListener('click', async () => {
    button.disabled = true;
    result.replaceChildren();
    try {
      const report = await runSyntheticSelfTest(data, (msg) => { progress.textContent = msg; });
      progress.textContent = '自检完成。';
      result.append(renderReport(report));
    } finally {
      button.disabled = false;
    }
  });
  return h('div', { class: 'panel selftest-card' },
    h('h3', null, '合成录音指标'),
    h('p', { class: 'muted' }, '与 Node 验证脚本共用同一套合成器、AudioWorklet 检测核心和标定推断。'),
    button,
    progress,
    result,
  );
}

function renderReport(r: SelfTestReport): HTMLElement {
  const rows: Array<[string, string, boolean]> = [
    ['起始检出率', `${r.onsetRecallPct.toFixed(2)}%（≥98）`, r.onsetRecallPct >= 98],
    ['温度平均误差', `${r.tempMaeC.toFixed(1)}°C`, r.tempMaeC <= 40],
    ['温度 P95 误差', `${r.tempP95C.toFixed(1)}°C（≤40）`, r.tempP95C <= 40],
    ['≤40°C 占比', `${r.tempWithin40Pct.toFixed(1)}%`, r.tempWithin40Pct >= 95],
    ['暗裂检出率', `${r.crackRecallPct.toFixed(1)}%（≥85）`, r.crackRecallPct >= 85],
    ['暗裂误报率', `${r.crackFalsePositivePct.toFixed(2)}%（≤5）`, r.crackFalsePositivePct <= 5],
    ['算法窗口延迟 P95', `${r.latencyMs.toFixed(1)}ms（预算 <100）`, r.latencyMs < 65],
  ];
  return h('div', null,
    h('div', { class: `report-banner ${r.passed ? 'pass' : 'fail'}` }, r.passed ? '指标通过' : '有指标未通过'),
    h('div', { class: 'report-grid' }, ...rows.map(([k, v, ok]) =>
      h('div', { class: `report-row ${ok ? 'ok' : 'bad'}` }, h('span', null, k), h('strong', null, v)),
    )),
    h('p', { class: 'muted' }, `共 ${r.total} 个合成目标锤击；最大温度误差 ${r.tempMaxC.toFixed(0)}°C。`),
  );
}

function renderSynthAudition(steelId: string, sizeId: string): HTMLElement {
  const clean = h('button', { class: 'btn btn-ghost' }, '试听热坯') as HTMLButtonElement;
  const crack = h('button', { class: 'btn btn-ghost danger' }, '试听暗裂') as HTMLButtonElement;
  const status = h('p', { class: 'muted' }, '合成声包含锤头瞬态、砧子固定共振和坯料模态。');

  async function play(cracked: boolean): Promise<void> {
    const data = store.data;
    const steel = data.steels.find((s) => s.id === steelId)!;
    const size = data.sizes.find((s) => s.id === sizeId)!;
    const { samples } = synthesizeStrike({ steel, size, tempC: 880, crack: cracked, seed: (Date.now() >>> 0) % 100000 });
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctor();
    const buffer = ctx.createBuffer(1, samples.length, 48000);
    buffer.getChannelData(0).set(samples);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start();
    status.textContent = `正在播放：${profileLabel(data.settings.profileKey, data.steels, data.sizes)} / ${cracked ? '频率分裂' : '正常'}`;
    source.onended = () => void ctx.close();
  }
  clean.addEventListener('click', () => void play(false));
  crack.addEventListener('click', () => void play(true));

  return h('div', { class: 'panel' },
    h('h3', null, '合成锤声试听'),
    h('div', { class: 'button-row' }, clean, crack),
    status,
  );
}

function label(text: string, input: HTMLElement): HTMLElement {
  return h('label', { class: 'field' }, h('span', null, text), input);
}

function infoRow(k: string, v: string): HTMLElement {
  return h('div', { class: 'info-row' }, h('span', null, k), h('strong', null, v));
}

function parseNumberList(text: string): number[] {
  return text.split(/[\s,，;；]+/).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0);
}
