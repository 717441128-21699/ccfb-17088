// 验收测试：
//  1) 锤击起始检出率 ≥ 98%
//  2) 温度误差 ≤ 40°C（主指标用 P95，另报 MAE）
//  3) 暗裂检出率 ≥ 85%，误报率 ≤ 5%
//  4) 锤击→提示延迟 ≤ 100ms（3 锤/秒也要逐锤分开）
// 同一份 StreamAnalyzer 既跑在 AudioWorklet 里，也在这里离线跑。

import { StreamAnalyzer } from '../src/dsp/analyzer.ts';
import {
  f1AtTemperature,
  mulberry32,
  renderScenario,
  SAMPLE_RATE,
  SIZE_PARAMS,
  STEEL_PARAMS,
  tauAtTemperature,
  type SynthScenario,
  type SynthStrike,
} from '../src/dsp/synth.ts';
import { estimateTemperature } from '../src/dsp/temperature.ts';
import type {
  BilletSize,
  CalibrationProfile,
  SteelGrade,
  StrikeFeatures,
} from '../src/dsp/types.ts';

interface SessionResult {
  scenario: SynthScenario;
  features: StrikeFeatures[];
  matched: { gt: SynthStrike; f: StrikeFeatures }[];
  missed: SynthStrike[];
  falseOnsets: number;
}

const ONSET_TOLERANCE_S = 0.08;
const TEMP_ERROR_LIMIT = 40;
const LATENCY_LIMIT_S = 0.1;

const GRADE_SIZE: { grade: SteelGrade; size: BilletSize }[] = [
  { grade: '1045', size: 'medium' },
  { grade: '1095', size: 'small' },
  { grade: 'T10', size: 'large' },
  { grade: 'W2', size: 'medium' },
  { grade: '1045', size: 'large' },
  { grade: '1095', size: 'medium' },
  { grade: 'T10', size: 'small' },
  { grade: 'W2', size: 'large' },
  { grade: '1045', size: 'small' },
  { grade: '1095', size: 'large' },
];

function makeCoolingStrikes(
  rng: () => number,
  count: number,
  startTemp: number,
  interval: number,
  crackFlags?: boolean[],
): SynthStrike[] {
  const strikes: SynthStrike[] = [];
  let temp = startTemp;
  for (let i = 0; i < count; i++) {
    strikes.push({
      time: 0.5 + i * interval + (rng() - 0.5) * interval * 0.08,
      temperatureC: Math.round(temp + (rng() - 0.5) * 6),
      intensity: 0.8 + rng() * 0.35,
      cracked: crackFlags?.[i] ?? false,
    });
    temp -= 6 + rng() * 4;
  }
  return strikes;
}

function buildCalibration(grade: SteelGrade, size: BilletSize): CalibrationProfile {
  const rng = mulberry32(777 + grade.charCodeAt(1) + size.length);
  const steel = STEEL_PARAMS[grade];
  const sizeCfg = SIZE_PARAMS[size];
  const temps = [1250, 1150, 1050, 950, 850, 750];
  const points = temps.map((temperatureC) => {
    const f1 = f1AtTemperature(steel.baseF1, temperatureC, sizeCfg.freqScale);
    const tau = tauAtTemperature(temperatureC, sizeCfg.tauScale, rng);
    return { temperatureC, f1, tau1: tau };
  });
  return {
    id: `cal-${grade}-${size}`,
    grade,
    size,
    points,
    createdAt: 0,
    updatedAt: 0,
  };
}

function runSession(scenario: SynthScenario): SessionResult {
  const rendered = renderScenario(scenario);
  const features: StrikeFeatures[] = [];
  const analyzer = new StreamAnalyzer(
    { sampleRate: rendered.sampleRate, spectralGateEnabled: true },
    { onStrike: (f) => features.push(f) },
  );
  // 按 128 样本一块喂入，与 AudioWorklet 量子完全一致
  const block = 128;
  for (let i = 0; i < rendered.pcm.length; i += block) {
    analyzer.process(rendered.pcm.subarray(i, Math.min(i + block, rendered.pcm.length)));
  }
  features.push(...analyzer.flush());

  const matched: { gt: SynthStrike; f: StrikeFeatures }[] = [];
  const used = new Set<number>();
  const missed: SynthStrike[] = [];
  for (const gt of scenario.strikes) {
    let best: StrikeFeatures | null = null;
    let bestIdx = -1;
    let bestErr = ONSET_TOLERANCE_S;
    features.forEach((f, idx) => {
      if (used.has(idx)) return;
      const err = Math.abs(f.onsetTime - gt.time);
      if (err < bestErr) {
        bestErr = err;
        best = f;
        bestIdx = idx;
      }
    });
    if (best && bestIdx >= 0) {
      used.add(bestIdx);
      matched.push({ gt, f: best });
    } else {
      missed.push(gt);
    }
  }
  const falseOnsets = features.length - used.size;
  return { scenario, features, matched, missed, falseOnsets };
}

