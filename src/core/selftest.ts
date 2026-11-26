import { HammerAnalyzer } from './analyzer';
import { ANVIL_MODES_HZ, profileKey } from './physics';
import { buildRecordFromDetected, uid } from './pipeline';
import { synthesizeSequence } from './synth';
import type { AppData } from './types';

export interface SelfTestReport {
  total: number;
  onsetRecallPct: number;
  tempMaeC: number;
  tempP95C: number;
  tempMaxC: number;
  tempWithin40Pct: number;
  crackRecallPct: number;
  crackFalsePositivePct: number;
  latencyMs: number;
  passed: boolean;
}

const yieldToUi = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export async function runSyntheticSelfTest(
  data: AppData,
  onProgress?: (message: string) => void,
): Promise<SelfTestReport> {
  const sr = 48_000;
  let total = 0;
  let matched = 0;
  let tp = 0;
  let fn = 0;
  let fp = 0;
  let tn = 0;
  const tempErrors: number[] = [];
  const latencies: number[] = [];

  for (let pi = 0; pi < data.steels.length; pi++) {
    for (let si = 0; si < data.sizes.length; si++) {
      const steel = data.steels[pi];
      const size = data.sizes[si];
      const key = profileKey(steel.id, size.id);
      const seed = 4200 + pi * 100 + si * 17;
      const count = 8;
      const strikes = Array.from({ length: count }, (_, i) => ({
        atSec: 0.2 + i * 0.333,
        tempC: 640 + ((seed * 7 + i * 53) % 440),
        crack: (seed * 31 + i * 17) % 100 < 28,
        strength: 0.82 + ((seed + i * 19) % 16) / 100,
      }));
      const { samples, truths } = synthesizeSequence({
        sampleRate: sr,
        steel,
        size,
        strikes,
        blowerLevel: 0.018,
        otherHammers: [{ atSec: 0.49, level: 0.13 }],
        seed,
      });

      const analyzer = new HammerAnalyzer({ sampleRate: sr, thresholdDb: data.settings.thresholdDb });
      const detected = [];
      for (let pos = 0; pos < samples.length; pos += 128) {
        detected.push(...analyzer.process(samples.subarray(pos, Math.min(samples.length, pos + 128))));
      }

      const records = detected.map((d) =>
        buildRecordFromDetected(d, {
          id: uid('selftest'),
          profileKey: key,
          steels: data.steels,
          sizes: data.sizes,
          calibration: data.calibration,
          source: 'synthetic',
          interferenceHz: ANVIL_MODES_HZ,
        }),
      );

      const used = new Set<number>();
      for (const truth of truths) {
        total++;
        let best = -1;
        let bestErr = Infinity;
        detected.forEach((d, di) => {
          if (used.has(di)) return;
          const err = Math.abs((d.onsetSample - truth.onsetSample) / sr) * 1000;
          if (err < bestErr && err <= 85) {
            bestErr = err;
            best = di;
          }
        });
        if (best < 0) continue;
        used.add(best);
        matched++;
        latencies.push(detected[best].algorithmicLatencyMs);
        const record = records[best];
        if (typeof record.tempC === 'number') tempErrors.push(Math.abs(record.tempC - truth.tempC));
        if (truth.crack && record.crackDetected) tp++;
        else if (truth.crack) fn++;
        else if (record.crackDetected) fp++;
        else tn++;
      }
      onProgress?.(`已完成 ${steel.name} / ${size.label}`);
      await yieldToUi();
    }
  }

  const crackRecallPct = (100 * tp) / Math.max(1, tp + fn);
  const crackFalsePositivePct = (100 * fp) / Math.max(1, fp + tn);
  const report: SelfTestReport = {
    total,
    onsetRecallPct: (100 * matched) / Math.max(1, total),
    tempMaeC: mean(tempErrors),
    tempP95C: percentile(tempErrors, 95),
    tempMaxC: Math.max(...tempErrors, 0),
    tempWithin40Pct: (100 * tempErrors.filter((e) => e <= 40).length) / Math.max(1, tempErrors.length),
    crackRecallPct,
    crackFalsePositivePct,
    latencyMs: percentile(latencies, 95),
    passed:
      (100 * matched) / Math.max(1, total) >= 98 &&
      mean(tempErrors) <= 40 &&
      percentile(tempErrors, 95) <= 40 &&
      crackRecallPct >= 85 &&
      crackFalsePositivePct <= 5,
  };
  return report;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
}
