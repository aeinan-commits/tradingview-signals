const fetch = require('node-fetch');
const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let signals = [];

app.post('/webhook', (req, res) => {
  const signal = {
    id: Date.now(),
    ticker: req.body.ticker || 'Bilinmiyor',
    price: req.body.price || 0,
    message: req.body.message || '',
    time: new Date().toLocaleString('tr-TR')
  };
  signals.unshift(signal);
  if (signals.length > 100) signals.pop();
  res.json({ status: 'ok' });
});

app.get('/signals', (req, res) => { res.json(signals); });

function ema(arr, period) {
  if (arr.length < period) period = arr.length;
  const k = 2 / (period + 1);
  let emaVal = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < arr.length; i++) emaVal = arr[i] * k + emaVal * (1 - k);
  return emaVal;
}

// EMA serisi (hizalı, ilk period-1 null)
function emaSeries(arr, period) {
  const out = [];
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < arr.length; i++) {
    if (i < period - 1) { out[i] = null; continue; }
    if (i === period - 1) {
      prev = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
      out[i] = prev;
    } else {
      prev = arr[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

function calcMACD(closes, fast, slow, signalP) {
  const n = closes.length;
  if (n < slow + signalP) return null;
  const emaFast = emaSeries(closes, fast);
  const emaSlow = emaSeries(closes, slow);
  const macdLine = [];
  for (let i = 0; i < n; i++) {
    macdLine[i] = (emaFast[i] !== null && emaSlow[i] !== null) ? emaFast[i] - emaSlow[i] : null;
  }
  // Sinyal = MACD'nin EMA'sı (null olmayan kısımdan)
  const macdValsIdx = [];
  const macdVals = [];
  for (let i = 0; i < n; i++) if (macdLine[i] !== null) { macdValsIdx.push(i); macdVals.push(macdLine[i]); }
  const sigVals = emaSeries(macdVals, signalP);
  const signalLine = new Array(n).fill(null);
  for (let j = 0; j < macdValsIdx.length; j++) {
    if (sigVals[j] !== null) signalLine[macdValsIdx[j]] = sigVals[j];
  }
  const histogram = [];
  for (let i = 0; i < n; i++) {
    histogram[i] = (macdLine[i] !== null && signalLine[i] !== null) ? macdLine[i] - signalLine[i] : null;
  }
  return { macdLine, signalLine, histogram };
}

function calcRSISeries(closes, period) {
  if (closes.length < period + 1) return [];
  const rsiArr = [];
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) { const diff = closes[i] - closes[i - 1]; if (diff > 0) gains += diff; else losses += Math.abs(diff); }
  let avgGain = gains / period, avgLoss = losses / period;
  rsiArr[period] = 100 - (100 / (1 + avgGain / (avgLoss || 0.0001)));
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const g = diff > 0 ? diff : 0, l = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    rsiArr[i] = 100 - (100 / (1 + avgGain / (avgLoss || 0.0001)));
  }
  for (let i = 0; i < period; i++) if (rsiArr[i] === undefined) rsiArr[i] = null;
  return rsiArr;
}

function calcMomentumSeriesAligned(closes, period) {
  const mom = [];
  for (let i = 0; i < closes.length; i++) mom[i] = i < period ? null : closes[i] - closes[i - period];
  return mom;
}

function calcCCISeries(highs, lows, closes, period) {
  const n = closes.length;
  const tp = [];
  for (let i = 0; i < n; i++) tp[i] = (highs[i] + lows[i] + closes[i]) / 3;
  const cci = [];
  for (let i = 0; i < n; i++) {
    if (i < period - 1) { cci[i] = null; continue; }
    const slice = tp.slice(i - period + 1, i + 1);
    const sma = slice.reduce((a, b) => a + b, 0) / period;
    const meanDev = slice.reduce((a, b) => a + Math.abs(b - sma), 0) / period;
    cci[i] = meanDev === 0 ? 0 : (tp[i] - sma) / (0.015 * meanDev);
  }
  return cci;
}

function detectDivergence(priceArr, indArr, lookback) {
  const n = priceArr.length;
  const start = Math.max(1, n - lookback);
  const win = 2;
  const highs = [], lows = [];
  for (let i = start + win; i < n - win; i++) {
    if (indArr[i] === null || indArr[i] === undefined) continue;
    let isHigh = true, isLow = true;
    for (let j = 1; j <= win; j++) {
      if (priceArr[i] <= priceArr[i - j] || priceArr[i] <= priceArr[i + j]) isHigh = false;
      if (priceArr[i] >= priceArr[i - j] || priceArr[i] >= priceArr[i + j]) isLow = false;
    }
    if (isHigh) highs.push({ idx: i, price: priceArr[i], ind: indArr[i] });
    if (isLow) lows.push({ idx: i, price: priceArr[i], ind: indArr[i] });
  }
  let result = 'none';
  if (highs.length >= 2) { const a = highs[highs.length - 2], b = highs[highs.length - 1]; if (b.price > a.price && b.ind < a.ind) result = 'bearish'; }
  if (lows.length >= 2) { const a = lows[lows.length - 2], b = lows[lows.length - 1]; if (b.price < a.price && b.ind > a.ind) result = (result === 'bearish') ? 'both' : 'bullish'; }
  return result;
}

function calcSupertrend(highs, lows, closes, period, mult) {
  const n = closes.length;
  if (n < period + 1) return null;
  const tr = [0];
  for (let i = 1; i < n; i++) tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  const atr = [];
  atr[period] = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  for (let i = period + 1; i < n; i++) atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  let trendDir = 1, finalUpper = 0, finalLower = 0, prevUpper = 0, prevLower = 0, supertrendVal = 0;
  for (let i = period; i < n; i++) {
    const hl2 = (highs[i] + lows[i]) / 2;
    const basicUpper = hl2 + mult * atr[i], basicLower = hl2 - mult * atr[i];
    finalUpper = (basicUpper < prevUpper || closes[i - 1] > prevUpper) ? basicUpper : prevUpper;
    finalLower = (basicLower > prevLower || closes[i - 1] < prevLower) ? basicLower : prevLower;
    if (i === period) trendDir = closes[i] > hl2 ? 1 : -1;
    else { if (trendDir === 1 && closes[i] < finalLower) trendDir = -1; else if (trendDir === -1 && closes[i] > finalUpper) trendDir = 1; }
    supertrendVal = trendDir === 1 ? finalLower : finalUpper;
    prevUpper = finalUpper; prevLower = finalLower;
  }
  const currentPrice = closes[n - 1];
  const dist = ((currentPrice - supertrendVal) / supertrendVal) * 100;
  return { direction: trendDir === 1 ? 'up' : 'down', value: parseFloat(supertrendVal.toFixed(2)), dist: parseFloat(dist.toFixed(2)), atr: parseFloat(atr[n - 1].toFixed(2)) };
}

function calcIchimoku(highs, lows, closes) {
  const n = closes.length;
  if (n < 52) return null;
  const tenkan = (Math.max(...highs.slice(n - 9)) + Math.min(...lows.slice(n - 9))) / 2;
  const kijun = (Math.max(...highs.slice(n - 26)) + Math.min(...lows.slice(n - 26))) / 2;
  const senkouA = (tenkan + kijun) / 2;
  const senkouB = (Math.max(...highs.slice(n - 52)) + Math.min(...lows.slice(n - 52))) / 2;
  const currentPrice = closes[n - 1];
  const cloudTop = Math.max(senkouA, senkouB), cloudBottom = Math.min(senkouA, senkouB);
  let pricePos = currentPrice > cloudTop ? 'above' : currentPrice < cloudBottom ? 'below' : 'inside';
  const cloudColor = senkouA >= senkouB ? 'green' : 'red';
  const tkCross = tenkan > kijun ? 'bull' : tenkan < kijun ? 'bear' : 'neutral';
  return { tenkan: parseFloat(tenkan.toFixed(2)), kijun: parseFloat(kijun.toFixed(2)), senkouA: parseFloat(senkouA.toFixed(2)), senkouB: parseFloat(senkouB.toFixed(2)), cloudTop: parseFloat(cloudTop.toFixed(2)), cloudBottom: parseFloat(cloudBottom.toFixed(2)), pricePos, cloudColor, tkCross };
}

function priceVolSignal(closes, vols, days, avgVol20) {
  const len = closes.length;
  if (len <= days) days = len - 1;
  const priceNow = closes[len - 1], priceThen = closes[len - 1 - days];
  const priceUp = priceNow > priceThen;
  const pricePct = ((priceNow - priceThen) / priceThen) * 100;
  const recentVolAvg = vols.slice(-days).reduce((a, b) => a + b, 0) / days;
  const volAboveAvg = recentVolAvg > avgVol20;
  let signal;
  if (priceUp && volAboveAvg) signal = 'strong_up';
  else if (priceUp && !volAboveAvg) signal = 'weak_up';
  else if (!priceUp && volAboveAvg) signal = 'strong_down';
  else signal = 'weak_down';
  return { signal, priceUp, pricePct: parseFloat(pricePct.toFixed(2)), volAboveAvg };
}

function resampleTo4h(closes, vols, highs, lows) {
  const nc = [], nv = [], nh = [], nl = [];
  for (let i = 0; i < closes.length; i += 4) {
    const c = closes.slice(i, i + 4), v = vols.slice(i, i + 4), h = highs.slice(i, i + 4), l = lows.slice(i, i + 4);
    if (c.length === 0) continue;
    nc.push(c[c.length - 1]); nv.push(v.reduce((a, b) => a + b, 0)); nh.push(Math.max(...h)); nl.push(Math.min(...l));
  }
  return { closes: nc, vols: nv, highs: nh, lows: nl };
}

function findSupportResistance(highs, lows, currentPrice, lookback) {
  const n = highs.length;
  const start = Math.max(0, n - lookback);
  const win = 3;
  const resistances = [], supports = [];
  for (let i = start + win; i < n - win; i++) {
    let isHigh = true;
    for (let j = 1; j <= win; j++) if (highs[i] <= highs[i - j] || highs[i] <= highs[i + j]) { isHigh = false; break; }
    if (isHigh) resistances.push(highs[i]);
    let isLow = true;
    for (let j = 1; j <= win; j++) if (lows[i] >= lows[i - j] || lows[i] >= lows[i + j]) { isLow = false; break; }
    if (isLow) supports.push(lows[i]);
  }
  function cluster(levels) {
    levels.sort((a, b) => a - b);
    const groups = [];
    levels.forEach(lv => {
      const g = groups.find(gr => Math.abs(gr.avg - lv) / gr.avg < 0.015);
      if (g) { g.vals.push(lv); g.avg = g.vals.reduce((a, b) => a + b, 0) / g.vals.length; }
      else groups.push({ avg: lv, vals: [lv] });
    });
    return groups.map(g => ({ level: g.avg, touches: g.vals.length }));
  }
  const resClusters = cluster(resistances).filter(r => r.level > currentPrice);
  const supClusters = cluster(supports).filter(s => s.level < currentPrice);
  resClusters.sort((a, b) => a.level - b.level);
  supClusters.sort((a, b) => b.level - a.level);
  const topRes = resClusters.slice(0, 3).map(r => ({ level: parseFloat(r.level.toFixed(2)), dist: parseFloat((((r.level - currentPrice) / currentPrice) * 100).toFixed(2)), touches: r.touches }));
  const topSup = supClusters.slice(0, 3).map(s => ({ level: parseFloat(s.level.toFixed(2)), dist: parseFloat((((s.level - currentPrice) / currentPrice) * 100).toFixed(2)), touches: s.touches }));
  return { resistances: topRes, supports: topSup };
}

const TF_CONFIG = {
  '15m': { interval: '15m', range: '60d', lookback: 200 },
  '1h':  { interval: '1h',  range: '730d', lookback: 300 },
  '4h':  { interval: '1h',  range: '730d', resample: true, lookback: 200 },
  '1d':  { interval: '1d',  range: '5y', lookback: 250 },
  '1wk': { interval: '1wk', range: '10y', lookback: 150 },
  '1mo': { interval: '1mo', range: 'max', lookback: 100 }
};

app.get('/analyze/:ticker', async (req, res) => {
  try {
    const ticker = req.params.ticker.toUpperCase() + '.IS';
    const tickerClean = req.params.ticker.toUpperCase();
    const tf = req.query.tf || '1d';
    const cfg = TF_CONFIG[tf] || TF_CONFIG['1d'];
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'application/json' };

    const chartRes = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${cfg.interval}&range=${cfg.range}&events=div%2Csplit`, { headers });
    const chartData = await chartRes.json();
    if (!chartData.chart || !chartData.chart.result || !chartData.chart.result[0]) return res.status(500).json({ error: 'Hisse bulunamadı: ' + ticker });

    const quote = chartData.chart.result[0].indicators.quote[0];
    let valid = quote.close.map((p, i) => ({ p, v: quote.volume[i], h: quote.high[i], l: quote.low[i] })).filter(x => x.p !== null && x.v !== null && x.h !== null && x.l !== null);
    let closes = valid.map(x => x.p), vols = valid.map(x => x.v), highs = valid.map(x => x.h), lows = valid.map(x => x.l);

    if (cfg.resample) { const r = resampleTo4h(closes, vols, highs, lows); closes = r.closes; vols = r.vols; highs = r.highs; lows = r.lows; }
    if (closes.length < 50) return res.status(500).json({ error: 'Bu zaman dilimi için yeterli veri yok' });

    const currentPrice = closes[closes.length - 1];
    const currentVol = vols[vols.length - 1];

    const periods = [5, 20, 50, 100, 200];
    const mas = periods.map(p => {
      const value = ema(closes, p);
      const diff = ((currentPrice - value) / value) * 100;
      return { period: p, value: parseFloat(value.toFixed(2)), above: currentPrice > value, diff: parseFloat(diff.toFixed(2)) };
    });

    const rsiSeriesAligned = calcRSISeries(closes, 14);
    const rsiVals = rsiSeriesAligned.filter(x => x !== null);
    const rsi = rsiVals[rsiVals.length - 1];
    let rsiSignal = null, rsiVsSignalPct = null, rsiAboveSignal = null;
    if (rsiVals.length >= 9) {
      const last9 = rsiVals.slice(-9);
      rsiSignal = last9.reduce((a, b) => a + b, 0) / 9;
      rsiAboveSignal = rsi > rsiSignal;
      rsiVsSignalPct = ((rsi - rsiSignal) / rsiSignal) * 100;
    }
    const rsiDiv = detectDivergence(closes, rsiSeriesAligned, 40);

    let momentum = null;
    const momAligned = calcMomentumSeriesAligned(closes, 10);
    const momVals = momAligned.filter(x => x !== null);
    if (momVals.length >= 15) {
      const momNow = momVals[momVals.length - 1], momPrev = momVals[momVals.length - 2];
      const momSMA = momVals.slice(-15).reduce((a, b) => a + b, 0) / 15;
      const aboveSMA = momNow > momSMA;
      const vsSMApct = momSMA !== 0 ? ((momNow - momSMA) / Math.abs(momSMA)) * 100 : 0;
      let signal;
      if (momNow > 0 && momNow > momPrev) signal = 'strong_up';
      else if (momNow > 0 && momNow <= momPrev) signal = 'weak_up';
      else if (momNow < 0 && momNow < momPrev) signal = 'strong_down';
      else signal = 'weak_down';
      momentum = { value: parseFloat(momNow.toFixed(2)), sma: parseFloat(momSMA.toFixed(2)), aboveSMA, vsSMApct: parseFloat(vsSMApct.toFixed(1)), signal, positive: momNow > 0, divergence: detectDivergence(closes, momAligned, 40) };
    }

    let cci = null;
    const cciAligned = calcCCISeries(highs, lows, closes, 20);
    const cciVals = cciAligned.filter(x => x !== null);
    if (cciVals.length >= 14) {
      const cciNow = cciVals[cciVals.length - 1];
      const cciSMA = cciVals.slice(-14).reduce((a, b) => a + b, 0) / 14;
      const aboveSMA = cciNow > cciSMA;
      const vsSMApct = cciSMA !== 0 ? ((cciNow - cciSMA) / Math.abs(cciSMA)) * 100 : 0;
      let signal;
      if (cciNow > 100) signal = 'strong_up';
      else if (cciNow > 0) signal = 'mild_up';
      else if (cciNow < -100) signal = 'strong_down';
      else signal = 'mild_down';
      cci = { value: parseFloat(cciNow.toFixed(1)), sma: parseFloat(cciSMA.toFixed(1)), aboveSMA, vsSMApct: parseFloat(vsSMApct.toFixed(1)), signal, divergence: detectDivergence(closes, cciAligned, 40) };
    }

    // MACD (12-26-9)
    let macd = null;
    const macdData = calcMACD(closes, 12, 26, 9);
    if (macdData) {
      const n = closes.length;
      const macdNow = macdData.macdLine[n - 1];
      const sigNow = macdData.signalLine[n - 1];
      const histNow = macdData.histogram[n - 1];
      const histPrev = macdData.histogram[n - 2];
      const aboveSignal = macdNow > sigNow;
      const aboveZero = macdNow > 0;
      // Kesişim tespiti (son barda)
      const macdPrev = macdData.macdLine[n - 2];
      const sigPrev = macdData.signalLine[n - 2];
      let cross = 'none';
      if (macdPrev !== null && sigPrev !== null) {
        if (macdPrev <= sigPrev && macdNow > sigNow) cross = 'bull';
        else if (macdPrev >= sigPrev && macdNow < sigNow) cross = 'bear';
      }
      const histRising = (histNow !== null && histPrev !== null) ? histNow > histPrev : false;
      macd = {
        macd: parseFloat(macdNow.toFixed(3)),
        signal: parseFloat(sigNow.toFixed(3)),
        hist: parseFloat(histNow.toFixed(3)),
        aboveSignal, aboveZero, cross, histRising,
        divergence: detectDivergence(closes, macdData.macdLine, 40)
      };
    }

    const supertrend = calcSupertrend(highs, lows, closes, 10, 3);
    const ichimoku = calcIchimoku(highs, lows, closes);

    const avgVol20 = vols.slice(-20).reduce((a, b) => a + b, 0) / Math.min(vols.length, 20);
    const avgVol5 = vols.slice(-5).reduce((a, b) => a + b, 0) / Math.min(vols.length, 5);
    const volRatio = currentVol / avgVol20;
    const priceVol = { d1: priceVolSignal(closes, vols, 1, avgVol20), d5: priceVolSignal(closes, vols, 5, avgVol20), d20: priceVolSignal(closes, vols, 20, avgVol20) };
    const volTrendPct = ((avgVol5 - avgVol20) / avgVol20) * 100;
    let volTrend = volTrendPct > 15 ? 'rising' : volTrendPct < -15 ? 'falling' : 'stable';
    const max50Vol = Math.max(...vols.slice(-50));
    const volPosPct = (currentVol / max50Vol) * 100;

    let obv = 0; const obvSeries = [0];
    for (let i = 1; i < closes.length; i++) { if (closes[i] > closes[i - 1]) obv += vols[i]; else if (closes[i] < closes[i - 1]) obv -= vols[i]; obvSeries.push(obv); }
    const obvRising = obvSeries[obvSeries.length - 1] > (obvSeries[obvSeries.length - 21] || obvSeries[0]);
    const priceRising20 = currentPrice > (closes[closes.length - 21] || closes[0]);
    let obvSignal;
    if (obvRising && priceRising20) obvSignal = 'confirm_up';
    else if (!obvRising && !priceRising20) obvSignal = 'confirm_down';
    else if (obvRising && !priceRising20) obvSignal = 'bull_div';
    else obvSignal = 'bear_div';
    const obvDiv = detectDivergence(closes, obvSeries, 40);

    const sr = findSupportResistance(highs, lows, currentPrice, cfg.lookback);

    res.json({
      ticker: tickerClean, timeframe: tf, currentPrice: parseFloat(currentPrice.toFixed(2)),
      mas, rsi: parseFloat(rsi.toFixed(1)),
      rsiSignal: rsiSignal !== null ? parseFloat(rsiSignal.toFixed(1)) : null,
      rsiAboveSignal, rsiVsSignalPct: rsiVsSignalPct !== null ? parseFloat(rsiVsSignalPct.toFixed(2)) : null,
      rsiDivergence: rsiDiv,
      momentum, cci, macd, supertrend, ichimoku,
      volume: { current: currentVol, avg20: Math.round(avgVol20), avg5: Math.round(avgVol5), ratio: parseFloat(volRatio.toFixed(2)), priceVol, trend: volTrend, trendPct: parseFloat(volTrendPct.toFixed(1)), posPct: parseFloat(volPosPct.toFixed(0)), max50: Math.round(max50Vol), obvSignal, obvRising, obvDivergence: obvDiv },
      supportResistance: sr
    });

  } catch (err) {
    console.log('Hata:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sunucu çalışıyor: ${PORT}`));