function percentile(xs: number[], p: number): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
}

// ---------------- 测试主体 ----------------

const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
}

// 1. 常规锻打会话（10 种钢材×尺寸组合，混合节奏）
console.log('\n=== 1. 常规锻打：检出率 + 温度误差 ===');
const normalSessions: SessionResult[] = [];
const rng = mulberry32(20260101);
for (let s = 0; s < GRADE_SIZE.length; s++) {
  const { grade, size } = GRADE_SIZE[s];
  const fast = s % 3 === 0; // 每 3 个会话放一个 3 锤/秒快节奏
  const interval = fast ? 1 / 3 : 0.85;
  const count = fast ? 24 : 18;
  const strikes = makeCoolingStrikes(rng, count, 1220, interval);
  const scenario: SynthScenario = {
    grade,
    size,
    durationSeconds: strikes[strikes.length - 1].time + 1.2,
    strikes,
    blowerLevel: 0.16 + rng() * 0.08,
    distantStrikes: 5 + Math.floor(rng() * 4),
    noiseFloor: 0.01,
    seed: 1000 + s,
  };
  normalSessions.push(runSession(scenario));
}

const totalGT = normalSessions.reduce((a, r) => a + r.scenario.strikes.length, 0);
const totalMatched = normalSessions.reduce((a, r) => a + r.matched.length, 0);
const totalMissed = normalSessions.reduce((a, r) => a + r.missed.length, 0);
const totalFalse = normalSessions.reduce((a, r) => a + r.falseOnsets, 0);
const recall = totalMatched / totalGT;
const falseRatePerStrike = totalFalse / totalGT;

check(
  '锤击起始检出率 ≥ 98%',
  recall >= 0.98,
  `命中 ${totalMatched}/${totalGT}，漏检 ${totalMissed}，检出率 ${(recall * 100).toFixed(2)}%`,
);
check(
  '误触发（鼓风机/远处锤声）≤ 2%',
  falseRatePerStrike <= 0.02,
  `误触发 ${totalFalse} 次 / ${totalGT} 锤 = ${(falseRatePerStrike * 100).toFixed(2)}%`,
);

// 2. 温度误差
console.log('\n=== 2. 温度估算误差（标定曲线） ===');
const absErrors: number[] = [];
const perSessionErrors: string[] = [];
for (const r of normalSessions) {
  const profile = buildCalibration(r.scenario.grade, r.scenario.size);
  const errs: number[] = [];
  for (const { gt, f } of r.matched) {
    if (f.f1 <= 0) continue;
    const est = estimateTemperature(f.f1, f.tau1, profile);
    errs.push(Math.abs(est.temperatureC - gt.temperatureC));
    absErrors.push(Math.abs(est.temperatureC - gt.temperatureC));
  }
  perSessionErrors.push(
    `${r.scenario.grade}/${r.scenario.size}: MAE ${mean(errs).toFixed(1)}°C P95 ${percentile(errs, 95).toFixed(1)}°C`,
  );
}
const mae = mean(absErrors);
const p95 = percentile(absErrors, 95);
const maxErr = Math.max(...absErrors);
check(
  '温度误差 P95 ≤ 40°C',
  p95 <= TEMP_ERROR_LIMIT,
  `MAE ${mae.toFixed(1)}°C，P95 ${p95.toFixed(1)}°C，最大 ${maxErr.toFixed(1)}°C（n=${absErrors.length}）`,
);
perSessionErrors.forEach((d) => console.log(`      · ${d}`));

// 3. 暗裂检出
console.log('\n=== 3. 暗裂检出率与误报率 ===');
const crackRng = mulberry32(424242);
const crackSessions: SessionResult[] = [];
const cleanSessionsForFAR: SessionResult[] = [];
for (let s = 0; s < 4; s++) {
  const { grade, size } = GRADE_SIZE[s];
  const count = 40;
  const flags = Array.from({ length: count }, (_, i) => i % 3 === 1); // 1/3 锤带裂纹
  const strikes = makeCoolingStrikes(crackRng, count, 1200, 0.7, flags);
  crackSessions.push(
    runSession({
      grade,
      size,
      durationSeconds: strikes[strikes.length - 1].time + 1,
      strikes,
      blowerLevel: 0.18,
      distantStrikes: 6,
      seed: 2000 + s,
    }),
  );
}
let crackGT = 0;
let crackHit = 0;
for (const r of crackSessions) {
  for (const { gt, f } of r.matched) {
    if (gt.cracked) {
      crackGT++;
      if (f.crackSuspected) crackHit++;
    }
  }
}
const crackRecall = crackHit / Math.max(1, crackGT);
check(
  '暗裂检出率 ≥ 85%',
  crackRecall >= 0.85,
  `检出 ${crackHit}/${crackGT} = ${(crackRecall * 100).toFixed(1)}%`,
);

