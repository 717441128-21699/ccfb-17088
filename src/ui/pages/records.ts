// 锤击记录页：全量锤击表格，支持只看异常/忽略项、CSV 导出、清空。
import type { StrikeRecord } from '../../dsp/types.ts';
import { store } from '../../state/store.ts';
import { el, tempClass } from '../dom.ts';

type Filter = 'all' | 'crack' | 'ignored';

export function renderRecordsPage(container: HTMLElement): void {
  container.replaceChildren();
  let filter: Filter = 'all';

  const body = el('tbody');
  const countText = el('span', { className: 'muted' }, '');

  function render(): void {
    const all = store.getState().records;
    let rows = all;
    if (filter === 'crack') rows = all.filter((r) => r.crackSuspected);
    if (filter === 'ignored') rows = all.filter((r) => r.ignored);
    const shown = rows.slice().reverse();
    body.replaceChildren();
    countText.textContent = `共 ${all.length} 条，显示 ${shown.length} 条`;
    if (shown.length === 0) {
      body.append(el('tr', {}, el('td', { colSpan: '9', className: 'empty' }, '没有符合条件的记录')));
      return;
    }
    for (const r of shown) body.append(row(r));
  }

  function row(r: StrikeRecord): HTMLTableRowElement {
    const tr = el('tr', { className: r.ignored ? 'ignored' : r.crackSuspected ? 'crack' : '' });
    tr.append(
      el('td', {}, new Date(r.wallClock).toLocaleTimeString('zh-CN', { hour12: false })),
      el('td', {}, r.onsetTime.toFixed(2)),
      el('td', { className: tempClass(r.temperatureC) }, r.temperatureC?.toString() ?? '—'),
      el('td', {}, r.f1 ? r.f1.toFixed(1) : '—'),
      el('td', {}, r.tau1 ? (r.tau1 * 1000).toFixed(1) : '—'),
      el('td', {}, r.rmsPeak ? r.rmsPeak.toFixed(3) : '—'),
      el('td', {}, r.remainingStrikes?.toString() ?? '—'),
      el('td', {}, statusBadge(r)),
      el('td', { className: 'muted' }, r.ignored ? (r.ignoreReason ?? '谱门控排除') : `${(r.crackScore * 100).toFixed(0)}%`),
    );
    return tr;
  }

  function statusBadge(r: StrikeRecord): HTMLElement {
    if (r.ignored) return el('span', { className: 'badge muted' }, '已排除');
    if (r.crackSuspected) return el('span', { className: 'badge danger' }, '疑似暗裂');
    return el('span', { className: 'badge ok' }, '正常');
  }

  const filterGroup = el('div', { className: 'pill-group' });
  const filters: { id: Filter; label: string }[] = [
    { id: 'all', label: '全部' },
    { id: 'crack', label: '仅异常' },
    { id: 'ignored', label: '仅排除' },
  ];
  for (const f of filters) {
    const btn = el('button', { className: f.id === filter ? 'active' : '' }, f.label);
    btn.addEventListener('click', () => {
      filter = f.id;
      filterGroup.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      render();
    });
    filterGroup.append(btn);
  }

  const exportBtn = el('button', {}, '导出 CSV');
  exportBtn.addEventListener('click', () => exportCsv(store.getState().records));
  const clearBtn = el('button', { className: 'danger' }, '清空记录');
  clearBtn.addEventListener('click', () => {
    if (window.confirm('确定清空全部锤击记录？此操作不可恢复。')) {
      store.clearRecords();
      render();
    }
  });

  const table = el('table', {},
    el('thead', {}, el('tr', {},
      el('th', {}, '时钟'), el('th', {}, '流时间 s'), el('th', {}, '温度 °C'),
      el('th', {}, 'f1 Hz'), el('th', {}, 'tau ms'), el('th', {}, '峰值RMS'),
      el('th', {}, '剩余锤'), el('th', {}, '状态'), el('th', {}, '裂纹评分/原因'))),
    body,
  );

  const card = el('div', { className: 'card' },
    el('div', { className: 'row' },
      el('h2', { style: 'margin:0' }, '锤击记录'),
      el('div', { className: 'spacer' }), countText),
    el('div', { className: 'row', style: 'margin:12px 0' },
      filterGroup, el('div', { className: 'spacer' }), exportBtn, clearBtn),
    el('div', { className: 'table-wrap' }, table),
  );
  container.append(card);
  render();
}

function exportCsv(records: StrikeRecord[]): void {
  const header = [
    '时钟', '流时间s', '温度C', 'f1Hz', 'tau_ms', '峰值RMS',
    '剩余锤数', '疑似暗裂', '频率分裂', '不规则衰减', '裂纹评分', '已排除', '排除原因',
  ];
  const lines = [header.join(',')];
  for (const r of records) {
    lines.push([
      new Date(r.wallClock).toISOString(),
      r.onsetTime.toFixed(3),
      r.temperatureC ?? '',
      r.f1.toFixed(2),
      (r.tau1 * 1000).toFixed(2),
      r.rmsPeak.toFixed(4),
      r.remainingStrikes ?? '',
      r.crackSuspected ? 1 : 0,
      r.splitDetected ? 1 : 0,
      r.irregularDecay ? 1 : 0,
      r.crackScore.toFixed(3),
      r.ignored ? 1 : 0,
      `"${r.ignoreReason ?? ''}"`,
    ].join(','));
  }
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `forge-records-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
