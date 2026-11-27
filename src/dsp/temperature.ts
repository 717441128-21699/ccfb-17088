// 温度估算：用测温枪标定数据把 (f1, tau1) 映射到温度。
//  - 有 ≥3 个标定点：在 (f1, tau1) 二维空间做距离加权的局部线性拟合
//  - 标定点不足：使用基于弹性模量温度系数的物理兜底公式
// 另含“还能打几锤”的经验模型（回炉阈值默认 720°C）。

import type { CalibrationPoint, CalibrationProfile } from './types.ts';

export const REHEAT_TEMPERATURE_C = 720;

/** 合成器/物理兜底共用的参考参数（按 1045 中坯的典型值） */
export const FALLBACK_REF = {
  f1At800: 700,
  tauAt800: 0.022,
  f1At1200: 500,
  tauAt1200: 0.045,
};

export interface TemperatureResult {
  temperatureC: number;
  /** 估算依据：标定曲线 or 物理兜底 */
  source: 'calibration' | 'fallback' | 'none';
  /** 参与拟合的有效标定点数 */
  usedPoints: number;
}

export function estimateTemperature(
  f1: number,
  tau1: number,
  profile: CalibrationProfile | null,
): TemperatureResult {
  const points = profile?.points ?? [];
  if (f1 <= 0) return { temperatureC: 0, source: 'none', usedPoints: 0 };

  if (points.length >= 3) {
    const t = weightedLocalFit(f1, tau1, points);
    return { temperatureC: t, source: 'calibration', usedPoints: points.length };
  }
  return { temperatureC: fallbackTemperature(f1, tau1), source: 'fallback', usedPoints: 0 };
}

/**
 * 距离加权局部线性拟合：
 * x = (归一化 f1, 归一化 tau1)，目标 y = 温度。
 * 用指数核权重，离当前观测越近的标定点话语权越大。
 */
function weightedLocalFit(f1: number, tau1: number, points: CalibrationPoint[]): number {
  const fMean = avg(points.map((p) => p.f1));
  const tMean = avg(points.map((p) => p.tau1));
  const fScale = Math.max(20, std(points.map((p) => p.f1), fMean));
  const tScale = Math.max(0.002, std(points.map((p) => p.tau1), tMean));

  const weights = points.map((p) => {
    const df = (p.f1 - f1) / fScale;
    const dt = (p.tau1 - tau1) / tScale;
    return Math.exp(-0.5 * (df * df + dt * dt));
  });
  const wSum = weights.reduce((a, b) => a + b, 0);
  if (wSum <= 1e-9) return fallbackTemperature(f1, tau1);

  // 加权一元线性（以 f1 为主特征，tau 作修正），用岭回归保持稳定
  const wF = weightedMean(weights, points.map((p) => p.f1), wSum);
  const wT = weightedMean(weights, points.map((p) => p.tau1), wSum);
  const wY = weightedMean(weights, points.map((p) => p.temperatureC), wSum);

  let covFF = 0;
  let covFT = 0;
  let covTT = 0;
  let covFY = 0;
  let covTY = 0;
  for (let i = 0; i < points.length; i++) {
    const w = weights[i] / wSum;
    const df = points[i].f1 - wF;
    const dt = points[i].tau1 - wT;
    const dy = points[i].temperatureC - wY;
    covFF += w * df * df;
    covFT += w * df * dt;
    covTT += w * dt * dt;
    covFY += w * df * dy;
    covTY += w * dt * dy;
  }
  // 岭参数，防止标定点共线时矩阵奇异
  const ridge = 1e-3;
  covFF += ridge;
  covTT += ridge;
  const det = covFF * covTT - covFT * covFT;
  let bf = 0;
  let bt = 0;
  if (Math.abs(det) > 1e-12) {
    bf = (covTT * covFY - covFT * covTY) / det;
    bt = (covFF * covTY - covFT * covFY) / det;
  } else {
    bf = covFY / Math.max(1e-9, covFF);
  }
  const pred = wY + bf * (f1 - wF) + bt * (tau1 - wT);
  const clampLo = Math.min(...points.map((p) => p.temperatureC)) - 60;
  const clampHi = Math.max(...points.map((p) => p.temperatureC)) + 60;
  return Math.round(clamp(pred, clampLo, clampHi));
}

/** 无标定时的物理兜底：f1 主导、tau1 做加权修正 */
export function fallbackTemperature(f1: number, tau1: number): number {
  const { f1At800, f1At1200, tauAt800, tauAt1200 } = FALLBACK_REF;
  // f1 随温度近似线性下降
  const tFromF = 800 + ((f1At800 - f1) / (f1At800 - f1At1200)) * 400;
  let tFromTau = 1000;
  if (tau1 > 0) {
    tFromTau = 800 + ((tau1 - tauAt800) / (tauAt1200 - tauAt800)) * 400;
  }
  const fused = 0.7 * tFromF + 0.3 * tFromTau;
  return Math.round(clamp(fused, 500, 1350));
}

/**
 * 剩余可打锤数：假设锻打过程近似线性降温。
 * 每次锻打的平均降温幅度按经验取 6~10°C（强度越大降温越快，这里取 8°C）。
 * 数据不足时给保守默认值。
 */
export function estimateRemainingStrikes(
  temperatureC: number | null,
  recentHistory: { temperatureC: number | null; onsetTime: number }[],
  reheatAt = REHEAT_TEMPERATURE_C,
): number | null {
  if (temperatureC == null) return null;
  if (temperatureC <= reheatAt) return 0;

  const valid = recentHistory.filter((h) => h.temperatureC != null);
  let coolingPerStrike = 8;
  if (valid.length >= 4) {
    const first = valid[0];
    const last = valid[valid.length - 1];
    const span = last.onsetTime - first.onsetTime;
    const strikes = valid.length - 1;
    if (strikes > 0 && span > 0) {
      const drop = (first.temperatureC ?? 0) - (last.temperatureC ?? 0);
      // 每锤降温（忽略时间维度，按锤次计），夹在合理经验范围内
      coolingPerStrike = clamp(drop / strikes, 3, 18);
    }
  }
  const headroom = temperatureC - reheatAt;
  return Math.max(0, Math.floor(headroom / coolingPerStrike));
}

function avg(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function std(xs: number[], mean: number): number {
  return Math.sqrt(avg(xs.map((x) => (x - mean) ** 2)));
}
function weightedMean(weights: number[], values: number[], wSum: number): number {
  let s = 0;
  for (let i = 0; i < values.length; i++) s += weights[i] * values[i];
  return s / wSum;
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