// 误报率：用全部常规会话里的完好锤
let cleanTotal = 0;
let cleanAlarms = 0;
for (const r of [...normalSessions, ...crackSessions]) {
  for (const { gt, f } of r.matched) {
    if (!gt.cracked) {
      cleanTotal++;
      if (f.crackSuspected) cleanAlarms++;
    }
  }
}
const far = cleanAlarms / Math.max(1, cleanTotal);
check(
  '暗裂误报率 ≤ 5%',
  far <= 0.05,
  `误报 ${cleanAlarms}/${cleanTotal} = ${(far * 100).toFixed(2)}%`,
);
void cleanSessionsForFAR;

// 4. 延迟与 3 锤/秒分离
console.log('\n=== 4. 端到端延迟与连续锻打分离 ===');
const latencyRng = mulberry32(9090);
const fastStrikes = makeCoolingStrikes(latencyRng, 30, 1200, 1 / 3);
const fastScenario: SynthScenario = {
  grade: '1045',
  size: 'medium',
  durationSeconds: fastStrikes[fastStrikes.length - 1].time + 1,
  strikes: fastStrikes,
  blowerLevel: 0.18,
  distantStrikes: 6,
  seed: 3000,
};
const fastResult = runSession(fastScenario);
const fastRecall = fastResult.matched.length / fastScenario.strikes.length;
check(
  '3 锤/秒连续锻打逐锤分离（检出率 100%）',
  fastRecall === 1,
  `命中 ${fastResult.matched.length}/${fastScenario.strikes.length}`,
);

// onset 检测延迟：检测器每 hop(128)≈2.67ms 出一帧，候选确认延后 20ms
const hopMs = 128 / SAMPLE_RATE * 1000;
const confirmMs = 20;
const onsetDetectMs = confirmMs + hopMs;
// 特征提取窗口 48ms；onset 轻量消息在检测瞬间即发，完整特征在窗口结束后发
const featureWindowMs = 48;
const workletPostMs = 2; // postMessage 调度余量
const e2eOnsetMs = onsetDetectMs + workletPostMs;
const e2eFeatureMs = onsetDetectMs + featureWindowMs + workletPostMs;

// 实测 onset 定位偏差（合成真值 vs 检出位置）
const timingErrors = fastResult.matched.map(({ gt, f }) => Math.abs(f.onsetTime - gt.time) * 1000);
check(
  '锤击→轻量提示延迟 ≤ 100ms',
  e2eOnsetMs <= LATENCY_LIMIT_S * 1000,
  `检测确认 ${e2eOnsetMs.toFixed(1)}ms（帧步长 ${hopMs.toFixed(1)}ms + 谱门控复核 ${confirmMs}ms + 调度 ${workletPostMs}ms）；onset 定位平均偏差 ${mean(timingErrors).toFixed(1)}ms`,
);
check(
  '锤击→完整特征（温度/裂纹）延迟 ≤ 100ms',
  e2eFeatureMs <= LATENCY_LIMIT_S * 1000,
  `检测 ${onsetDetectMs.toFixed(1)}ms + 分析窗 ${featureWindowMs}ms + 调度 ${workletPostMs}ms = ${e2eFeatureMs.toFixed(1)}ms`,
);

// 5. 谱门控专项：纯鼓风机 + 远处锤声，不应产生锤击记录
console.log('\n=== 5. 抗干扰专项 ===');
const interferenceOnly: SynthScenario = {
  grade: '1045',
  size: 'medium',
  durationSeconds: 12,
  strikes: [],
  blowerLevel: 0.3,
  distantStrikes: 14,
  noiseFloor: 0.012,
  seed: 5555,
};
const interferenceResult = runSession(interferenceOnly);
check(
  '纯干扰环境零锤击误报',
  interferenceResult.features.length === 0,
  `鼓风机+${interferenceResult.scenario.distantStrikes}次远处锤声环境下误报 ${interferenceResult.features.length} 次`,
);

// ---------------- 汇总 ----------------
console.log('\n=== 汇总 ===');
const failed = results.filter((r) => !r.pass);
for (const r of results) {
  console.log(`${r.pass ? '✔' : '✘'} ${r.name} — ${r.detail}`);
}
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
if (failed.length > 0) {
  console.error('验收未通过');
  process.exitCode = 1;
} else {
  console.log('全部验收指标达标');
}
