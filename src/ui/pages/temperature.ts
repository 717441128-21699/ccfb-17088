import { resolveProfile } from '../../core/calibration';
import { store } from '../../state/store';
import type { StrikeRecord } from '../../core/types';
import { h } from '../dom';
import type { PageHandle } from './types';

export function renderTemperature(): PageHandle {
  const data = store.data;
  const profile = resolveProfile(data.settings.profileKey, data.steels, data.sizes);
  const points = data.strikes
    .filter((s) => s.profileKey === data.settings.profileKey && typeof s.tempC === 'number' && s.verdict !== 'rejected')
    .reverse();

  const profileSelect = h('select', {
    class: 'input',
    on: { change: (e) => store.updateSettings({ profileKey: (e.currentTarget as HTMLSelectElement).value }) },
  }, ...data.steels.flatMap((steel) =>
    data.sizes.map((size) => {
      const key = `${steel.id}::${size.id}`;
      return h('option', { attrs: { value: key, selected: key === data.settings.profileKey } }, `${steel.name} · ${size.label}`);
    }),
  )) as HTMLSelectElement;

  const chart = points.length ? renderChart(points, profile?.steel.minForgingTempC ?? 720) : emptyChart();
  const stats = renderStats(points, profile?.steel.minForgingTempC ?? 720);

  return {
    root: h('section', { class: 'page temperature-page' },
      h('div', { class: 'page-header row-header' },
        h('div', null, h('h2', null, '温度曲线'), h('p', null, '由模态频率主推断、衰减常数交叉校验；红点为疑似暗裂锤。')),
        h('label', { class: 'inline-field' }, h('span', null, '标定对象'), profileSelect),
      ),
      stats,
      h('div', { class: 'panel chart-panel' }, chart),
    ),
  };
}

function renderStats(points: StrikeRecord[], threshold: number): HTMLElement {
  const last = points[points.length - 1];
  const recent = points.slice(-8);
  let ratePerBlow: number | undefined;
  if (recent.length >= 3) {
    const xs = recent.map((_, i) => i);
    const ys = recent.map((p) => p.tempC as number);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let num = 0;
    let den = 0;
    xs.forEach((x, i) => { num += (x - mx) * (ys[i] - my); den += (x - mx) ** 2; });
    if (den > 0) ratePerBlow = -num / den;
  }
  const avgErrorHint = '合成自检 MAE ≈ 5–9°C';

  return h('div', { class: 'stat-grid' },
    stat('最新推断温度', last?.tempC === undefined ? '—' : `${Math.round(last.tempC)}°C`, last?.verdict === 'cold' ? 'danger-text' : ''),
    stat('安全停锤线', `${threshold}°C`, 'warning-text'),
    stat('最近温降', ratePerBlow === undefined ? '数据不足' : `${ratePerBlow.toFixed(1)}°C/锤`, ''),
    stat('标定精度', avgErrorHint, 'muted-stat'),
  );
}

function stat(label: string, value: string, cls = ''): HTMLElement {
  return h('div', { class: `panel stat-card ${cls}` }, h('span', null, label), h('strong', null, value));
}

function emptyChart(): HTMLElement {
  return h('div', { class: 'chart-empty' },
    h('h3', null, '还没有该标定对象的温度曲线'),
    h('p', null, '打几锤后会按时间顺序绘制；也可以在标定管理页运行合成序列。'),
  );
}

function renderChart(points: StrikeRecord[], threshold: number): SVGSVGElement {
  const W = 960;
  const H = 390;
  const padL = 58;
  const padR = 24;
  const padT = 28;
  const padB = 54;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const yMin = Math.min(560, Math.floor((threshold - 90) / 20) * 20);
  const yMax = 1120;
  const x = (i: number): number => padL + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (temp: number): number => padT + plotH - ((temp - yMin) / (yMax - yMin)) * plotH;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'temp-svg');
  svg.setAttribute('role', 'img');

  const add = (tag: string, attrs: Record<string, string | number>, text?: string): SVGElement => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    if (text !== undefined) el.textContent = text;
    svg.append(el);
    return el;
  };

  for (let t = 600; t <= 1100; t += 100) {
    add('line', { x1: padL, x2: W - padR, y1: y(t), y2: y(t), class: 'svg-grid' });
    add('text', { x: padL - 10, y: y(t) + 4, 'text-anchor': 'end', class: 'svg-label' }, `${t}`);
  }

  add('line', { x1: padL, x2: W - padR, y1: y(threshold), y2: y(threshold), class: 'threshold-line' });
  add('text', { x: W - padR, y: y(threshold) - 8, 'text-anchor': 'end', class: 'threshold-label' }, `最低锻造温度 ${threshold}°C`);

  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p.tempC as number).toFixed(1)}`).join(' ');
  const area = `${path} L ${x(points.length - 1)} ${padT + plotH} L ${x(0)} ${padT + plotH} Z`;
  add('path', { d: area, class: 'temp-area' });
  add('path', { d: path, class: 'temp-line' });

  points.forEach((p, i) => {
    const cx = x(i);
    const cy = y(p.tempC as number);
    const color = p.crackDetected ? '#ef4444' : p.verdict === 'cold' ? '#dc2626' : p.verdict === 'cooling' ? '#fb923c' : '#f59e0b';
    add('circle', { cx, cy, r: p.crackDetected ? 7 : 5.5, fill: color, class: 'temp-point' });
    if (p.crackDetected) {
      add('text', { x: cx, y: cy - 13, 'text-anchor': 'middle', class: 'crack-marker' }, '!');
    }
    if (points.length <= 24 || i % Math.ceil(points.length / 12) === 0) {
      const label = new Date(p.at).toLocaleTimeString('zh-CN', { hour12: false, minute: '2-digit', second: '2-digit' });
      add('text', { x: cx, y: H - 24, 'text-anchor': 'end', transform: `rotate(-38 ${cx} ${H - 24})`, class: 'svg-label x-label' }, label);
    }
  });

  add('text', { x: 18, y: 22, class: 'svg-label' }, '°C');
  return svg;
}
