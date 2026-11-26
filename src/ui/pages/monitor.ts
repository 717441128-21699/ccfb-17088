import { AudioEngine } from '../../audio/AudioEngine';
import { store } from '../../state/store';
import type { AppData, StrikeRecord } from '../../core/types';
import { fmtHz, fmtTime, h } from '../dom';
import { VERDICT_META, profileLabel } from '../labels';
import type { PageContext, PageHandle } from './types';

export function renderMonitor({ engine, refresh }: PageContext): PageHandle {
  const data = store.data;
  const root = h('section', { class: 'page monitor-page' });

  const validStrike = data.strikes.find((s) => s.verdict !== 'rejected');
  const rejectedCount = data.strikes.filter((s) => s.verdict === 'rejected').length;

  const hero = renderHero(validStrike);
  const controls = renderControls({ engine, refresh });
  const visual = renderVisualizer(engine);
  const side = h('div', { class: 'monitor-side' }, controls, visual.card, renderRecent(data.strikes.slice(0, 7), rejectedCount, data));

  root.append(
    h('div', { class: 'monitor-grid' }, h('div', { class: 'monitor-main' }, hero, renderMetricChips(validStrike)), side),
  );

  return {
    root,
    cleanup: visual.cleanup,
  };
}

function renderHero(strike?: StrikeRecord): HTMLElement {
  if (!strike) {
    return h('div', { class: 'hero-card idle' },
      h('div', { class: 'hero-kicker' }, 'AUDIO WORKLET · 低延迟模态分析'),
      h('h2', { class: 'hero-title' }, '开始监听后，打第一锤'),
      h('p', { class: 'hero-advice' }, '麦克风应靠近砧子，避开鼓风机直吹。系统会在 AudioWorklet 内完成起始检出、频谱峰提取和衰减拟合。'),
      h('div', { class: 'hero-badges' },
        h('span', { class: 'badge' }, '目标延迟 < 100 ms'),
        h('span', { class: 'badge' }, '3 锤/秒可分开'),
        h('span', { class: 'badge' }, '鼓风机/邻锤抑制'),
      ),
    );
  }

  const meta = VERDICT_META[strike.verdict];
  const blows = strike.blowsRemaining;
  const blowText =
    strike.verdict === 'crack'
      ? '停锤检查'
      : strike.verdict === 'cold'
        ? '0 锤 · 回炉'
        : blows === undefined
          ? '—'
          : blows <= 2
            ? `${blows} 锤 · 准备回炉`
            : `约 ${blows} 锤`;

  return h('div', { class: `hero-card verdict-${strike.verdict}`, dataset: { strikeId: strike.id } },
    h('div', { class: 'hero-top' },
      h('div', null,
        h('div', { class: 'hero-kicker' }, `${fmtTime(strike.at)} · ${strike.source === 'live' ? '实时锤击' : '合成事件'}`),
        h('h2', { class: 'hero-title' }, meta.label),
      ),
      h('div', { class: 'latency-pill', title: '从检出窗口到界面提示的算法延迟' },
        h('strong', null, `${Math.round(strike.onsetLatencyMs)} ms`),
        h('span', null, '提示延迟'),
      ),
    ),
    h('div', { class: 'hero-values' },
      h('div', { class: 'hero-temp' },
        h('span', { class: 'value-label' }, '坯料温度'),
        h('strong', null, strike.tempC === undefined ? '—' : `${Math.round(strike.tempC)}`),
        h('em', null, strike.tempC === undefined ? '' : '°C'),
      ),
      h('div', { class: 'hero-blows' },
        h('span', { class: 'value-label' }, '还能打'),
        h('strong', { class: strike.verdict === 'crack' || strike.verdict === 'cold' ? 'danger-text' : '' }, blowText),
      ),
      h('div', { class: 'hero-confidence' },
        h('span', { class: 'value-label' }, '标定置信度'),
        h('strong', null, `${Math.round((strike.tempConfidence ?? 0) * 100)}%`),
        h('div', { class: 'confidence-track' }, h('i', { style: { width: `${Math.round((strike.tempConfidence ?? 0) * 100)}%` } })),
      ),
    ),
    h('p', { class: 'hero-advice' }, meta.advice),
  );
}

function renderMetricChips(strike?: StrikeRecord): HTMLElement {
  const modes = strike?.matchedModeHz?.length ? strike.matchedModeHz : strike?.modes.slice(0, 3).map((m) => m.hz);
  return h('div', { class: 'chip-grid' },
    metric('坯料模态', modes?.length ? modes.map(fmtHz).join(' / ') : '等待信号'),
    metric('衰减 τ', strike?.tauMs?.length ? strike.tauMs.slice(0, 3).map((v) => `${Math.round(v)} ms`).join(' / ') : '—'),
    metric('裂峰分数', strike ? `${strike.crackScore.toFixed(2)}${strike.crackDetected ? ' · 触发' : ''}` : '—', strike?.crackDetected ? 'chip-danger' : ''),
    metric('峰值/RMS', strike ? `${strike.peakLevel.toFixed(2)} / ${strike.rmsLevel.toFixed(3)}` : '—'),
  );
}

