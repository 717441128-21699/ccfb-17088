// 实时监听页：麦克风/演示两种数据源，最新锤击大卡片 + 裂纹告警 + 最近锤击流。
import { AudioEngine } from '../../audio/engine.ts';
import { REHEAT_TEMPERATURE_C } from '../../dsp/temperature.ts';
import { mulberry32, type SynthScenario } from '../../dsp/synth.ts';
import type { StrikeFeatures, StrikeRecord } from '../../dsp/types.ts';
import { store } from '../../state/store.ts';
import { BILLET_SIZES, STEEL_GRADES } from '../../dsp/types.ts';
import { el, tempClass, toast } from '../dom.ts';

export function renderLivePage(container: HTMLElement): void {
  const engine = new AudioEngine({
    onOnset: () => flashOnset(),
    onStrike: (f) => handleStrike(f),
    onIgnored: (t, reason) => {
      store.addIgnored(t, reason);
    },
    onLevel: (rms) => store.setLevel(rms),
    onEnded: () => {
      store.setMonitoring(false, 'idle');
      toast('演示录音播放结束');
    },
  });

  container.replaceChildren();
  const state = store.getState();

  const levelFill = el('div', { className: 'fill' });
  const levelMeter = el('div', { className: 'level-meter' }, levelFill);

  const statusBadge = el('span', { className: 'badge muted' }, '未开始');
  const sourceText = el('span', { className: 'muted' }, '选择数据源后开始');

  const tempValue = el('span', { className: 'value muted' }, '—');
  const remainValue = el('span', { className: 'value muted' }, '—');
  const f1Value = el('span', { className: 'value' }, '—');
  const tauValue = el('span', { className: 'value' }, '—');
  const crackValue = el('span', { className: 'value' }, '正常');

  const alertBox = el('div', { className: 'alert ok' });
  const renderAlert = (record: StrikeRecord | null): void => {
    if (!record || record.ignored) {
      alertBox.className = 'alert ok';
      alertBox.replaceChildren(
        el('div', {}, el('div', { className: 'big' }, '等待锤击…'),
          el('div', { className: 'muted' }, '系统就绪，锤击发生后在此显示判断')),
      );
      return;
    }
    if (record.crackSuspected) {
      alertBox.className = 'alert danger';
      alertBox.replaceChildren(
        el('div', {},
          el('div', { className: 'big' }, '⚠ 疑似暗裂，建议停锤检查！'),
          el('div', { className: 'muted' },
            `检出频率分裂/不规则衰减，裂纹评分 ${(record.crackScore * 100).toFixed(0)}%`)),
      );
    } else if (record.remainingStrikes === 0) {
      alertBox.className = 'alert danger';
      alertBox.replaceChildren(
        el('div', {},
          el('div', { className: 'big' }, '温度已到回炉线，立即回炉！'),
          el('div', { className: 'muted' }, `当前约 ${record.temperatureC}°C，低于 ${REHEAT_TEMPERATURE_C}°C`)),
      );
    } else {
      alertBox.className = 'alert ok';
      alertBox.replaceChildren(
        el('div', {},
          el('div', { className: 'big' }, '可以继续锻打'),
          el('div', { className: 'muted' },
            `约还能打 ${record.remainingStrikes ?? '—'} 锤，温度 ${record.temperatureC ?? '—'}°C`)),
      );
    }
  };
  renderAlert(null);

  const recentBody = el('tbody');
  const recentTable = el('table', {},
    el('thead', {}, el('tr', {},
      el('th', {}, '时间'), el('th', {}, '温度°C'), el('th', {}, 'f1 Hz'),
      el('th', {}, '衰减 ms'), el('th', {}, '剩余'), el('th', {}, '状态'))),
    recentBody,
  );

  const renderRecent = (): void => {
    const records = store.getState().records.filter((r) => !r.ignored).slice(-8).reverse();
    recentBody.replaceChildren();
    if (records.length === 0) {
      recentBody.append(el('tr', {}, el('td', { colSpan: '6', className: 'empty' }, '尚无锤击记录')));
      return;
    }
    for (const r of records) {
      const tr = el('tr', { className: r.crackSuspected ? 'crack' : '' });
      tr.append(
        el('td', {}, new Date(r.wallClock).toLocaleTimeString('zh-CN', { hour12: false })),
        el('td', { className: tempClass(r.temperatureC) }, r.temperatureC?.toString() ?? '—'),
        el('td', {}, r.f1 ? r.f1.toFixed(1) : '—'),
        el('td', {}, r.tau1 ? (r.tau1 * 1000).toFixed(1) : '—'),
        el('td', {}, r.remainingStrikes?.toString() ?? '—'),
        el('td', {}, r.crackSuspected
          ? el('span', { className: 'badge danger' }, '疑似暗裂')
          : el('span', { className: 'badge ok' }, '正常')),
      );
      recentBody.append(tr);
    }
  };
  renderRecent();

  const gateToggle = el('input', { type: 'checkbox' });
  gateToggle.checked = state.gateEnabled;
  gateToggle.addEventListener('change', () => {
    store.setGate(gateToggle.checked);
    engine.setGate(gateToggle.checked);
  });

  const micBtn = el('button', { className: 'primary' }, '开始麦克风监听');
  const demoBtn = el('button', {}, '播放合成演示');
  const stopBtn = el('button', { disabled: '' }, '停止');

  const buildDemoScenario = (): SynthScenario => {
    const s = store.getState();
    const rng = mulberry32(Date.now() % 100000);
    const count = 20;
    const strikes = [];
    let temp = 1200;
    for (let i = 0; i < count; i++) {
      const cracked = i === 9 || i === 10; // 中段插两锤暗裂
      strikes.push({
        time: 0.6 + i * 0.7,
        temperatureC: Math.round(temp),
        intensity: 0.9 + rng() * 0.3,
        cracked,
      });
      temp -= 7;
    }
    return {
      grade: s.grade,
      size: s.size,
      durationSeconds: strikes[strikes.length - 1].time + 1.2,
      strikes,
      blowerLevel: 0.18,
      distantStrikes: 6,
      noiseFloor: 0.01,
      seed: Math.floor(rng() * 1e6),
    };
  };

  micBtn.addEventListener('click', async () => {
    try {
      await engine.startMic(store.getState().gateEnabled);
      store.setMonitoring(true, 'mic');
      toast('麦克风监听已启动');
    } catch (err) {
      toast(`无法访问麦克风：${(err as Error).message}。可改用合成演示。`);
    }
  });

  demoBtn.addEventListener('click', async () => {
    await engine.startDemo(buildDemoScenario(), store.getState().gateEnabled);
    store.setMonitoring(true, 'demo');
    toast('正在播放合成锻打录音');
  });

  stopBtn.addEventListener('click', () => {
    engine.stop();
    store.setMonitoring(false, 'idle');
  });

  function handleStrike(features: StrikeFeatures): void {
    const record = store.addStrike(features);
    f1Value.textContent = features.f1.toFixed(1);
    tauValue.textContent = (features.tau1 * 1000).toFixed(1);
    if (record.temperatureC != null) {
      tempValue.textContent = record.temperatureC.toString();
      tempValue.className = `value ${tempClass(record.temperatureC)}`;
    }
    remainValue.textContent = record.remainingStrikes?.toString() ?? '—';
    if (record.crackSuspected) {
      crackValue.textContent = '疑似暗裂';
      crackValue.className = 'value temp-hot';
    } else {
      crackValue.textContent = '正常';
      crackValue.className = 'value';
    }
    renderAlert(record);
    renderRecent();
  }

  function flashOnset(): void {
    statusBadge.className = 'badge ok flash';
    window.setTimeout(() => {
      statusBadge.className = store.getState().monitoring ? 'badge ok' : 'badge muted';
    }, 400);
  }

  // 订阅 store：电平表与状态
  const unsubscribe = store.subscribe((s) => {
    levelFill.style.width = `${Math.min(100, s.levelRms * 220)}%`;
    if (s.monitoring) {
      statusBadge.className = 'badge ok';
      statusBadge.textContent = s.source === 'mic' ? '麦克风监听中' : '演示播放中';
      sourceText.textContent = `${gradeLabel(s.grade)} · ${sizeLabel(s.size)}`;
      micBtn.disabled = true;
      demoBtn.disabled = true;
      stopBtn.disabled = false;
    } else {
      statusBadge.className = 'badge muted';
      statusBadge.textContent = '未开始';
      sourceText.textContent = '选择数据源后开始';
      levelFill.style.width = '0%';
      micBtn.disabled = false;
      demoBtn.disabled = false;
      stopBtn.disabled = true;
    }
  });
  // 触发一次初始按钮状态
  store.setLevel(0);

  const card = el('div', { className: 'card' });
  card.append(
    el('div', { className: 'row' },
      el('h2', { style: 'margin:0' }, '实时监听'),
      el('div', { className: 'spacer' }),
      statusBadge, sourceText),
    el('div', { className: 'row', style: 'margin-top:12px' }, micBtn, demoBtn, stopBtn,
      el('div', { className: 'spacer' }),
      el('label', { className: 'switch' }, gateToggle, '谱门控（排鼓风机/远处锤声）')),
    el('div', { style: 'margin-top:14px' }, el('div', { className: 'muted', style: 'margin-bottom:6px' }, '输入电平'), levelMeter),
    alertBox,
    el('div', { className: 'grid cols-3', style: 'margin-top:16px' },
      metricCard('估算温度', tempValue, '°C'),
      metricCard('还能打', remainValue, '锤'),
      metricCard('基频 f1', f1Value, 'Hz'),
    ),
    el('div', { className: 'grid cols-2', style: 'margin-top:16px' },
      metricCard('衰减时间常数', tauValue, 'ms'),
      metricCard('暗裂判断', crackValue, ''),
    ),
    el('h3', { style: 'margin-top:20px' }, '最近锤击'),
    el('div', { className: 'table-wrap' }, recentTable),
  );
  container.append(card);

  // 页面销毁时清理
  window.addEventListener('hashchange', function cleanup() {
    unsubscribe();
    engine.close();
    window.removeEventListener('hashchange', cleanup);
  }, { once: true });
}

function metricCard(label: string, valueEl: HTMLElement, unit: string): HTMLElement {
  return el('div', { className: 'card' },
    el('div', { className: 'metric' },
      el('span', { className: 'label' }, label),
      el('div', {}, valueEl, unit ? el('span', { className: 'unit' }, unit) : document.createTextNode('')),
    ),
  );
}

function gradeLabel(id: string): string {
  return STEEL_GRADES.find((g) => g.id === id)?.label ?? id;
}
function sizeLabel(id: string): string {
  return BILLET_SIZES.find((g) => g.id === id)?.label ?? id;
}
