import { HammerAnalyzer, type DetectedStrike } from '../src/core/analyzer';
import { defaultData } from '../src/core/defaults';
import { buildRecordFromDetected } from '../src/core/pipeline';
import { ANVIL_MODES_HZ, profileKey } from '../src/core/physics';
import { synthesizeSequence } from '../src/core/synth';
import type { StrikeRecord } from '../src/core/types';

const SR = 48_000;
const QUICK = process.argv.includes('--quick');

interface MatchedDetection {
  truthIndex: number;
  detected: DetectedStrike;
  record: StrikeRecord;
  onsetErrorMs: number;
}

function run(): void {
  const data = defaultData();
  const profiles: Array<{ steelId: string; sizeId: string }> = [];
  for (const steel of data.steels) {
    for (const size of data.sizes) profiles.push({ steelId: steel.id, sizeId: size.id });
  }

  let totalTruth = 0;
  let matched = 0;
  let onsetErrors: number[] = [];
  let latencyValues: number[] = [];
  let extraCandidates = 0;
  let duplicateCandidates = 0;
  let tempErrors: number[] = [];
  let crackTp = 0;
  let crackFn = 0;
  let crackFp = 0;
  let crackTn = 0;
  let rejectedTargets = 0;
  const profileRows: Array<Record<string, string | number>> = [];

  const sequencesPerProfile = QUICK ? 1 : 4;
  const strikesPerSequence = QUICK ? 6 : 10;

  for (const { steelId, sizeId } of profiles) {
    const steel = data.steels.find((s) => s.id === steelId)!;
    const size = data.sizes.find((s) => s.id === sizeId)!;
    const key = profileKey(steelId, sizeId);
    let pTruth = 0;
    let pMatched = 0;
    let pTempErrors: number[] = [];
    let pCrackTp = 0;
    let pCrackFn = 0;
    let pCrackFp = 0;
    let pCrackTn = 0;

    for (let seq = 0; seq < sequencesPerProfile; seq++) {
      const seed = 1000 + profiles.findIndex((p) => p.steelId === steelId && p.sizeId === sizeId) * 100 + seq;
      const crackFlags = Array.from({ length: strikesPerSequence }, (_, i) => {
        const v = (seed * 31 + i * 17) % 100;
        return v < 28;
      });
      const strikes = Array.from({ length: strikesPerSequence }, (_, i) => ({
        atSec: 0.25 + i * 0.333 + (((seed + i * 13) % 7) - 3) * 0.004,
        tempC: 635 + ((seed * 7 + i * 47 + seq * 23) % 455),
        crack: crackFlags[i],
        strength: 0.78 + ((seed + i * 19) % 22) / 100,
      }));
      const otherHammers =
        seq % 2 === 0
          ? [
              { atSec: 0.52 + ((seed % 5) * 0.03), level: 0.1 + (seq % 3) * 0.035 },
              ...(strikesPerSequence > 7 ? [{ atSec: 1.71, level: 0.13 }] : []),
            ]
          : [];
      const { samples, truths } = synthesizeSequence({
        sampleRate: SR,
        steel,
        size,
        strikes,
        blowerLevel: 0.008 + ((seed % 8) * 0.005),
        otherHammers,
        seed,
      });

      const analyzer = new HammerAnalyzer({ sampleRate: SR, thresholdDb: data.settings.thresholdDb });
      const detectedAll: DetectedStrike[] = [];
      for (let pos = 0; pos < samples.length; pos += 128) {
        detectedAll.push(...analyzer.process(samples.subarray(pos, Math.min(samples.length, pos + 128))));
      }

      const records = detectedAll.map((d) =>
        buildRecordFromDetected(d, {
          profileKey: key,
          steels: data.steels,
          sizes: data.sizes,
          calibration: data.calibration,
          source: 'synthetic',
          interferenceHz: ANVIL_MODES_HZ,
        }),
      );

      const used = new Set<number>();
      const matches: MatchedDetection[] = [];
      const sortedTruth = truths
        .map((t, truthIndex) => ({ ...t, truthIndex }))
        .sort((a, b) => a.onsetSample - b.onsetSample);

      for (const truth of sortedTruth) {
        let best = -1;
        let bestAbs = Infinity;
        for (let di = 0; di < detectedAll.length; di++) {
          if (used.has(di)) continue;
          const errMs = ((detectedAll[di].onsetSample - truth.onsetSample) / SR) * 1000;
          const abs = Math.abs(errMs);
          if (abs < bestAbs && abs <= 85) {
            bestAbs = abs;
            best = di;
          }
        }
        pTruth++;
        totalTruth++;
        if (best >= 0) {
          used.add(best);
          const onsetErrorMs = ((detectedAll[best].onsetSample - truth.onsetSample) / SR) * 1000;
          const m = { truthIndex: truth.truthIndex, detected: detectedAll[best], record: records[best], onsetErrorMs };
          matches.push(m);
          pMatched++;
          matched++;
          onsetErrors.push(onsetErrorMs);
          latencyValues.push(detectedAll[best].algorithmicLatencyMs);

          if (process.env.DEBUG) {
            const tempError = typeof m.record.tempC === 'number' ? Math.abs(m.record.tempC - truth.tempC) : 999;
            if (tempError > 35 || (truth.crack !== m.record.crackDetected)) {
              console.log('BAD', {
                profile: key, seq, i: truth.truthIndex, truthTemp: truth.tempC, crack: truth.crack,
                onsetErrorMs: Math.round(m.onsetErrorMs),
                estTemp: m.record.tempC, freqT: undefined as number | undefined,
                scale: m.record.frequencyScale, conf: m.record.tempConfidence,
                predCrack: m.record.crackDetected, score: m.record.crackScore,
                verdict: m.record.verdict,
                modes: m.record.modes.map(x => `${x.hz.toFixed(0)}${x.split ? 'S' : ''}`),
                matched: m.record.matchedModeHz.map(x => x.toFixed(0)),
                taus: m.record.tauMs.map(x => x.toFixed(0)),
              });
            }
          }
          if (m.record.verdict === 'rejected') rejectedTargets++;
          if (typeof m.record.tempC === 'number') {
            const e = Math.abs(m.record.tempC - truth.tempC);
            tempErrors.push(e);
            pTempErrors.push(e);
          }

          const predCrack = m.record.crackDetected;
          if (truth.crack && predCrack) {
            crackTp++;
            pCrackTp++;
          } else if (truth.crack && !predCrack) {
            crackFn++;
            pCrackFn++;
          } else if (!truth.crack && predCrack) {
            crackFp++;
            pCrackFp++;
          } else {
            crackTn++;
            pCrackTn++;
          }
        } else if (process.env.DEBUG) {
          console.log('MISSED', {
            profile: key, seq, truthTemp: truth.tempC, crack: truth.crack,
            atMs: (truth.onsetSample / SR) * 1000,
            detections: detectedAll.map((d) => Math.round((d.onsetSample / SR) * 1000)),
          });
        }
      }

      detectedAll.forEach((_, di) => {
        if (!used.has(di)) {
          extraCandidates++;
          // A second candidate inside 130 ms of a matched target is a duplicate/retrigger.
          const nearTarget = matches.some(
            (m) => Math.abs(detectedAll[di].onsetSample - m.detected.onsetSample) / SR < 0.13,
          );
          if (nearTarget) duplicateCandidates++;
        }
      });
    }

    const pCrackRecall = pCrackTp + pCrackFn ? (100 * pCrackTp) / (pCrackTp + pCrackFn) : 100;
    const pCrackFpr = pCrackFp + pCrackTn ? (100 * pCrackFp) / (pCrackFp + pCrackTn) : 0;
    profileRows.push({
      profile: `${steel.name}/${size.label.split(' ')[0]}`,
      onset: `${pMatched}/${pTruth}`,
      tempMae: pTempErrors.length ? mean(pTempErrors).toFixed(1) : '—',
      tempP95: pTempErrors.length ? percentile(pTempErrors, 95).toFixed(1) : '—',
      crackRecall: `${pCrackRecall.toFixed(0)}%`,
      crackFpr: `${pCrackFpr.toFixed(0)}%`,
    });
  }

  const onsetRecall = (100 * matched) / totalTruth;
  const crackRecall = crackTp + crackFn ? (100 * crackTp) / (crackTp + crackFn) : 0;
  const crackFpr = crackFp + crackTn ? (100 * crackFp) / (crackFp + crackTn) : 0;
  const result = {
    profiles: profileRows,
    strikes: totalTruth,
    onsetRecallPct: round2(onsetRecall),
    onsetErrorMaeMs: round2(mean(onsetErrors.map(Math.abs))),
    onsetErrorP95Ms: round2(percentile(onsetErrors.map(Math.abs), 95)),
    extraCandidates,
    duplicateCandidates,
    rejectedTargets,
    latencyP50Ms: round2(percentile(latencyValues, 50)),
    latencyP95Ms: round2(percentile(latencyValues, 95)),
    tempMaeC: round2(mean(tempErrors)),
    tempP95C: round2(percentile(tempErrors, 95)),
    tempMaxC: round2(Math.max(...tempErrors)),
    tempWithin40Pct: round2((100 * tempErrors.filter((e) => e <= 40).length) / Math.max(1, tempErrors.length)),
    crackRecallPct: round2(crackRecall),
    crackFalsePositivePct: round2(crackFpr),
    crackConfusion: { tp: crackTp, fn: crackFn, fp: crackFp, tn: crackTn },
  };

  console.table(profileRows);
  console.log(JSON.stringify(result, null, 2));

  const failures: string[] = [];
  if (onsetRecall < 98) failures.push(`起始检出率 ${onsetRecall.toFixed(2)}% < 98%`);
  if (percentile(tempErrors, 95) > 40 || mean(tempErrors) > 40) {
    failures.push(`温度误差过大 MAE=${mean(tempErrors).toFixed(2)}°C P95=${percentile(tempErrors, 95).toFixed(2)}°C`);
  }
  if (crackRecall < 85) failures.push(`暗裂检出率 ${crackRecall.toFixed(2)}% < 85%`);
  if (crackFpr > 5) failures.push(`暗裂误报率 ${crackFpr.toFixed(2)}% > 5%`);
  if (percentile(latencyValues, 95) > 65) failures.push(`算法窗口延迟 P95 ${percentile(latencyValues, 95).toFixed(1)}ms`);
  if (failures.length) {
    console.error('\nVALIDATION_FAILED');
    for (const f of failures) console.error(`- ${f}`);
    process.exit(1);
  }
  console.log('\nVALIDATION_PASSED');
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
}
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

run();
