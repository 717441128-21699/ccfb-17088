// 温度曲线页：基于有效锤击记录绘制温度、基频 f1、衰减 tau 随锤次的变化，
// 温度图叠加回炉阈值参考线。
import { REHEAT_TEMPERATURE_C } from '../../dsp/temperature.ts';
import { store } from '../../state/store.ts';
import { drawChart } from '../chart.ts';
import { el } from '../dom.ts';

export function renderTemperaturePage(container: HTMLElement): void {
  container.replaceChildren();
  const records = store.getState().records.filter((r) => !r.ignored && r.f1 > 0);

  const tempCanvas = el('canvas', { className: 'chart' }) as HTMLCanvasElement;
  const f1Canvas = el('canvas', { className: 'chart' }) as HTMLCanvasElement;
  const tauCanvas = el('canvas', { className: 'chart' }) as HTMLCanvasElement;

  const summary = el('div', { className: 'grid cols-3' });

  if (records.length === 0) {
    container.append(el('div', { className: 'card empty' },
      '尚无有效锤击数据。请先在「实时监听」页采集，或播放合成演示。'));
    return;
  }

  const indexed = records.map((r, i) => ({ ...r, idx: i + 1 }));
  const tempPoints = indexed
    .filter((r) => r.temperatureC != null)
    .map((r) => ({ x: r.idx, y: r.temperatureC as number }));
  const f1Points = indexed.map((r) => ({ x: r.idx, y: r.f1 }));
  const tauPoints = indexed.map((r) => ({ x: r.idx, y: r.tau1 * 1000 }));

  drawChart(tempCanvas, [
    { label: '估算温度 °C', color: '#e8862d', points: tempPoints },
  ], {
    yLabel: '温度 °C',
    xLabel: '锤次',
    referenceLines: [{ y: REHEAT_TEMPERATURE_C, color: '#e0492f', label: `回炉线 ${REHEAT_TEMPERATURE_C}°C` }],
  });

  drawChart(f1Canvas, [
    { label: '基频 f1 Hz', color: '#5aa9e6', points: f1Points },
  ], { yLabel: 'Hz', xLabel: '锤次' });

  drawChart(tauCanvas, [
    { label: '衰减时间常数 ms', color: '#6fbf6f', points: tauPoints },
  ], { yLabel: 'ms', xLabel: '锤次' });

  const temps = tempPoints.map((p) => p.y);
  const latest = indexed[indexed.length - 1];
  summary.append(
    summaryCard('最新温度', latest.temperatureC != null ? `${latest.temperatureC}°C` : '—'),
    summaryCard('温度区间', temps.length ? `${Math.min(...temps)} ~ ${Math.max(...temps)}°C` : '—'),
    summaryCard('有效锤数', `${records.length} 锤`),
  );

  container.append(
    summary,
    el('div', { className: 'card', style: 'margin-top:16px' },
      el('h2', {}, '温度随锤次变化'), tempCanvas),
    el('div', { className: 'grid cols-2', style: 'margin-top:16px' },
      el('div', { className: 'card' }, el('h2', {}, '坯料基频 f1（越低越热）'), f1Canvas),
      el('div', { className: 'card' }, el('h2', {}, '衰减时间常数 tau（越短越热）'), tauCanvas),
    ),
  );
}

function summaryCard(label: string, value: string): HTMLElement {
  return el('div', { className: 'card' },
    el('div', { className: 'metric' },
      el('span', { className: 'label' }, label),
      el('span', { className: 'value', style: 'font-size:20px' }, value)),
  );
}
