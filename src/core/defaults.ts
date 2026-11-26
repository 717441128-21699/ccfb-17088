import { billetModes, nominalTauMs, profileKey } from './physics';
import type { AppData, BilletSize, CalibrationPoint, SteelProfile } from './types';

export const DEFAULT_STEELS: SteelProfile[] = [
  {
    id: '1095',
    name: '1095 高碳钢',
    elasticModulusGpa: 205,
    densityKgM3: 7850,
    softeningA: 0.00038,
    softeningB: 1.5e-7,
    dampingCoefficient: 0.00215,
    minForgingTempC: 730,
    notes: '常见刀具钢，橙红以下应谨慎，温度过低易出现端裂。',
  },
  {
    id: '5160',
    name: '5160 弹簧钢',
    elasticModulusGpa: 200,
    densityKgM3: 7850,
    softeningA: 0.00035,
    softeningB: 1.4e-7,
    dampingCoefficient: 0.0020,
    minForgingTempC: 700,
    notes: '韧性较好，适合长刀；仍需避免在暗樱红区间硬打。',
  },
  {
    id: 'o1',
    name: 'O1 油淬工具钢',
    elasticModulusGpa: 203,
    densityKgM3: 7830,
    softeningA: 0.0004,
    softeningB: 1.62e-7,
    dampingCoefficient: 0.00235,
    minForgingTempC: 740,
    notes: '热敏感性略高，衰减变化通常更明显。',
  },
];

export const DEFAULT_SIZES: BilletSize[] = [
  {
    id: 'paring-180x25x3',
    steelId: '*',
    label: '小刀坯 180×25×3.2 mm',
    lengthMm: 180,
    widthMm: 25,
    thicknessMm: 3.2,
    tempLossPerBlowC: 13,
    coolingCPerSec: 3.4,
  },
  {
    id: 'chef-260x45x5',
    steelId: '*',
    label: '厨师刀 260×45×5 mm',
    lengthMm: 260,
    widthMm: 45,
    thicknessMm: 5,
    tempLossPerBlowC: 9,
    coolingCPerSec: 2.25,
  },
  {
    id: 'bowie-320x55x7',
    steelId: '*',
    label: '厚重刀坯 320×55×7 mm',
    lengthMm: 320,
    widthMm: 55,
    thicknessMm: 7,
    tempLossPerBlowC: 6.5,
    coolingCPerSec: 1.45,
  },
];

const CAL_TEMPS = [520, 600, 680, 740, 800, 860, 920, 980, 1040, 1100];

function stableNoise(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x) - 0.5;
}

export function buildDefaultCalibration(
  steels = DEFAULT_STEELS,
  sizes = DEFAULT_SIZES,
): CalibrationPoint[] {
  const points: CalibrationPoint[] = [];
  let n = 1;
  for (const steel of steels) {
    for (const size of sizes) {
      const key = profileKey(steel.id, size.id);
      for (const tempC of CAL_TEMPS) {
        const trueModes = billetModes(size, steel, tempC).slice(0, 3);
        const modesHz = trueModes.map((f, j) =>
          Math.round(f * (1 + stableNoise(n * 7 + j) * 0.006) * 10) / 10,
        );
        const tauMs = trueModes.map((_, j) =>
          Math.round(nominalTauMs(size, steel, tempC, j) * (1 + stableNoise(n * 13 + j) * 0.12)),
        );
        points.push({
          id: `cal-${steel.id}-${size.id}-${tempC}`,
          profileKey: key,
          tempC,
          measuredAt: '出厂合成温枪标定',
          modesHz,
          tauMs,
          note: '首次使用请用现场测温枪读数替换或补点。',
          synthetic: true,
        });
        n++;
      }
    }
  }
  return points;
}

export function defaultData(): AppData {
  return {
    version: 1,
    settings: {
      profileKey: profileKey(DEFAULT_STEELS[0].id, DEFAULT_SIZES[1].id),
      inputGain: 1,
      thresholdDb: -34,
      rejectOtherHammers: true,
      blowerSuppression: true,
      showSpectrum: true,
    },
    steels: DEFAULT_STEELS,
    sizes: DEFAULT_SIZES,
    calibration: buildDefaultCalibration(),
    strikes: [],
  };
}
