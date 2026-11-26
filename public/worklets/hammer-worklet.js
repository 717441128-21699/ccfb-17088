"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // src/core/dsp.ts
  function nextPow2(n) {
    return 2 ** Math.ceil(Math.log2(Math.max(2, n)));
  }
  var FFT = class {
    constructor(size) {
      __publicField(this, "size");
      __publicField(this, "cos");
      __publicField(this, "sin");
      __publicField(this, "rev");
      if ((size & size - 1) !== 0) throw new Error("FFT size must be power of two");
      this.size = size;
      this.cos = new Float32Array(size / 2);
      this.sin = new Float32Array(size / 2);
      for (let i = 0; i < size / 2; i++) {
        this.cos[i] = Math.cos(-2 * Math.PI * i / size);
        this.sin[i] = Math.sin(-2 * Math.PI * i / size);
      }
      let bits = 0;
      while (1 << bits < size) bits++;
      this.rev = new Uint16Array(size);
      for (let i = 0; i < size; i++) {
        let x = i;
        let r = 0;
        for (let b = 0; b < bits; b++) {
          r = r << 1 | x & 1;
          x >>= 1;
        }
        this.rev[i] = r;
      }
    }
    forward(re, im) {
      const n = this.size;
      for (let i = 0; i < n; i++) {
        const j = this.rev[i];
        if (j > i) {
          const tr = re[i];
          re[i] = re[j];
          re[j] = tr;
          const ti = im[i];
          im[i] = im[j];
          im[j] = ti;
        }
      }
      for (let len = 2; len <= n; len <<= 1) {
        const half = len >> 1;
        const step = n / len;
        for (let i = 0; i < n; i += len) {
          for (let j = 0; j < half; j++) {
            const tw = j * step;
            const wr = this.cos[tw];
            const wi = this.sin[tw];
            const a = i + j;
            const b = a + half;
            const tr = wr * re[b] - wi * im[b];
            const ti = wr * im[b] + wi * re[b];
            re[b] = re[a] - tr;
            im[b] = im[a] - ti;
            re[a] += tr;
            im[a] += ti;
          }
        }
      }
    }
  };
  function tukeyWindow(n, alpha = 0.08) {
    const w = new Float32Array(n);
    const taper = Math.floor(alpha * n / 2);
    for (let i = 0; i < n; i++) {
      if (i < taper) {
        w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / Math.max(1, alpha * n - 1)));
      } else if (i >= n - taper) {
        const j = n - 1 - i;
        w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * j / Math.max(1, alpha * n - 1)));
      } else {
        w[i] = 1;
      }
    }
    return w;
  }
  function median(values) {
    if (!values.length) return 0;
    const a = [...values].sort((x, y) => x - y);
    const mid = a.length >> 1;
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }
  function refineFrequency(x, sampleRate, initialHz, start = 0, end = x.length) {
    const n = end - start;
    if (n < 32) return initialHz;
    const useN = Math.min(n, 1792);
    const begin = start + Math.floor((n - useN) * 0.08);
    const window = tukeyWindow(useN, 0.06);
    const magnitudeAt = (hz) => {
      let re = 0;
      let im = 0;
      for (let i = 0; i < useN; i++) {
        const angle = -2 * Math.PI * hz * (begin + i) / sampleRate;
        const v = x[begin + i] * window[i];
        re += v * Math.cos(angle);
        im += v * Math.sin(angle);
      }
      return Math.hypot(re, im);
    };
    let bestHz = initialHz;
    let bestMag = magnitudeAt(bestHz);
    const searchRound = (centerHz, radiusHz, stepHz) => {
      const steps = Math.ceil(radiusHz / stepHz);
      for (let k = -steps; k <= steps; k++) {
        if (k === 0) continue;
        const hz = centerHz + k * stepHz;
        if (hz < 45 || hz > sampleRate / 2 - 100) continue;
        const mag = magnitudeAt(hz);
        if (mag > bestMag) {
          bestMag = mag;
          bestHz = hz;
        }
      }
    };
    searchRound(initialHz, 28, 4);
    searchRound(bestHz, 4, 1);
    searchRound(bestHz, 1.25, 0.25);
    return Math.max(45, bestHz);
  }
  function fitDecayEnvelope(x, sampleRate, hz) {
    const frame = Math.floor(sampleRate * 0.0105);
    const hop = Math.floor(sampleRate * 26e-4);
    const amps = [];
    const times = [];
    const phase = 2 * Math.PI * hz / sampleRate;
    for (let start = Math.floor(sampleRate * 2e-3); start + frame <= x.length; start += hop) {
      let re = 0;
      let im = 0;
      let energy = 0;
      for (let n = 0; n < frame; n++) {
        const idx = start + n;
        const angle = phase * idx;
        const v = x[idx];
        re += v * Math.cos(angle);
        im -= v * Math.sin(angle);
        energy += v * v;
      }
      const amp = 2 * Math.hypot(re, im) / frame;
      const broadRms = Math.sqrt(energy / frame);
      if (amp > 1e-5 && broadRms > 1e-5) {
        amps.push(amp);
        times.push((start + frame / 2) / sampleRate);
      }
    }
    if (amps.length < 4) {
      return { tauMs: 500, r2: 0, irregularity: 0.8, beatHz: 0, envelope: [] };
    }
    const maxAmp = Math.max(...amps);
    const xs = [];
    const ys = [];
    const ts = [];
    for (let i = 0; i < amps.length; i++) {
      if (amps[i] > maxAmp * 0.1) {
        xs.push(times[i]);
        ys.push(Math.log(Math.max(1e-7, amps[i])));
        ts.push(times[i]);
      }
    }
    if (xs.length < 4) {
      return { tauMs: 500, r2: 0, irregularity: 0.7, beatHz: 0, envelope: [] };
    }
    const fit = linearRegression(xs, ys);
    const slope = fit.slope;
    const tauSec = slope < -0.05 ? -1 / slope : 1.2;
    const tauMs = Math.max(24, Math.min(1200, tauSec * 1e3));
    let ssRes = 0;
    let ssTot = 0;
    const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
    const envelope = [];
    for (let i = 0; i < xs.length; i++) {
      const predicted = fit.intercept + slope * xs[i];
      const residual = ys[i] - predicted;
      ssRes += residual * residual;
      ssTot += (ys[i] - meanY) ** 2;
      envelope.push({ t: xs[i], amp: Math.exp(ys[i]), predicted: Math.exp(predicted) });
    }
    const r2 = ssTot > 1e-8 ? Math.max(0, 1 - ssRes / ssTot) : 0;
    const residualSeries = envelope.map((p) => Math.log(p.amp + 1e-7) - Math.log(p.predicted + 1e-7));
    const residualStd = Math.sqrt(
      residualSeries.reduce((a, v) => a + v * v, 0) / residualSeries.length
    );
    let beatHz = 0;
    let beatScore = 0;
    if (residualSeries.length >= 8) {
      let bestCorr = 0;
      let bestLag = 0;
      for (let lag = 3; lag < Math.min(18, residualSeries.length - 3); lag++) {
        let c = 0;
        let n = 0;
        for (let i = 0; i + lag < residualSeries.length; i++) {
          c += residualSeries[i] * residualSeries[i + lag];
          n++;
        }
        c /= Math.max(1, n);
        if (c < -bestCorr) {
          bestCorr = -c;
          bestLag = lag;
        }
      }
      const hopSec = hop / sampleRate;
      if (bestLag > 0) {
        beatHz = 1 / (2 * bestLag * hopSec);
        beatScore = Math.min(1, bestCorr * 9);
      }
    }
    const fitIrregularity = Math.min(1, residualStd * 2.4 + (1 - r2) * 0.45);
    const irregularity = Math.max(0, Math.min(1, fitIrregularity * 0.72 + beatScore * 0.28));
    return { tauMs, r2, irregularity, beatHz, envelope };
  }
  function linearRegression(xs, ys) {
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - mx;
      num += dx * (ys[i] - my);
      den += dx * dx;
    }
    const slope = den > 1e-12 ? num / den : 0;
    return { slope, intercept: my - slope * mx };
  }
  function detectSplitPeaks(x, sampleRate, centerHz) {
    const radiusHz = Math.min(115, Math.max(55, centerHz * 0.09));
    const stepHz = 2;
    const maxSamples = Math.min(x.length, Math.floor(sampleRate * 0.046));
    const start = Math.floor((x.length - maxSamples) / 2);
    const n = maxSamples;
    const window = tukeyWindow(n, 0.12);
    const freqs = [];
    const mags = [];
    const magnitudeAtHz = (f) => {
      let re = 0;
      let im = 0;
      for (let i = 0; i < n; i++) {
        const angle = -2 * Math.PI * f * (start + i) / sampleRate;
        const v = x[start + i] * window[i];
        re += v * Math.cos(angle);
        im += v * Math.sin(angle);
      }
      return Math.hypot(re, im);
    };
    for (let f = centerHz - radiusHz; f <= centerHz + radiusHz + 0.01; f += stepHz) {
      freqs.push(f);
      mags.push(magnitudeAtHz(f));
    }
    const peaks = [];
    for (let i = 2; i < mags.length - 2; i++) {
      if (mags[i] > mags[i - 1] && mags[i] >= mags[i + 1] && mags[i] > mags[i - 2] && mags[i] >= mags[i + 2]) {
        const left = Math.min(...mags.slice(Math.max(0, i - 5), i));
        const right = Math.min(...mags.slice(i + 1, Math.min(mags.length, i + 6)));
        const valley2 = Math.max(1e-8, Math.min(left, right));
        peaks.push({
          hz: freqs[i],
          magnitude: mags[i],
          prominenceDb: 20 * Math.log10(mags[i] / valley2 + 1e-9)
        });
      }
    }
    if (peaks.length < 2) return { split: false, peaks: null, separationHz: 0, confidence: 0 };
    peaks.sort((a2, b2) => b2.magnitude - a2.magnitude);
    const main = peaks[0];
    let bestPair = null;
    let bestScore = -Infinity;
    for (const other of peaks.slice(1, 7)) {
      const sep2 = Math.abs(main.hz - other.hz);
      if (sep2 < 19 || sep2 > 105) continue;
      const weaker = Math.min(main.magnitude, other.magnitude);
      const stronger = Math.max(main.magnitude, other.magnitude);
      const ratio2 = weaker / (stronger + 1e-9);
      if (ratio2 < 0.3) continue;
      const lowHz = Math.min(main.hz, other.hz);
      const highHz = Math.max(main.hz, other.hz);
      let valley2 = Infinity;
      for (let i = 0; i < freqs.length; i++) {
        if (freqs[i] >= lowHz + 3 && freqs[i] <= highHz - 3) {
          valley2 = Math.min(valley2, mags[i]);
        }
      }
      if (!Number.isFinite(valley2)) valley2 = magnitudeAtHz((lowHz + highHz) / 2);
      const dipRatio2 = valley2 / weaker;
      if (dipRatio2 > 0.84) continue;
      const score = ratio2 * 8 + (0.84 - dipRatio2) * 18 + Math.min(other.prominenceDb, 14) * 0.35;
      if (score > bestScore) {
        bestScore = score;
        bestPair = [main, other];
      }
    }
    if (!bestPair) return { split: false, peaks: null, separationHz: 0, confidence: 0 };
    const [a, b] = bestPair;
    const sep = Math.abs(a.hz - b.hz);
    const ratio = Math.min(a.magnitude, b.magnitude) / Math.max(a.magnitude, b.magnitude);
    let valley = Infinity;
    for (let i = 0; i < freqs.length; i++) {
      if (freqs[i] >= Math.min(a.hz, b.hz) + 3 && freqs[i] <= Math.max(a.hz, b.hz) - 3) {
        valley = Math.min(valley, mags[i]);
      }
    }
    const dipRatio = Number.isFinite(valley) ? valley / Math.min(a.magnitude, b.magnitude) : 1;
    const confidence = Math.max(
      0,
      Math.min(1, 0.25 + ratio * 0.45 + Math.max(0, 0.84 - dipRatio) * 1.4)
    );
    const split = ratio >= 0.36 && dipRatio <= 0.78 && confidence >= 0.48;
    return {
      split,
      peaks: [Math.min(a.hz, b.hz), Math.max(a.hz, b.hz)],
      separationHz: sep,
      confidence
    };
  }
  function extractModalPeaks(samples, sampleRate) {
    const n = samples.length;
    const fftSize = nextPow2(Math.max(2048, n * 2));
    const re = new Float32Array(fftSize);
    const im = new Float32Array(fftSize);
    const w = tukeyWindow(n, 0.07);
    let windowPower = 0;
    for (let i = 0; i < n; i++) {
      re[i] = samples[i] * w[i];
      windowPower += w[i] * w[i];
    }
    const fft = new FFT(fftSize);
    fft.forward(re, im);
    const binHz = sampleRate / fftSize;
    const minBin = Math.floor(150 / binHz);
    const maxBin = Math.min(Math.ceil(6800 / binHz), fftSize / 2 - 2);
    const mag = new Float32Array(maxBin + 2);
    for (let i = minBin; i <= maxBin; i++) mag[i] = Math.hypot(re[i], im[i]) * 2 / Math.max(1, windowPower / n);
    const peaks = [];
    for (let i = minBin + 3; i < maxBin - 3; i++) {
      if (mag[i] <= mag[i - 1] || mag[i] < mag[i + 1]) continue;
      if (mag[i] < mag[i - 2] || mag[i] < mag[i + 2]) continue;
      const neighborhood = [];
      for (let j = Math.max(minBin, i - 18); j <= Math.min(maxBin, i + 18); j++) {
        if (Math.abs(j - i) > 3) neighborhood.push(20 * Math.log10(mag[j] + 1e-8));
      }
      const floorDb = median(neighborhood);
      const peakDb = 20 * Math.log10(mag[i] + 1e-8);
      if (peakDb - floorDb < 7.5) continue;
      if (peakDb < -52) continue;
      const y0 = mag[i - 1];
      const y1 = mag[i];
      const y2 = mag[i + 1];
      const denom = y0 - 2 * y1 + y2;
      const offset = denom !== 0 ? 0.5 * (y0 - y2) / denom : 0;
      const hz = (i + Math.max(-1, Math.min(1, offset))) * binHz;
      peaks.push({ hz, amplitude: mag[i] });
    }
    peaks.sort((a, b) => b.amplitude - a.amplitude);
    const selected = [];
    for (const p of peaks) {
      if (selected.every((q) => Math.abs(Math.log(q.hz / p.hz)) * p.hz > 34)) selected.push(p);
      if (selected.length >= 12) break;
    }
    selected.sort((a, b) => a.hz - b.hz);
    return selected.map((p) => {
      const hz = refineFrequency(samples, sampleRate, p.hz);
      const decay = fitDecayEnvelope(samples, sampleRate, hz);
      const splitInfo = detectSplitPeaks(samples, sampleRate, hz);
      const irregularity = Math.max(
        decay.irregularity,
        splitInfo.split ? 0.72 + splitInfo.confidence * 0.2 : decay.irregularity
      );
      return {
        hz,
        amplitude: p.amplitude,
        tauMs: decay.tauMs,
        tauR2: decay.r2,
        split: splitInfo.split,
        splitConfidence: splitInfo.confidence,
        splitHz: splitInfo.peaks ?? void 0,
        splitSeparationHz: splitInfo.separationHz || void 0,
        irregularity: Math.max(0, Math.min(1, irregularity))
      };
    });
  }

  // src/core/analyzer.ts
  var HammerAnalyzer = class {
    constructor(options) {
      __publicField(this, "sampleRate");
      __publicField(this, "thresholdDb");
      __publicField(this, "windowSamples");
      __publicField(this, "preSamples");
      __publicField(this, "frame", 0);
      __publicField(this, "lastCandidateFrame", -1e7);
      __publicField(this, "lastStrongOnsetFrame", -1e7);
      __publicField(this, "candidateRefractorySamples");
      __publicField(this, "ringGuardSamples");
      __publicField(this, "hpPrevInput", 0);
      __publicField(this, "hpPrevOutput", 0);
      __publicField(this, "lp", 0);
      __publicField(this, "lastHpRms", 2e-3);
      __publicField(this, "hpHistory", []);
      __publicField(this, "noiseHpRms", 4e-3);
      __publicField(this, "noiseRms", 8e-3);
      __publicField(this, "adaptationBlocks", 0);
      __publicField(this, "preRing");
      __publicField(this, "preWrite", 0);
      __publicField(this, "preCount", 0);
      __publicField(this, "pending", null);
      this.sampleRate = options.sampleRate;
      this.thresholdDb = options.thresholdDb ?? -36;
      this.windowSamples = options.windowSamples ?? 2048;
      this.preSamples = options.preSamples ?? 256;
      this.candidateRefractorySamples = Math.floor(0.024 * this.sampleRate);
      this.ringGuardSamples = Math.floor((options.refractoryMs ?? 245) * this.sampleRate / 1e3);
      this.preRing = new Float32Array(this.preSamples);
    }
    reset() {
      this.frame = 0;
      this.lastCandidateFrame = -1e7;
      this.lastStrongOnsetFrame = -1e7;
      this.hpPrevInput = 0;
      this.hpPrevOutput = 0;
      this.lp = 0;
      this.lastHpRms = 2e-3;
      this.hpHistory = [];
      this.noiseHpRms = 4e-3;
      this.noiseRms = 8e-3;
      this.adaptationBlocks = 0;
      this.preRing.fill(0);
      this.preWrite = 0;
      this.preCount = 0;
      this.pending = null;
    }
    process(input) {
      const strikes = [];
      const blockStartFrame = this.frame;
      const n = input.length;
      if (!n) return strikes;
      const hp = new Float32Array(n);
      let hpSq = 0;
      let allSq = 0;
      let lowSq = 0;
      let peak = 0;
      const hpAlpha = Math.exp(-2 * Math.PI * 620 / this.sampleRate);
      const lpAlpha = 1 - Math.exp(-2 * Math.PI * 190 / this.sampleRate);
      for (let i = 0; i < n; i++) {
        const x = input[i] || 0;
        allSq += x * x;
        peak = Math.max(peak, Math.abs(x));
        const yHp = hpAlpha * (this.hpPrevOutput + x - this.hpPrevInput);
        this.hpPrevInput = x;
        this.hpPrevOutput = yHp;
        hp[i] = yHp;
        hpSq += yHp * yHp;
        this.lp += lpAlpha * (x - this.lp);
        lowSq += this.lp * this.lp;
      }
      const hpRms = Math.sqrt(hpSq / n);
      const blockRms = Math.sqrt(allSq / n);
      let onsetNow = false;
      if (!this.pending) {
        onsetNow = this.detectOnset(hpRms, blockRms, peak, blockStartFrame);
      }
      if (onsetNow) {
        this.lastCandidateFrame = blockStartFrame;
        if (peak > 0.43 || hpRms > 0.19) this.lastStrongOnsetFrame = blockStartFrame;
        const pre = this.snapshotPreRing();
        const buffer = new Float32Array(this.windowSamples);
        buffer.set(pre, 0);
        this.pending = {
          buffer,
          writeOffset: pre.length,
          onsetSample: blockStartFrame,
          peak,
          allSq,
          lowSq,
          highSq: hpSq,
          count: n
        };
        this.appendPending(input, hpSq, allSq, lowSq, peak);
      } else if (this.pending) {
        this.appendPending(input, hpSq, allSq, lowSq, peak);
      } else {
        this.adaptNoiseFloor(hpRms, blockRms, false);
      }
      this.writePreRing(input);
      this.lastHpRms = hpRms;
      this.hpHistory.push(hpRms);
      if (this.hpHistory.length > 6) this.hpHistory.shift();
      this.frame += n;
      if (this.pending && this.pending.writeOffset >= this.windowSamples) {
        const p = this.pending;
        this.pending = null;
        const result = this.finalize(p);
        if (result) strikes.push(result);
      }
      return strikes;
    }
    detectOnset(hpRms, blockRms, peak, frame) {
      this.adaptationBlocks++;
      if (this.adaptationBlocks < 8) {
        this.adaptNoiseFloor(hpRms, blockRms, true);
      }
      const sinceCandidate = frame - this.lastCandidateFrame;
      const sinceStrong = frame - this.lastStrongOnsetFrame;
      if (sinceCandidate < this.candidateRefractorySamples) {
        this.adaptNoiseFloor(hpRms, blockRms, false);
        return false;
      }
      if (sinceStrong < this.ringGuardSamples && peak < 0.58 && hpRms < 0.25) {
        this.adaptNoiseFloor(hpRms, blockRms, false);
        return false;
      }
      const absoluteGate = Math.pow(10, this.thresholdDb / 20) * 0.46;
      const ratio = hpRms / Math.max(8e-5, this.noiseHpRms);
      const rmsRatio = blockRms / Math.max(2e-4, this.noiseRms);
      const historyFloor = this.hpHistory.length ? Math.min(...this.hpHistory) : this.lastHpRms;
      const sharpRise = hpRms > this.lastHpRms * 1.32 && hpRms > historyFloor * 1.55 && (this.lastHpRms < absoluteGate * 1.7 || ratio > 3.2);
      const isOnset = hpRms > absoluteGate && ratio > 2.1 && rmsRatio > 1.35 && sharpRise;
      if (!isOnset) this.adaptNoiseFloor(hpRms, blockRms, false);
      return isOnset;
    }
    adaptNoiseFloor(hpRms, rms2, initial) {
      if (initial) {
        const a = this.adaptationBlocks < 20 ? 0.22 : 0.06;
        this.noiseHpRms += (Math.max(hpRms, 12e-5) - this.noiseHpRms) * a;
        this.noiseRms += (Math.max(rms2, 4e-4) - this.noiseRms) * a;
        return;
      }
      if (hpRms < this.noiseHpRms * 2.1) {
        this.noiseHpRms = this.noiseHpRms * 0.965 + hpRms * 0.035;
      } else {
        this.noiseHpRms = this.noiseHpRms * 0.995 + Math.min(hpRms, this.noiseHpRms * 2) * 5e-3;
      }
      if (rms2 < this.noiseRms * 2) {
        this.noiseRms = this.noiseRms * 0.97 + rms2 * 0.03;
      }
    }
    snapshotPreRing() {
      const count = Math.min(this.preCount, this.preSamples);
      const out = new Float32Array(count);
      if (this.preCount < this.preSamples) {
        out.set(this.preRing.subarray(0, count), 0);
      } else {
        const first = this.preSamples - this.preWrite;
        out.set(this.preRing.subarray(this.preWrite), 0);
        out.set(this.preRing.subarray(0, this.preWrite), first);
      }
      return out;
    }
    writePreRing(input) {
      for (let i = 0; i < input.length; i++) {
        this.preRing[this.preWrite] = input[i];
        this.preWrite = (this.preWrite + 1) % this.preSamples;
        if (this.preCount < this.preSamples) this.preCount++;
      }
    }
    appendPending(input, hpSq, allSq, lowSq, peak) {
      const p = this.pending;
      if (!p) return;
      const remaining = this.windowSamples - p.writeOffset;
      const toCopy = Math.min(input.length, remaining);
      p.buffer.set(input.subarray(0, toCopy), p.writeOffset);
      p.writeOffset += toCopy;
      p.peak = Math.max(p.peak, peak);
      p.allSq += allSq;
      p.lowSq += lowSq;
      p.highSq += hpSq;
      p.count += input.length;
    }
    finalize(p) {
      try {
        const modes = extractModalPeaks(p.buffer, this.sampleRate);
        const rmsLevel = Math.sqrt(p.allSq / Math.max(1, p.count));
        const lowFrequencyEnergy = Math.sqrt(p.lowSq / Math.max(1, p.count));
        const highFrequencyEnergy = Math.sqrt(p.highSq / Math.max(1, p.count));
        const crackScore = rawCrackScore(modes);
        const readySample = this.frame;
        return {
          onsetSample: p.onsetSample,
          readySample,
          algorithmicLatencyMs: (readySample - p.onsetSample) / this.sampleRate * 1e3,
          sampleRate: this.sampleRate,
          peakLevel: p.peak,
          rmsLevel,
          lowFrequencyEnergy: lowFrequencyEnergy / Math.max(rmsLevel, 1e-6),
          highFrequencyEnergy: highFrequencyEnergy / Math.max(rmsLevel, 1e-6),
          modes,
          crackScore,
          crackDetected: crackScore >= 0.62,
          windowSamples: this.windowSamples
        };
      } catch (error) {
        console.warn("Hammer analysis failed", error);
        return null;
      }
    }
  };
  function rawCrackScore(modes) {
    if (!modes.length) return 0;
    let score = 0;
    for (const m of modes) {
      if (m.split) {
        score = Math.max(score, 0.62 + Math.min(0.3, (m.splitSeparationHz ?? 30) / 240) + m.irregularity * 0.12);
      } else {
        score = Math.max(score, m.irregularity * 0.58);
      }
    }
    const splitModes = modes.filter((m) => m.split).length;
    if (splitModes >= 2) score = Math.min(1, score + 0.08);
    return Math.max(0, Math.min(1, score));
  }

  // src/worklet/hammer-worklet.ts
  var HammerEarProcessor = class extends AudioWorkletProcessor {
    constructor(options) {
      super();
      __publicField(this, "analyzer");
      __publicField(this, "scopeSampleRate");
      const scope = globalThis;
      this.scopeSampleRate = scope.sampleRate ?? 48e3;
      const thresholdDb = options?.processorOptions?.thresholdDb ?? -34;
      this.analyzer = new HammerAnalyzer({
        sampleRate: this.scopeSampleRate,
        thresholdDb
      });
      this.port.onmessage = (event) => {
        const data = event.data;
        if (data.type === "threshold" && typeof data.thresholdDb === "number") {
          this.analyzer.thresholdDb = data.thresholdDb;
        }
        if (data.type === "reset") this.analyzer.reset();
      };
    }
    process(inputs, outputs) {
      const input = inputs[0];
      const channel = input && input.length > 0 ? input[0] : void 0;
      for (const outputChannels of outputs) {
        for (const channelData of outputChannels) channelData.fill(0);
      }
      if (channel && channel.length > 0) {
        const strikes = this.analyzer.process(channel);
        for (const strike of strikes) {
          this.port.postMessage({
            type: "strike",
            strike,
            workletSampleRate: this.scopeSampleRate
          });
        }
      }
      return true;
    }
  };
  registerProcessor("hammer-ear-processor", HammerEarProcessor);
})();