function metric(label: string, value: string, extraClass = ''): HTMLElement {
  return h('div', { class: `metric-chip ${extraClass}` },
    h('span', null, label),
    h('strong', null, value),
  );
}

function renderControls({ engine, refresh }: PageContext): HTMLElement {
  const settings = store.data.settings;
  const profileOptions = store.data.steels.flatMap((steel) =>
    store.data.sizes.map((size) => {
      const key = `${steel.id}::${size.id}`;
      return h('option', { attrs: { value: key, selected: key === settings.profileKey } }, `${steel.name} · ${size.label}`);
    }),
  );

  const profileSelect = h('select', {
    class: 'input',
    on: { change: () => store.updateSettings({ profileKey: (profileSelect as HTMLSelectElement).value }) },
  }, ...profileOptions) as HTMLSelectElement;

  const micSelect = h('select', { class: 'input' }, h('option', { attrs: { value: '' } }, '默认麦克风')) as HTMLSelectElement;
  AudioEngine.listDevices()
    .then((devices) => {
      for (const d of devices) {
        micSelect.append(h('option', { attrs: { value: d.deviceId, selected: d.deviceId === settings.selectedMicId } }, d.label || `麦克风 ${d.deviceId.slice(0, 6)}`));
      }
    })
    .catch(() => undefined);
  micSelect.addEventListener('change', () => store.updateSettings({ selectedMicId: micSelect.value || undefined }));

  const status = h('div', { class: `engine-status ${engine.running ? 'on' : ''}` },
    h('i'), engine.running ? '监听中 · AudioWorklet 运行' : '未开始监听');
  const errorBox = h('div', { class: 'form-error', attrs: { role: 'alert' } });

  const startButton = h('button', { class: `btn ${engine.running ? 'btn-danger' : 'btn-primary'} btn-large` },
    engine.running ? '停止监听' : '开始实时监听') as HTMLButtonElement;
  startButton.addEventListener('click', async () => {
    startButton.disabled = true;
    errorBox.textContent = '';
    try {
      if (engine.running) {
        await engine.stop();
      } else {
        await engine.start(settings.selectedMicId, settings.thresholdDb);
        engine.setGain(settings.inputGain);
      }
      refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errorBox.textContent = `无法启动音频：${message}`;
      startButton.disabled = false;
    }
  });

  const thresholdValue = h('output', null, `${settings.thresholdDb} dB`);
  const threshold = h('input', {
    class: 'range',
    attrs: { type: 'range', min: '-52', max: '-18', step: '1', value: String(settings.thresholdDb) },
    on: {
      input: () => {
        const v = Number((threshold as HTMLInputElement).value);
        thresholdValue.textContent = `${v} dB`;
        engine.setThreshold(v);
      },
      change: () => store.updateSettings({ thresholdDb: Number((threshold as HTMLInputElement).value) }),
    },
  }) as HTMLInputElement;

  const gainValue = h('output', null, `${settings.inputGain.toFixed(2)}×`);
  const gain = h('input', {
    class: 'range',
    attrs: { type: 'range', min: '0.6', max: '2', step: '0.05', value: String(settings.inputGain) },
    on: {
      input: () => {
        const v = Number((gain as HTMLInputElement).value);
        gainValue.textContent = `${v.toFixed(2)}×`;
        engine.setGain(v);
      },
      change: () => store.updateSettings({ inputGain: Number((gain as HTMLInputElement).value) }),
    },
  }) as HTMLInputElement;

  const blowerToggle = h('input', {
    attrs: { type: 'checkbox', checked: settings.blowerSuppression ? true : undefined },
    on: { change: () => store.updateSettings({ blowerSuppression: (blowerToggle as HTMLInputElement).checked }) },
  }) as HTMLInputElement;
  const rejectToggle = h('input', {
    attrs: { type: 'checkbox', checked: settings.rejectOtherHammers ? true : undefined },
    on: { change: () => store.updateSettings({ rejectOtherHammers: (rejectToggle as HTMLInputElement).checked }) },
  }) as HTMLInputElement;

  return h('div', { class: 'panel control-panel' },
    h('div', { class: 'panel-title-row' }, h('h3', null, '监听设置'), status),
    label('钢材 / 坯料标定', profileSelect),
    label('输入设备', micSelect),
    startButton,
    errorBox,
    h('div', { class: 'range-row' }, h('div', null, h('span', null, '起始阈值'), thresholdValue), threshold),
    h('div', { class: 'range-row' }, h('div', null, h('span', null, '输入增益'), gainValue), gain),
    h('label', { class: 'check-row' }, blowerToggle, h('span', null, '鼓风机低频抑制')),
    h('label', { class: 'check-row' }, rejectToggle, h('span', null, '排除他人锤声 / 非标定模态')),
  );
}

