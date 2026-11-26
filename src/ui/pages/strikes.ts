import { store } from '../../state/store';
import type { StrikeRecord, StrikeVerdict } from '../../core/types';
import { downloadText, fmtHz, fmtTime, h } from '../dom';
import { VERDICT_META, profileLabel } from '../labels';
import type { PageHandle } from './types';

type Filter = 'all' | StrikeVerdict;
let filter: Filter = 'all';

export function renderStrikes(): PageHandle {
  const data = store.data;
  const filtered = data.strikes.filter((s) => filter === 'all' || s.verdict === filter);

  const filterBar = h('div', { class: 'filter-bar' },
    ...([
      ['all', `全部 ${data.strikes.length}`],
      ['good', '可打'],
      ['cooling', '偏少'],
      ['cold', '过冷'],
      ['crack', '暗裂'],
      ['rejected', '已排除'],
    ] as Array<[Filter, string]>).map(([id, label]) =>
      h('button', {
        class: `chip-filter ${filter === id ? 'active' : ''}`,
        on: { click: () => { filter = id; rerenderExternal(); } },
      }, label),
    ),
    h('div', { class: 'spacer' }),
    h('button', { class: 'btn btn-ghost', on: { click: exportCsv } }, '导出 CSV'),
    h('button', { class: 'btn btn-ghost', on: { click: exportJson } }, '导出 JSON'),
    h('button', {
      class: 'btn btn-danger-ghost',
      on: {
        click: () => {
          if (window.confirm('确定清空全部锤击记录？标定数据不会删除。')) store.clearStrikes();
        },
      },
    }, '清空'),
  );

  const rows = filtered.length
    ? h('div', { class: 'table-wrap' },
        h('table', { class: 'data-table strike-table' },
          h('thead', null, h('tr', null,
            h('th', null, '时间'), h('th', null, '判定'), h('th', null, '温度'),
            h('th', null, '可打锤数'), h('th', null, '模态 / 衰减'), h('th', null, '裂峰'),
            h('th', null, '延迟'), h('th', null, ''),
          )),
          h('tbody', null, ...filtered.map(renderRow)),
        ),
      )
    : h('div', { class: 'panel empty-state' },
        h('h3', null, '没有符合条件的锤击记录'),
        h('p', null, '启动实时监听，或到标定管理页运行合成自检。'),
      );

  return {
    root: h('section', { class: 'page strikes-page' },
      h('div', { class: 'page-header' },
        h('div', null, h('h2', null, '锤击记录'), h('p', null, '每一锤的起始时间、模态频率、衰减常数、温度推断和裂纹分数。')),
      ),
      filterBar,
      rows,
    ),
  };
}

function rerenderExternal(): void {
  // The global store subscription is the render path. A filter-only change
  // needs an explicit window event consumed by main.
  window.dispatchEvent(new CustomEvent('smith-ear:refresh'));
}

function renderRow(s: StrikeRecord): HTMLElement {
  const meta = VERDICT_META[s.verdict];
  const detail = h('tr', { class: 'detail-row', attrs: { hidden: true } },
    h('td', { attrs: { colSpan: '8' } }, renderDetail(s)),
  ) as HTMLTableRowElement;

  const mainRow = h('tr', { class: `strike-row verdict-${s.verdict}` },
    h('td', null, fmtTime(s.at)),
    h('td', null, h('span', { class: 'verdict-pill', style: { color: meta.color, borderColor: meta.color } }, meta.short)),
    h('td', { class: 'num' }, s.tempC === undefined ? '—' : `${Math.round(s.tempC)}°C`),
    h('td', { class: 'num' }, s.blowsRemaining ?? '—'),
    h('td', null, `${s.matchedModeHz.length} 个匹配 / ${s.modes.length} 峰`),
    h('td', { class: 'num' }, h('span', { class: s.crackDetected ? 'danger-text strong' : '' }, s.crackScore.toFixed(2))),
    h('td', { class: 'num' }, `${Math.round(s.onsetLatencyMs)}ms`),
    h('td', null,
      h('div', { class: 'row-actions' },
        h('button', {
          class: 'icon-btn',
          title: '详情',
          on: { click: () => { detail.hidden = !detail.hidden; } },
        }, '⌄'),
        h('button', {
          class: 'icon-btn danger',
          title: '删除',
          on: { click: () => store.deleteStrike(s.id) },
        }, '×'),
      ),
    ),
  );

  const fragment = document.createDocumentFragment();
  fragment.append(mainRow, detail);
  return fragment as unknown as HTMLElement;
}

function renderDetail(s: StrikeRecord): HTMLElement {
  const data = store.data;
  return h('div', { class: 'strike-detail', id: `detail-${s.id}` },
    h('div', { class: 'detail-summary' },
      h('strong', null, profileLabel(s.profileKey ?? data.settings.profileKey, data.steels, data.sizes)),
      h('span', null, `峰值 ${s.peakLevel.toFixed(3)} · RMS ${s.rmsLevel.toFixed(4)} · 低频比 ${s.lowFrequencyEnergy.toFixed(2)}`),
      s.frequencyScale ? h('span', null, `频率缩放 ${s.frequencyScale.toFixed(4)}`) : null,
      s.dampingScale ? h('span', null, `衰减缩放 ${s.dampingScale.toFixed(4)}`) : null,
    ),
    h('div', { class: 'mode-cards' }, ...s.modes.slice(0, 8).map((m, i) =>
      h('div', { class: `mode-card ${m.split ? 'split' : ''}` },
        h('span', null, `M${i + 1}${s.matchedModeHz.some((f) => Math.abs(f - (m.split && m.splitHz ? (m.splitHz[0] + m.splitHz[1]) / 2 : m.hz)) < 3) ? ' · 匹配' : ''}`),
        h('strong', null, fmtHz(m.hz)),
        h('em', null, `τ ${Math.round(m.tauMs)} ms · R² ${m.tauR2.toFixed(2)}`),
        m.split && m.splitHz
          ? h('small', { class: 'danger-text' }, `分裂 ${m.splitHz[0].toFixed(0)}/${m.splitHz[1].toFixed(0)} Hz · ${m.splitSeparationHz?.toFixed(0)}Hz`)
          : h('small', null, `不规则度 ${m.irregularity.toFixed(2)}`),
      ),
    )),
  );
}

function exportCsv(): void {
  const rows = [
    ['id', 'at', 'verdict', 'tempC', 'confidence', 'blowsRemaining', 'crackScore', 'latencyMs', 'modesHz', 'tauMs', 'profileKey'],
    ...store.data.strikes.map((s) => [
      s.id, s.at, s.verdict, s.tempC ?? '', s.tempConfidence ?? '', s.blowsRemaining ?? '',
      s.crackScore, s.onsetLatencyMs.toFixed(1), s.matchedModeHz.join('|'), s.tauMs.map((t) => Math.round(t)).join('|'), s.profileKey ?? '',
    ]),
  ];
  const csv = rows.map((r) => r.map(csvCell).join(',')).join('\n');
  downloadText(`smith-ear-strikes-${Date.now()}.csv`, `﻿${csv}`, 'text/csv');
}

function csvCell(value: unknown): string {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportJson(): void {
  downloadText(`smith-ear-strikes-${Date.now()}.json`, JSON.stringify(store.data.strikes, null, 2), 'application/json');
}