function label(text: string, input: HTMLElement): HTMLElement {
  return h('label', { class: 'field' }, h('span', null, text), input);
}

function renderVisualizer(engine: AudioEngine): { card: HTMLElement; cleanup: () => void } {
  const canvas = h('canvas', { class: 'visualizer-canvas', attrs: { width: '640', height: '190' } }) as HTMLCanvasElement;
  const meterFill = h('i') as HTMLElement;
  const meter = h('div', { class: 'level-meter' }, meterFill);
  const card = h('div', { class: 'panel visual-panel' },
    h('div', { class: 'panel-title-row' }, h('h3', null, '实时频谱 / 电平'), h('span', { class: 'muted' }, '仅可视化使用 Analyser，检测仍在 Worklet')),
    canvas,
    meter,
  );

  const ctx = canvas.getContext('2d');
  let raf = 0;
  const draw = (): void => {
    raf = requestAnimationFrame(draw);
    if (!ctx) return;
    const w = canvas.width;
    const hgt = canvas.height;
    ctx.clearRect(0, 0, w, hgt);
    const styles = getComputedStyle(document.documentElement);
    const grid = styles.getPropertyValue('--line').trim() || 'rgba(255,255,255,.1)';
    const accent = styles.getPropertyValue('--accent').trim() || '#f59e0b';
    const cyan = styles.getPropertyValue('--cyan').trim() || '#38bdf8';

    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    for (let y = 30; y < hgt; y += 32) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    const analyser = engine.analyser;
    if (!analyser) {
      ctx.fillStyle = 'rgba(231,229,228,.45)';
      ctx.font = '16px system-ui';
      ctx.fillText('监听未启动', 24, hgt / 2);
      meterFill.style.width = '0%';
      return;
    }

    const freq = new Uint8Array(analyser.frequencyBinCount);
    const wave = new Uint8Array(analyser.fftSize);
    analyser.getByteFrequencyData(freq);
    analyser.getByteTimeDomainData(wave);

    const bars = 96;
    const step = Math.floor(freq.length / 2.4 / bars);
    const barW = w / bars;
    for (let i = 0; i < bars; i++) {
      const v = freq[i * step] / 255;
      const bh = Math.max(2, v * hgt * 0.72);
      ctx.fillStyle = i < bars * 0.28 ? accent : cyan;
      ctx.globalAlpha = 0.72;
      ctx.fillRect(i * barW + 1, hgt - bh - 18, barW - 2, bh);
    }
    ctx.globalAlpha = 1;

    ctx.beginPath();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#fde68a';
    for (let i = 0; i < wave.length; i++) {
      const x = (i / wave.length) * w;
      const y = 24 + ((wave[i] - 128) / 128) * 34;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    let sum = 0;
    for (let i = 0; i < wave.length; i++) {
      const v = (wave[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / wave.length);
    meterFill.style.width = `${Math.min(100, rms * 260)}%`;
  };
  draw();
  return { card, cleanup: () => cancelAnimationFrame(raf) };
}

function renderRecent(strikes: StrikeRecord[], rejectedCount: number, data: AppData): HTMLElement {
  return h('div', { class: 'panel recent-panel' },
    h('div', { class: 'panel-title-row' }, h('h3', null, '最近锤击'), h('span', { class: 'muted' }, `已排除 ${rejectedCount} 个非目标事件`)),
    strikes.length
      ? h('div', { class: 'recent-list' }, ...strikes.map((s) => {
          const meta = VERDICT_META[s.verdict];
          return h('div', { class: `recent-item verdict-${s.verdict}` },
            h('i', { class: 'dot', style: { background: meta.color } }),
            h('div', { class: 'recent-main' },
              h('strong', null, meta.short),
              h('span', null, profileLabel(s.profileKey ?? data.settings.profileKey, data.steels, data.sizes)),
            ),
            h('div', { class: 'recent-values' },
              h('strong', null, s.tempC === undefined ? '—' : `${Math.round(s.tempC)}°C`),
              h('span', null, `${s.matchedModeHz.length || s.modes.length} 模态 · ${Math.round(s.onsetLatencyMs)}ms`),
            ),
            h('time', null, fmtTime(s.at)),
          );
        }))
      : h('div', { class: 'empty-small' }, '还没有锤击记录。可以在标定管理页运行合成自检。'),
  );
}
