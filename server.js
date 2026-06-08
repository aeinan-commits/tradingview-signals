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
    id: Date.now(), ticker: req.body.ticker || 'Bilinmiyor', price: req.body.price || 0,
    message: req.body.message || '', time: new Date().toLocaleString('tr-TR')
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
function emaSeries(arr, period) {
  const out = []; const k = 2 / (period + 1); let prev = null;
  for (let i = 0; i < arr.length; i++) {
    if (i < period - 1) { out[i] = null; continue; }
    if (i === period - 1) { prev = arr.slice(0, period).reduce((a, b) => a + b, 0) / period; out[i] = prev; }
    else { prev = arr[i] * k + prev * (1 - k); out[i] = prev; }
  }
  return out;
}
function calcMACD(closes, fast, slow, signalP) {
  const n = closes.length;
  if (n < slow + signalP) return null;
  const emaFast = emaSeries(closes, fast), emaSlow = emaSeries(closes, slow);
  const macdLine = [];
  for (let i = 0; i < n; i++) macdLine[i] = (emaFast[i] !== null && emaSlow[i] !== null) ? emaFast[i] - emaSlow[i] : null;
  const idx = [], vals = [];
  for (let i = 0; i < n; i++) if (macdLine[i] !== null) { idx.push(i); vals.push(macdLine[i]); }
  const sigVals = emaSeries(vals, signalP);
  const signalLine = new Array(n).fill(null);
  for (let j = 0; j < idx.length; j++) if (sigVals[j] !== null) signalLine[idx[j]] = sigVals[j];
  const histogram = [];
  for (let i = 0; i < n; i++) histogram[i] = (macdLine[i] !== null && signalLine[i] !== null) ? macdLine[i] - signalLine[i] : null;
  return { macdLine, signalLine, histogram };
}
function calcRSISeries(closes, period) {
  if (closes.length < period + 1) return [];
  const rsiArr = []; let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) gains += d; else losses += Math.abs(d); }
  let avgGain = gains / period, avgLoss = losses / period;
  rsiArr[period] = 100 - (100 / (1 + avgGain / (avgLoss || 0.0001)));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]; const g = d > 0 ? d : 0, l = d < 0 ? Math.abs(d) : 0;
    avgGain = (avgGain * (period - 1) + g) / period; avgLoss = (avgLoss * (period - 1) + l) / period;
    rsiArr[i] = 100 - (100 / (1 + avgGain / (avgLoss || 0.0001)));
  }
  for (let i = 0; i < period; i++) if (rsiArr[i] === undefined) rsiArr[i] = null;
  return rsiArr;
}
// MFI serisi (hizalı)
function calcMFISeries(highs, lows, closes, vols, period) {
  const n = closes.length;
  const tp = [], rmf = [];
  for (let i = 0; i < n; i++) { tp[i] = (highs[i] + lows[i] + closes[i]) / 3; rmf[i] = tp[i] * vols[i]; }
  const mfi = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    let posFlow = 0, negFlow = 0;
    for (let j = i - period + 1; j <= i; j++) {
      if (tp[j] > tp[j - 1]) posFlow += rmf[j];
      else if (tp[j] < tp[j - 1]) negFlow += rmf[j];
    }
    const mr = negFlow === 0 ? 100 : posFlow / negFlow;
    mfi[i] = 100 - (100 / (1 + mr));
  }
  return mfi;
}
// Bollinger Bantları (20, 2)
function calcBollinger(closes, period, mult) {
  const n = closes.length;
  if (n < period) return null;
  const slice = closes.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / period;
  const sd = Math.sqrt(variance);
  const upper = sma + mult * sd;
  const lower = sma - mult * sd;
  const price = closes[n - 1];
  const bandwidth = ((upper - lower) / sma) * 100;
  const pctB = (price - lower) / (upper - lower);

  // Bant genişliği geçmişi (squeeze tespiti) - son 100 barın bandwidth'i
  const bwHist = [];
  for (let i = period; i <= n; i++) {
    const sl = closes.slice(i - period, i);
    const m = sl.reduce((a, b) => a + b, 0) / period;
    const v = sl.reduce((a, b) => a + Math.pow(b - m, 2), 0) / period;
    const s = Math.sqrt(v);
    bwHist.push(((2 * mult * s) / m) * 100);
  }
  const recentBW = bwHist.slice(-100);
  const minBW = Math.min(...recentBW);
  const maxBW = Math.max(...recentBW);
  // Squeeze: mevcut bant genişliği son 100 barın en dar %20'sinde mi?
  const bwPos = maxBW === minBW ? 50 : ((bandwidth - minBW) / (maxBW - minBW)) * 100;
  const squeeze = bwPos < 20;

  let pos;
  if (price > upper) pos = 'above_upper';
  else if (price > sma) pos = 'upper_half';
  else if (price > lower) pos = 'lower_half';
  else pos = 'below_lower';

  return {
    upper: parseFloat(upper.toFixed(2)),
    middle: parseFloat(sma.toFixed(2)),
    lower: parseFloat(lower.toFixed(2)),
    bandwidth: parseFloat(bandwidth.toFixed(2)),
    pctB: parseFloat((pctB * 100).toFixed(1)),
    bwPos: parseFloat(bwPos.toFixed(0)),
    squeeze, pos
  };
}
// Mum formasyonu tespiti — son barlara bakar, trend bağlamı ile
function detectCandlePatterns(opens, highs, lows, closes) {
  const n = closes.length;
  if (n < 10) return [];
  const patterns = [];

  // Trend bağlamı: son 10 barın yönü (formasyon konumu için)
  const trendRef = closes[n - 11] !== undefined ? closes[n - 11] : closes[0];
  const priorTrend = closes[n - 2] > trendRef ? 'up' : 'down';

  // Yardımcılar (son mum = index n-1)
  function body(i) { return Math.abs(closes[i] - opens[i]); }
  function range(i) { return highs[i] - lows[i]; }
  function upperWick(i) { return highs[i] - Math.max(opens[i], closes[i]); }
  function lowerWick(i) { return Math.min(opens[i], closes[i]) - lows[i]; }
  function isBull(i) { return closes[i] > opens[i]; }
  function isBear(i) { return closes[i] < opens[i]; }

  const i = n - 1;       // son mum
  const j = n - 2;       // önceki
  const k = n - 3;       // iki önceki
  const avgBody = (body(i) + body(j) + body(n - 4) + body(n - 5)) / 4 || 1;

  // ÇEKİÇ (Hammer) - düşüş trendinde dipte dönüş (boğa)
  if (lowerWick(i) > body(i) * 2 && upperWick(i) < body(i) * 0.6 && body(i) > 0 && priorTrend === 'down') {
    patterns.push({ name: 'Çekiç (Hammer)', dir: 'bull', candles: 1, desc: 'Uzun alt fitil, fiyatın aşağı itilip alıcılar tarafından geri alındığını gösterir. Düşüş trendinin dibinde göründü — boğa dönüş sinyali. Hacimle teyit güçlendirir.' });
  }
  // ASILI ADAM (Hanging Man) - yükseliş trendinde tepede dönüş (ayı)
  if (lowerWick(i) > body(i) * 2 && upperWick(i) < body(i) * 0.6 && body(i) > 0 && priorTrend === 'up') {
    patterns.push({ name: 'Asılı Adam (Hanging Man)', dir: 'bear', candles: 1, desc: 'Çekiçle aynı şekil ama yükseliş trendinin tepesinde göründü — ayı dönüş uyarısı. Satış baskısının arttığına işaret eder.' });
  }
  // TERS ÇEKİÇ (Inverted Hammer) - düşüşte dipte boğa
  if (upperWick(i) > body(i) * 2 && lowerWick(i) < body(i) * 0.6 && body(i) > 0 && priorTrend === 'down') {
    patterns.push({ name: 'Ters Çekiç (Inverted Hammer)', dir: 'bull', candles: 1, desc: 'Uzun üst fitil, düşüş trendinin dibinde — alıcıların yukarı denemesi. Boğa dönüş adayı, teyit bekleyin.' });
  }
  // KAYAN YILDIZ (Shooting Star) - yükselişte tepede ayı
  if (upperWick(i) > body(i) * 2 && lowerWick(i) < body(i) * 0.6 && body(i) > 0 && priorTrend === 'up') {
    patterns.push({ name: 'Kayan Yıldız (Shooting Star)', dir: 'bear', candles: 1, desc: 'Uzun üst fitil, yükseliş trendinin tepesinde — alıcılar yukarı itti ama satıcılar geri çekti. Güçlü ayı dönüş sinyali.' });
  }
  // DOJI - kararsızlık
  if (body(i) < range(i) * 0.1 && range(i) > 0) {
    patterns.push({ name: 'Doji', dir: 'neutral', candles: 1, desc: 'Açılış ve kapanış neredeyse eşit — alıcı ve satıcılar dengede, kararsızlık. Güçlü bir trendin sonunda göründüyse dönüş habercisi olabilir.' });
  }
  // YUTAN BOĞA (Bullish Engulfing)
  if (isBear(j) && isBull(i) && closes[i] > opens[j] && opens[i] < closes[j] && body(i) > body(j)) {
    patterns.push({ name: 'Yutan Boğa (Bullish Engulfing)', dir: 'bull', candles: 2, desc: 'Yeşil mum, önceki kırmızı mumu tamamen yuttu — alıcılar kontrolü ele geçirdi. Özellikle düşüş sonrası güçlü boğa dönüş sinyali.' });
  }
  // YUTAN AYI (Bearish Engulfing)
  if (isBull(j) && isBear(i) && closes[i] < opens[j] && opens[i] > closes[j] && body(i) > body(j)) {
    patterns.push({ name: 'Yutan Ayı (Bearish Engulfing)', dir: 'bear', candles: 2, desc: 'Kırmızı mum, önceki yeşil mumu tamamen yuttu — satıcılar kontrolü ele geçirdi. Özellikle yükseliş sonrası güçlü ayı dönüş sinyali.' });
  }
  // SABAH YILDIZI (Morning Star) - 3 mum, boğa
  if (n >= 3 && isBear(k) && body(j) < avgBody * 0.5 && isBull(i) && closes[i] > (opens[k] + closes[k]) / 2 && priorTrend === 'down') {
    patterns.push({ name: 'Sabah Yıldızı (Morning Star)', dir: 'bull', candles: 3, desc: 'Üç mumluk dizilim: büyük kırmızı + küçük kararsız mum + büyük yeşil. Düşüşün bittiğine ve boğa dönüşüne işaret eden güçlü bir formasyon.' });
  }
  // AKŞAM YILDIZI (Evening Star) - 3 mum, ayı
  if (n >= 3 && isBull(k) && body(j) < avgBody * 0.5 && isBear(i) && closes[i] < (opens[k] + closes[k]) / 2 && priorTrend === 'up') {
    patterns.push({ name: 'Akşam Yıldızı (Evening Star)', dir: 'bear', candles: 3, desc: 'Üç mumluk dizilim: büyük yeşil + küçük kararsız mum + büyük kırmızı. Yükselişin bittiğine ve ayı dönüşüne işaret eden güçlü bir formasyon.' });
  }
  // MARUBOZU - fitilsiz güçlü mum, trend devamı
  if (body(i) > range(i) * 0.9 && range(i) > avgBody) {
    if (isBull(i)) patterns.push({ name: 'Boğa Marubozu', dir: 'bull', candles: 1, desc: 'Neredeyse fitilsiz büyük yeşil mum — alıcılar açılıştan kapanışa tam kontrol. Güçlü yukarı momentum, trend devamı sinyali.' });
    else patterns.push({ name: 'Ayı Marubozu', dir: 'bear', candles: 1, desc: 'Neredeyse fitilsiz büyük kırmızı mum — satıcılar açılıştan kapanışa tam kontrol. Güçlü aşağı momentum, düşüş devamı sinyali.' });
  }
  return { patterns, priorTrend };
}

function calcMomentumSeriesAligned(closes, period) {
  const mom = [];
  for (let i = 0; i < closes.length; i++) mom[i] = i < period ? null : closes[i] - closes[i - period];
  return mom;
}
function calcCCISeries(highs, lows, closes, period) {
  const n = closes.length; const tp = [];
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
  const n = priceArr.length; const start = Math.max(1, n - lookback); const win = 2;
  const highs = [], lows = [];
  for (let i = start + win; i < n - win; i++) {
    if (indArr[i] === null || indArr[i] === undefined) continue;
    let isHigh = true, isLow = true;
    for (let j = 1; j <= win; j++) {
      if (priceArr[i] <= priceArr[i - j] || priceArr[i] <= priceArr[i + j]) isHigh = false;
      if (priceArr[i] >= priceArr[i - j] || priceArr[i] >= priceArr[i + j]) isLow = false;
    }
    if (isHigh) highs.push({ price: priceArr[i], ind: indArr[i] });
    if (isLow) lows.push({ price: priceArr[i], ind: indArr[i] });
  }
  let result = 'none';
  if (highs.length >= 2) { const a = highs[highs.length - 2], b = highs[highs.length - 1]; if (b.price > a.price && b.ind < a.ind) result = 'bearish'; }
  if (lows.length >= 2) { const a = lows[lows.length - 2], b = lows[lows.length - 1]; if (b.price < a.price && b.ind > a.ind) result = (result === 'bearish') ? 'both' : 'bullish'; }
  return result;
}
// ADX + DI (14) - Wilder yöntemi
function calcADX(highs, lows, closes, period) {
  const n = closes.length;
  if (n < period * 2 + 1) return null;
  const tr = [], plusDM = [], minusDM = [];
  for (let i = 1; i < n; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  // Wilder smoothing
  function wilderSmooth(arr) {
    const sm = [];
    let sum = arr.slice(0, period).reduce((a, b) => a + b, 0);
    sm[period - 1] = sum;
    for (let i = period; i < arr.length; i++) {
      sum = sum - sum / period + arr[i];
      sm[i] = sum;
    }
    return sm;
  }
  const trS = wilderSmooth(tr), plusS = wilderSmooth(plusDM), minusS = wilderSmooth(minusDM);
  const plusDI = [], minusDI = [], dx = [];
  for (let i = period - 1; i < tr.length; i++) {
    const pdi = trS[i] === 0 ? 0 : (plusS[i] / trS[i]) * 100;
    const mdi = trS[i] === 0 ? 0 : (minusS[i] / trS[i]) * 100;
    plusDI[i] = pdi; minusDI[i] = mdi;
    const sum = pdi + mdi;
    dx[i] = sum === 0 ? 0 : (Math.abs(pdi - mdi) / sum) * 100;
  }
  // ADX = DX'in Wilder ortalaması
  const dxVals = dx.filter(x => x !== undefined);
  if (dxVals.length < period) return null;
  let adx = dxVals.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxVals.length; i++) adx = (adx * (period - 1) + dxVals[i]) / period;
  const lastPlusDI = plusDI[plusDI.length - 1];
  const lastMinusDI = minusDI[minusDI.length - 1];
  return {
    adx: parseFloat(adx.toFixed(1)),
    plusDI: parseFloat(lastPlusDI.toFixed(1)),
    minusDI: parseFloat(lastMinusDI.toFixed(1)),
    bullish: lastPlusDI > lastMinusDI
  };
}
function calcSupertrend(highs, lows, closes, period, mult) {
  const n = closes.length;
  if (n < period + 1) return null;
  const tr = [0];
  for (let i = 1; i < n; i++) tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  const atr = [];
  atr[period] = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  for (let i = period + 1; i < n; i++) atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  let trendDir = 1, finalUpper = 0, finalLower = 0, prevUpper = 0, prevLower = 0, stVal = 0;
  for (let i = period; i < n; i++) {
    const hl2 = (highs[i] + lows[i]) / 2;
    const bu = hl2 + mult * atr[i], bl = hl2 - mult * atr[i];
    finalUpper = (bu < prevUpper || closes[i - 1] > prevUpper) ? bu : prevUpper;
    finalLower = (bl > prevLower || closes[i - 1] < prevLower) ? bl : prevLower;
    if (i === period) trendDir = closes[i] > hl2 ? 1 : -1;
    else { if (trendDir === 1 && closes[i] < finalLower) trendDir = -1; else if (trendDir === -1 && closes[i] > finalUpper) trendDir = 1; }
    stVal = trendDir === 1 ? finalLower : finalUpper;
    prevUpper = finalUpper; prevLower = finalLower;
  }
  const cp = closes[n - 1]; const dist = ((cp - stVal) / stVal) * 100;
  return { direction: trendDir === 1 ? 'up' : 'down', value: parseFloat(stVal.toFixed(2)), dist: parseFloat(dist.toFixed(2)), atr: parseFloat(atr[n - 1].toFixed(2)) };
}
function calcIchimoku(highs, lows, closes) {
  const n = closes.length;
  if (n < 52) return null;
  const tenkan = (Math.max(...highs.slice(n - 9)) + Math.min(...lows.slice(n - 9))) / 2;
  const kijun = (Math.max(...highs.slice(n - 26)) + Math.min(...lows.slice(n - 26))) / 2;
  const senkouA = (tenkan + kijun) / 2;
  const senkouB = (Math.max(...highs.slice(n - 52)) + Math.min(...lows.slice(n - 52))) / 2;
  const cp = closes[n - 1];
  const cloudTop = Math.max(senkouA, senkouB), cloudBottom = Math.min(senkouA, senkouB);
  let pricePos = cp > cloudTop ? 'above' : cp < cloudBottom ? 'below' : 'inside';
  const cloudColor = senkouA >= senkouB ? 'green' : 'red';
  const tkCross = tenkan > kijun ? 'bull' : tenkan < kijun ? 'bear' : 'neutral';
  return { tenkan: parseFloat(tenkan.toFixed(2)), kijun: parseFloat(kijun.toFixed(2)), senkouA: parseFloat(senkouA.toFixed(2)), senkouB: parseFloat(senkouB.toFixed(2)), cloudTop: parseFloat(cloudTop.toFixed(2)), cloudBottom: parseFloat(cloudBottom.toFixed(2)), pricePos, cloudColor, tkCross };
}
function priceVolSignal(closes, vols, days, avgVol20) {
  const len = closes.length;
  if (len <= days) days = len - 1;
  const pn = closes[len - 1], pt = closes[len - 1 - days];
  const priceUp = pn > pt; const pricePct = ((pn - pt) / pt) * 100;
  const rva = vols.slice(-days).reduce((a, b) => a + b, 0) / days;
  const volAboveAvg = rva > avgVol20;
  let signal;
  if (priceUp && volAboveAvg) signal = 'strong_up';
  else if (priceUp && !volAboveAvg) signal = 'weak_up';
  else if (!priceUp && volAboveAvg) signal = 'strong_down';
  else signal = 'weak_down';
  return { signal, priceUp, pricePct: parseFloat(pricePct.toFixed(2)), volAboveAvg };
}
function resampleTo4h(opens, closes, vols, highs, lows) {
  const no = [], nc = [], nv = [], nh = [], nl = [];
  for (let i = 0; i < closes.length; i += 4) {
    const o = opens.slice(i, i + 4), c = closes.slice(i, i + 4), v = vols.slice(i, i + 4), h = highs.slice(i, i + 4), l = lows.slice(i, i + 4);
    if (c.length === 0) continue;
    no.push(o[0]); nc.push(c[c.length - 1]); nv.push(v.reduce((a, b) => a + b, 0)); nh.push(Math.max(...h)); nl.push(Math.min(...l));
  }
  return { opens: no, closes: nc, vols: nv, highs: nh, lows: nl };
}
function findSupportResistance(highs, lows, currentPrice, lookback) {
  const n = highs.length; const start = Math.max(0, n - lookback); const win = 3;
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
    levels.sort((a, b) => a - b); const groups = [];
    levels.forEach(lv => {
      const g = groups.find(gr => Math.abs(gr.avg - lv) / gr.avg < 0.015);
      if (g) { g.vals.push(lv); g.avg = g.vals.reduce((a, b) => a + b, 0) / g.vals.length; }
      else groups.push({ avg: lv, vals: [lv] });
    });
    return groups.map(g => ({ level: g.avg, touches: g.vals.length }));
  }
  const rc = cluster(resistances).filter(r => r.level > currentPrice);
  const sc = cluster(supports).filter(s => s.level < currentPrice);
  rc.sort((a, b) => a.level - b.level); sc.sort((a, b) => b.level - a.level);
  const topRes = rc.slice(0, 3).map(r => ({ level: parseFloat(r.level.toFixed(2)), dist: parseFloat((((r.level - currentPrice) / currentPrice) * 100).toFixed(2)), touches: r.touches }));
  const topSup = sc.slice(0, 3).map(s => ({ level: parseFloat(s.level.toFixed(2)), dist: parseFloat((((s.level - currentPrice) / currentPrice) * 100).toFixed(2)), touches: s.touches }));
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
// Bir TF için ham veri çekip basit yön kararı verir
async function fetchTrendForTF(ticker, interval, range, resample, headers) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${interval}&range=${range}&events=div%2Csplit`, { headers });
    const data = await r.json();
    if (!data.chart || !data.chart.result || !data.chart.result[0]) return null;
    const q = data.chart.result[0].indicators.quote[0];
    let valid = q.close.map((p, i) => ({ p, v: q.volume[i], h: q.high[i], l: q.low[i] })).filter(x => x.p !== null && x.v !== null && x.h !== null && x.l !== null);
    let c = valid.map(x => x.p), v = valid.map(x => x.v), h = valid.map(x => x.h), l = valid.map(x => x.l);
    if (resample) { const rs = resampleTo4h(c.map(()=>0), c, v, h, l); c = rs.closes; v = rs.vols; h = rs.highs; l = rs.lows; }
    if (c.length < 30) return null;
    const price = c[c.length - 1];
    // 3 ölçüt
    const ema50 = ema(c, 50);
    const st = calcSupertrend(h, l, c, 10, 3);
    const macdData = calcMACD(c, 12, 26, 9);
    let score = 0, votes = 0;
    if (c.length >= 50) { score += price > ema50 ? 1 : -1; votes++; }
    if (st) { score += st.direction === 'up' ? 1 : -1; votes++; }
    if (macdData) { const m = macdData.macdLine[c.length - 1]; if (m !== null) { score += m > 0 ? 1 : -1; votes++; } }
    let dir;
    if (votes === 0) dir = 'neutral';
    else if (score >= 1) dir = 'up';
    else if (score <= -1) dir = 'down';
    else dir = 'neutral';
    return { dir, score, votes };
  } catch (e) { return null; }
}
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
    let valid = quote.close.map((p, i) => ({ p, v: quote.volume[i], h: quote.high[i], l: quote.low[i], o: quote.open[i] })).filter(x => x.p !== null && x.v !== null && x.h !== null && x.l !== null && x.o !== null);
    let closes = valid.map(x => x.p), vols = valid.map(x => x.v), highs = valid.map(x => x.h), lows = valid.map(x => x.l), opens = valid.map(x => x.o);

    if (cfg.resample) { const r = resampleTo4h(opens, closes, vols, highs, lows); opens = r.opens; closes = r.closes; vols = r.vols; highs = r.highs; lows = r.lows; }
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
    if (rsiVals.length >= 9) { const l9 = rsiVals.slice(-9); rsiSignal = l9.reduce((a, b) => a + b, 0) / 9; rsiAboveSignal = rsi > rsiSignal; rsiVsSignalPct = ((rsi - rsiSignal) / rsiSignal) * 100; }
    const rsiDiv = detectDivergence(closes, rsiSeriesAligned, 40);

    let momentum = null;
    const momAligned = calcMomentumSeriesAligned(closes, 10);
    const momVals = momAligned.filter(x => x !== null);
    if (momVals.length >= 15) {
      const mn = momVals[momVals.length - 1], mp = momVals[momVals.length - 2];
      const ms = momVals.slice(-15).reduce((a, b) => a + b, 0) / 15;
      const aboveSMA = mn > ms; const vsSMApct = ms !== 0 ? ((mn - ms) / Math.abs(ms)) * 100 : 0;
      let signal;
      if (mn > 0 && mn > mp) signal = 'strong_up'; else if (mn > 0 && mn <= mp) signal = 'weak_up'; else if (mn < 0 && mn < mp) signal = 'strong_down'; else signal = 'weak_down';
      momentum = { value: parseFloat(mn.toFixed(2)), sma: parseFloat(ms.toFixed(2)), aboveSMA, vsSMApct: parseFloat(vsSMApct.toFixed(1)), signal, positive: mn > 0, divergence: detectDivergence(closes, momAligned, 40) };
    }

    let cci = null;
    const cciAligned = calcCCISeries(highs, lows, closes, 20);
    const cciVals = cciAligned.filter(x => x !== null);
    if (cciVals.length >= 14) {
      const cn = cciVals[cciVals.length - 1];
      const cs = cciVals.slice(-14).reduce((a, b) => a + b, 0) / 14;
      const aboveSMA = cn > cs; const vsSMApct = cs !== 0 ? ((cn - cs) / Math.abs(cs)) * 100 : 0;
      let signal;
      if (cn > 100) signal = 'strong_up'; else if (cn > 0) signal = 'mild_up'; else if (cn < -100) signal = 'strong_down'; else signal = 'mild_down';
      cci = { value: parseFloat(cn.toFixed(1)), sma: parseFloat(cs.toFixed(1)), aboveSMA, vsSMApct: parseFloat(vsSMApct.toFixed(1)), signal, divergence: detectDivergence(closes, cciAligned, 40) };
    }

    // MFI (14) + 20 barlık SMA
    let mfi = null;
    const mfiAligned = calcMFISeries(highs, lows, closes, vols, 14);
    const mfiVals = mfiAligned.filter(x => x !== null);
    if (mfiVals.length >= 1) {
      const mfiNow = mfiVals[mfiVals.length - 1];
      let signal;
      if (mfiNow > 80) signal = 'overbought';
      else if (mfiNow >= 50) signal = 'bullish';
      else if (mfiNow > 20) signal = 'bearish';
      else signal = 'oversold';
      let mfiSMA = null, mfiAboveSMA = null, mfiVsSMApct = null;
      if (mfiVals.length >= 20) {
        mfiSMA = mfiVals.slice(-20).reduce((a, b) => a + b, 0) / 20;
        mfiAboveSMA = mfiNow > mfiSMA;
        mfiVsSMApct = mfiSMA !== 0 ? ((mfiNow - mfiSMA) / mfiSMA) * 100 : 0;
      }
      mfi = {
        value: parseFloat(mfiNow.toFixed(1)),
        signal,
        sma: mfiSMA !== null ? parseFloat(mfiSMA.toFixed(1)) : null,
        aboveSMA: mfiAboveSMA,
        vsSMApct: mfiVsSMApct !== null ? parseFloat(mfiVsSMApct.toFixed(1)) : null,
        divergence: detectDivergence(closes, mfiAligned, 40)
      };
    }

    let macd = null;
    const macdData = calcMACD(closes, 12, 26, 9);
    if (macdData) {
      const n = closes.length;
      const mn = macdData.macdLine[n - 1], sn = macdData.signalLine[n - 1], hn = macdData.histogram[n - 1], hp = macdData.histogram[n - 2];
      const aboveSignal = mn > sn, aboveZero = mn > 0;
      const mp = macdData.macdLine[n - 2], sp = macdData.signalLine[n - 2];
      let cross = 'none';
      if (mp !== null && sp !== null) { if (mp <= sp && mn > sn) cross = 'bull'; else if (mp >= sp && mn < sn) cross = 'bear'; }
      const histRising = (hn !== null && hp !== null) ? hn > hp : false;
      macd = { macd: parseFloat(mn.toFixed(3)), signal: parseFloat(sn.toFixed(3)), hist: parseFloat(hn.toFixed(3)), aboveSignal, aboveZero, cross, histRising, divergence: detectDivergence(closes, macdData.macdLine, 40) };
    }

    const supertrend = calcSupertrend(highs, lows, closes, 10, 3);
    const bollinger = calcBollinger(closes, 20, 2);
    const adx = calcADX(highs, lows, closes, 14);
    const candlePatterns = detectCandlePatterns(opens, highs, lows, closes);
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
    if (obvRising && priceRising20) obvSignal = 'confirm_up'; else if (!obvRising && !priceRising20) obvSignal = 'confirm_down'; else if (obvRising && !priceRising20) obvSignal = 'bull_div'; else obvSignal = 'bear_div';
    const obvDiv = detectDivergence(closes, obvSeries, 40);

    const sr = findSupportResistance(highs, lows, currentPrice, cfg.lookback);
    // Çoklu zaman dilimi uyumu (1h, 1d, 1wk arka planda)
    const [mtfH1, mtfD1, mtfW1] = await Promise.all([
      fetchTrendForTF(ticker, '1h', '730d', false, headers),
      fetchTrendForTF(ticker, '1d', '5y', false, headers),
      fetchTrendForTF(ticker, '1wk', '10y', false, headers)
    ]);
    const mtf = { h1: mtfH1, d1: mtfD1, w1: mtfW1 };

    res.json({
      ticker: tickerClean, timeframe: tf, currentPrice: parseFloat(currentPrice.toFixed(2)),
      mas, rsi: parseFloat(rsi.toFixed(1)),
      rsiSignal: rsiSignal !== null ? parseFloat(rsiSignal.toFixed(1)) : null,
      rsiAboveSignal, rsiVsSignalPct: rsiVsSignalPct !== null ? parseFloat(rsiVsSignalPct.toFixed(2)) : null, rsiDivergence: rsiDiv,
      momentum, cci, mfi, macd, bollinger, candlePatterns, adx, mtf, supertrend, ichimoku,
      volume: { current: currentVol, avg20: Math.round(avgVol20), avg5: Math.round(avgVol5), ratio: parseFloat(volRatio.toFixed(2)), priceVol, trend: volTrend, trendPct: parseFloat(volTrendPct.toFixed(1)), posPct: parseFloat(volPosPct.toFixed(0)), max50: Math.round(max50Vol), obvSignal, obvRising, obvDivergence: obvDiv },
      supportResistance: sr,
      chartData: (function(){
        const len = closes.length;
        const start = Math.max(0, len - 100);
        const slice = closes.slice(start);
        // EMA serilerini hizalı üret
        function emaSer(arr, period){
          const out = []; const k = 2/(period+1); let prev = null;
          for(let i=0;i<arr.length;i++){
            if(i<period-1){ out[i]=null; continue; }
            if(i===period-1){ prev=arr.slice(0,period).reduce((a,b)=>a+b,0)/period; out[i]=prev; }
            else { prev=arr[i]*k+prev*(1-k); out[i]=prev; }
          }
          return out;
        }
        const e20=emaSer(closes,20).slice(start);
        const e50=emaSer(closes,50).slice(start);
        const e200=emaSer(closes,200).slice(start);
        return { closes: slice.map(x=>parseFloat(x.toFixed(2))), ema20:e20, ema50:e50, ema200:e200 };
      })()
    });
  } catch (err) {
    console.log('Hata:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// ===== BIST100 LİSTESİ =====
const BIST100 = ['AEFES','AGHOL','AKBNK','AKCNS','AKFGY','AKSA','AKSEN','ALARK','ALBRK','ALFAS','ARCLK','ASELS','ASTOR','BERA','BIMAS','BRSAN','BRYAT','BUCIM','CCOLA','CIMSA','DOHOL','ECILC','EGEEN','EKGYO','ENERY','ENJSA','ENKAI','EREGL','EUPWR','FROTO','GARAN','GESAN','GUBRF','HALKB','HEKTS','IPEKE','ISCTR','ISGYO','ISMEN','KARSN','KCHOL','KONTR','KONYA','KORDS','KOZAA','KOZAL','KRDMD','MAVI','MGROS','MIATK','ODAS','OYAKC','PETKM','PGSUS','SAHOL','SASA','SISE','SKBNK','SMRTG','SOKM','TAVHL','TCELL','THYAO','TKFEN','TOASO','TSKB','TTKOM','TTRAK','TUKAS','TUPRS','ULKER','VAKBN','VESBE','VESTL','YKBNK','ZOREN','AGROT','ASGYO','BINHO','CANTE','CWENE','DESA','DOAS','EUREN','FENER','GENIL','GLYHO','GWIND','IEYHO','KAYSE','KLSER','KMPUR','MPARK','OBAMS','OTKAR','PASEU','REEDR','SAYAS','TABGD','YEOTK','ZRGYO'];

// Bir hisse için HIZLI skor (tek istek, MTF yok) — index.html'deki kurallarla uyumlu
async function quickScore(ticker, headers) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}.IS?interval=1d&range=2y&events=div%2Csplit`, { headers });
    const data = await r.json();
    if (!data.chart || !data.chart.result || !data.chart.result[0]) return null;
    const q = data.chart.result[0].indicators.quote[0];
    let valid = q.close.map((p, i) => ({ p, v: q.volume[i], h: q.high[i], l: q.low[i], o: q.open[i] })).filter(x => x.p !== null && x.v !== null && x.h !== null && x.l !== null && x.o !== null);
    let closes = valid.map(x => x.p), vols = valid.map(x => x.v), highs = valid.map(x => x.h), lows = valid.map(x => x.l), opens = valid.map(x => x.o);
    if (closes.length < 60) return null;

    const price = closes[closes.length - 1];
    let total = 0, maxW = 0;
    function vote(points, isTrend, tMult) { var w = isTrend ? points * tMult : points; total += w; maxW += Math.abs(w); }

   // Sert düşüş / tepe-dönüş cezası
    (function(){
      if(closes.length<22) return;
      var prevC=closes[closes.length-2];
      var dayChg=((price-prevC)/prevC)*100;
      var recentHigh=Math.max(...closes.slice(closes.length-20));
      var nearTop = price >= recentHigh*0.95;
      if(dayChg<=-3){ vote(nearTop ? -2.5 : -1.5, false); }
    })();
    // S/D
    const sr = findSupportResistance(highs, lows, price, 250);
    if (sr.supports[0]) { var sd = Math.abs(sr.supports[0].dist); if (sd <= 1) vote(1, false); if (sd >= 4) vote(-1, false); }
    if (sr.resistances[0]) { var rd = Math.abs(sr.resistances[0].dist); if (rd >= 4) vote(1, false); }

    // EMA
    const emaPts = { 20: 0.25, 50: 0.5, 200: 1 };
    [20, 50, 200].forEach(function (p) { if (closes.length >= p) { var e = ema(closes, p); if (price > e) vote(emaPts[p], true, tMult); } });

    // Hacim
    const avgVol20 = vols.slice(-20).reduce((a, b) => a + b, 0) / Math.min(vols.length, 20);
    const curVol = vols[vols.length - 1];
    const prevClose = closes[closes.length - 2];
    const lastBarUp = price > prevClose;
   if (curVol >= avgVol20) vote(lastBarUp ? 1 : -1, false);
    else if (lastBarUp) vote(-0.5, false); // düşük hacimle yükseliş = zayıf
    else vote(0, false);
    const p5 = closes[closes.length - 6]; if (p5) vote(price > p5 ? 1 : -1, false);
    const avgVol5 = vols.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const vtp = ((avgVol5 - avgVol20) / avgVol20) * 100;
    if (vtp > 15) vote(1, false); else if (vtp < -15) vote(-1, false);
    const max50 = Math.max(...vols.slice(-50)); const pp = (curVol / max50) * 100;
    if (pp > 50) vote(0.5, false); else if (pp < 25) vote(-0.5, false);

    // OBV
    let obv = 0; const obvS = [0];
    for (let i = 1; i < closes.length; i++) { if (closes[i] > closes[i-1]) obv += vols[i]; else if (closes[i] < closes[i-1]) obv -= vols[i]; obvS.push(obv); }
    const obvUp = obvS[obvS.length-1] > (obvS[obvS.length-21] || obvS[0]);
    const prUp = price > (closes[closes.length-21] || closes[0]);
    var obvSig;
    if (obvUp && prUp) obvSig='confirm_up';
    else if (!obvUp && !prUp) obvSig='confirm_down';
    else if (obvUp && !prUp) obvSig='bull_div';
    else obvSig='bear_div';
    vote({confirm_up:0.5, confirm_down:-0.5, bull_div:1, bear_div:-1}[obvSig], false);
    const obvDiv = detectDivergence(closes, obvS, 40);
    if (obvDiv === 'bullish') vote(1, false); else if (obvDiv === 'bearish') vote(-1, false);

    // Düşen bıçak: fiyat EMA50 altı + ADX güçlü
    const ema50val = closes.length >= 50 ? ema(closes, 50) : null;
    const fallingKnife = ema50val !== null && price < ema50val && adx && adx.adx >= 25;
    // RSI
    const rsiS = calcRSISeries(closes, 14); const rsiV = rsiS.filter(x => x !== null); const rsi = rsiV[rsiV.length-1];
    var rsiNorm = rsi < 30 ? 1 : rsi > 70 ? -1 : 0;
    if (rsiNorm === 1 && fallingKnife) rsiNorm = 0;
    vote(rsiNorm, false);
    if (rsiV.length >= 9) { var r9 = rsiV.slice(-9).reduce((a,b)=>a+b,0)/9; vote(rsi > r9 ? 0.5 : -0.5, false); }
    const rsiDiv = detectDivergence(closes, rsiS, 40); if (rsiDiv === 'bullish') vote(1,false); else if (rsiDiv === 'bearish') vote(-1,false);

    // MFI
    const mfiS = calcMFISeries(highs, lows, closes, vols, 14); const mfiV = mfiS.filter(x => x !== null); const mfi = mfiV[mfiV.length-1];
    if (mfi !== undefined) { var mfiNorm = mfi < 20 ? 1 : mfi > 80 ? -1 : 0; if (mfiNorm === 1 && fallingKnife) mfiNorm = 0; vote(mfiNorm, false); if (mfiV.length >= 20) { var m20 = mfiV.slice(-20).reduce((a,b)=>a+b,0)/20; vote(mfi > m20 ? 0.5 : -0.5, false); } var md = detectDivergence(closes, mfiS, 40); if (md==='bullish') vote(1,false); else if (md==='bearish') vote(-1,false); }

    // Momentum
    const momS = []; for (let i=0;i<closes.length;i++) momS[i] = i<10?null:closes[i]-closes[i-10];
    const momV = momS.filter(x=>x!==null);
    if (momV.length >= 15) { var mn=momV[momV.length-1], mp=momV[momV.length-2]; var ms=momV.slice(-15).reduce((a,b)=>a+b,0)/15; var mq = (mn>0&&mn>mp)?1:(mn>0)?0.5:(mn<0&&mn<mp)?-1:-0.5; vote(mq,false); vote(mn>ms?0.5:-0.5,false); var mmd=detectDivergence(closes,momS,40); if(mmd==='bullish')vote(1,false); else if(mmd==='bearish')vote(-1,false); }

    // CCI
    const cciS = calcCCISeries(highs, lows, closes, 20); const cciV = cciS.filter(x=>x!==null);
    if (cciV.length >= 14) { var cn=cciV[cciV.length-1]; var cs=cciV.slice(-14).reduce((a,b)=>a+b,0)/14; var cq=cn>100?1:cn>0?0.5:cn<-100?-1:-0.5; vote(cq,false); vote(cn>cs?0.5:-0.5,false); var cd=detectDivergence(closes,cciS,40); if(cd==='bullish')vote(1,false); else if(cd==='bearish')vote(-1,false); }

    // MACD
    const macdData = calcMACD(closes, 12, 26, 9);
    if (macdData) { var nn=closes.length; var mcN=macdData.macdLine[nn-1], sgN=macdData.signalLine[nn-1], mcP=macdData.macdLine[nn-2], sgP=macdData.signalLine[nn-2]; var cross='none'; if(mcP!==null&&sgP!==null){if(mcP<=sgP&&mcN>sgN)cross='bull';else if(mcP>=sgP&&mcN<sgN)cross='bear';} var macv=cross==='bull'?1:cross==='bear'?-1:(mcN>sgN?0.5:-0.5); vote(macv,false); vote(mcN>0?0.5:-0.5,false); var mdv=detectDivergence(closes,macdData.macdLine,40); if(mdv==='bullish')vote(1,false); else if(mdv==='bearish')vote(-1,false); }

    // Bollinger
    const boll = calcBollinger(closes, 20, 2);
    if (boll) { var bq={above_upper:-1,upper_half:-0.5,lower_half:0.5,below_lower:1}[boll.pos]; vote(bq,false); }
    
// Parabolic SAR (standart: adım 0.02, maksimum 0.2)
function calcPSAR(highs, lows, step, maxStep) {
  const n = highs.length;
  if (n < 3) return [];
  const sar = new Array(n).fill(null);
  let isUp = highs[1] >= highs[0];      // başlangıç trend yönü
  let ep = isUp ? highs[1] : lows[1];   // extreme point
  let af = step;                         // acceleration factor
  sar[1] = isUp ? lows[0] : highs[0];
  for (let i = 2; i < n; i++) {
    let prevSar = sar[i - 1];
    let curSar = prevSar + af * (ep - prevSar);
    if (isUp) {
      // yükseliş trendinde SAR son iki bardaki en düşüğü aşamaz
      curSar = Math.min(curSar, lows[i - 1], lows[i - 2]);
      if (lows[i] < curSar) {
        // trend döndü → düşüşe
        isUp = false; curSar = ep; ep = lows[i]; af = step;
      } else {
        if (highs[i] > ep) { ep = highs[i]; af = Math.min(af + step, maxStep); }
      }
    } else {
      curSar = Math.max(curSar, highs[i - 1], highs[i - 2]);
      if (highs[i] > curSar) {
        isUp = true; curSar = ep; ep = highs[i]; af = step;
      } else {
        if (lows[i] < ep) { ep = lows[i]; af = Math.min(af + step, maxStep); }
      }
    }
    sar[i] = curSar;
  }
  return sar;
}
    // Supertrend
    const st = calcSupertrend(highs, lows, closes, 10, 3);
    if (st) vote(st.direction==='up'?1.5:-1.5, true, tMult);

    // Ichimoku
    const ich = calcIchimoku(highs, lows, closes);
    if (ich) {
      var iq=ich.pricePos==='above'?1.5:ich.pricePos==='below'?-1.5:0; vote(iq,true,tMult);
      var tkV=ich.tkCross==='bull'?1:ich.tkCross==='bear'?-1:0;
      var rnV=ich.cloudColor==='green'?1:-1;
      var cSum=tkV+rnV; vote(cSum>0?0.5:cSum<0?-0.5:0, true, tMult);
    }


    // Mum
    const cp = detectCandlePatterns(opens, highs, lows, closes);
    if (cp && cp.patterns) cp.patterns.forEach(function(p){ if(p.dir==='bull')vote(1,false); else if(p.dir==='bear')vote(-1,false); });
   // Teyit bonusları (ana skorla tutarlı)
    if (rsi !== undefined) {
      if (rsi < 30 && rsiDiv === 'bullish') vote(1, false);
      else if (rsi > 70 && rsiDiv === 'bearish') vote(-1, false);
    }
    if (mfi !== undefined) {
      var mfiDivVal = detectDivergence(closes, mfiS, 40);
      if (mfi < 20 && mfiDivVal === 'bullish') vote(1, false);
      else if (mfi > 80 && mfiDivVal === 'bearish') vote(-1, false);
    }
    // ===== 5 TEKNİK STRATEJİ + VPA (sadece pozitif/anlamlı sinyaller) =====
    const strat = {};
    const ema50s = closes.length >= 50 ? ema(closes, 50) : null;
    const ema200s = closes.length >= 200 ? ema(closes, 200) : null;

    // 1) MOMENTUM: 63 günlük getiri >= +%10
    if (closes.length > 63) {
      const ago = closes[closes.length - 64];
      const ret = ((price - ago) / ago) * 100;
      if (ret >= 10) strat.momentum = 'Son 3 ayda %' + ret.toFixed(1) + ' yükseldi — güçlü momentum.';
    }

    // 2) TREND TAKİBİ: Fiyat > EMA50 > EMA200
    if (ema50s !== null && ema200s !== null && price > ema50s && ema50s > ema200s) {
      strat.trend = 'Fiyat > EMA50 > EMA200 — net yukarı dizilim, trend sağlam.';
    }

    // 3) 52 HAFTA ZİRVESİ: fiyat 252 günlük zirvenin %5 yakınında
    {
      const win = Math.min(closes.length, 252);
      const hi = Math.max(...closes.slice(-win));
      const distPct = ((hi - price) / hi) * 100;
      if (distPct <= 5) strat.high52 = 'Fiyat 52 hafta zirvesinin %' + distPct.toFixed(1) + ' yakınında — güç işareti.';
    }

    // 4) GÖRECELİ GÜÇ (RSI 55-70)
    if (rsi !== undefined && rsi >= 55 && rsi <= 70) {
      strat.relStrength = 'RSI ' + rsi.toFixed(0) + ' — güçlü bölgede, henüz aşırı alım değil.';
    }

    // 5) ORTALAMAYA DÖNÜŞ: RSI < 35 ve fiyat > EMA200
    if (rsi !== undefined && rsi < 35 && ema200s !== null && price > ema200s) {
      strat.meanRev = 'RSI ' + rsi.toFixed(0) + ' (aşırı satım) ama fiyat EMA200 üstünde — uzun trend sağlam, geri çekilme fırsatı olabilir.';
    }

    // 6) HACİM-FİYAT (VPA - Anna Coulling): sadece anlamlı sinyaller
    {
      const prevC2 = closes[closes.length - 2];
      const dayChg = ((price - prevC2) / prevC2) * 100;
      const volR = curVol / avgVol20; // bugünkü hacmin 20 ort'ye oranı
      if (dayChg >= 2 && volR >= 1.5) {
        strat.vpa = 'Fiyat %' + dayChg.toFixed(1) + ' arttı + hacim ortalamanın ' + volR.toFixed(1) + ' katı — doğrulanmış güçlü alım.';
      } else if (dayChg >= 2 && volR < 0.8) {
        strat.vpa = 'Fiyat %' + dayChg.toFixed(1) + ' arttı AMA hacim düşük (' + volR.toFixed(1) + 'x) — anomali, yükselişe güven zayıf.';
      } else if (dayChg <= -3 && volR >= 2) {
        strat.vpa = 'Fiyat %' + dayChg.toFixed(1) + ' düştü + çok yüksek hacim (' + volR.toFixed(1) + 'x) — olası satış doruğu (climax), dipten dönüş izlenebilir.';
      }
    }
    const norm = maxW > 0 ? total / maxW : 0;
    const pct = Math.round(((norm + 1) / 2) * 100);
    let verdict;
    if (norm >= 0.5) verdict = 'GÜÇLÜ AL';
    else if (norm >= 0.2) verdict = 'AL';
    else if (norm > -0.2) verdict = 'NÖTR';
    else if (norm > -0.5) verdict = 'SAT';
    else verdict = 'GÜÇLÜ SAT';
    return { ticker, price: parseFloat(price.toFixed(2)), norm: parseFloat(norm.toFixed(3)), pct, verdict, strategies: strat };
  } catch (e) { return null; }
}

// Tarama endpoint'i (parça parça, timeout'a karşı)
app.get('/scan', async (req, res) => {
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'application/json' };
  const results = [];
  // 5'erli gruplar halinde paralel çek (hız + rate-limit dengesi)
  for (let i = 0; i < BIST100.length; i += 5) {
    const chunk = BIST100.slice(i, i + 5);
    const part = await Promise.all(chunk.map(t => quickScore(t, headers)));
    part.forEach(p => { if (p) results.push(p); });
  }
  results.sort((a, b) => b.norm - a.norm);
  res.json({ count: results.length, results });
});
// ============================================================
// ===== ÖZEL ANALİZ SİSTEMİ (deneysel - ayrı puanlama) =====
// ============================================================
async function quickScoreOzel(ticker, headers, tf) {
  try {
    const cfg = TF_CONFIG[tf] || TF_CONFIG['1d'];
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}.IS?interval=${cfg.interval}&range=${cfg.range}&events=div%2Csplit`, { headers });
    const data = await r.json();
    if (!data.chart || !data.chart.result || !data.chart.result[0]) return null;
    const q = data.chart.result[0].indicators.quote[0];
    let valid = q.close.map((p, i) => ({ p, v: q.volume[i], h: q.high[i], l: q.low[i], o: q.open[i] })).filter(x => x.p !== null && x.v !== null && x.h !== null && x.l !== null && x.o !== null);
    let closes = valid.map(x => x.p), vols = valid.map(x => x.v), highs = valid.map(x => x.h), lows = valid.map(x => x.l), opens = valid.map(x => x.o);
    if (cfg.resample) { const rs = resampleTo4h(opens, closes, vols, highs, lows); opens = rs.opens; closes = rs.closes; vols = rs.vols; highs = rs.highs; lows = rs.lows; }
    if (closes.length < 60) return null;

    const price = closes[closes.length - 1];
    let total = 0, maxW = 0;
    const breakdown = [];
    function vote(points, name, detail) { total += points; maxW += Math.abs(points); if (name) breakdown.push({ name, points, detail: detail || '' }); }

    const adx = calcADX(highs, lows, closes, 14);
    const trendStrong = adx && adx.adx >= 25;
    const tMult = trendStrong ? 1.15 : 1;

    // === ÖZEL KURALLAR ===
    // Not: "içinde bulunulan bar" = son bar (closes son eleman, henüz kapanmamış kabul ediyoruz).
    // "Kapanmış barlar" = son bar hariç öncekiler.
    const n = closes.length;
    const ema200series = emaSeries(closes, 200); // hizalı EMA200 serisi

    // KURAL 1: Son 5 KAPANMIŞ bardan birinde EMA200 üstüne çıkıp üstünde kaldıysa +1
    // (içinde bulunulan son bar hariç → indeksler n-2 ... n-6)
    (function () {
      if (n < 7 || ema200series[n - 2] === null) return;
      // Son 5 kapanmış bar: n-6 .. n-2
      let crossedAndHeld = false;
      for (let i = n - 6; i <= n - 2; i++) {
        if (i < 1 || ema200series[i] === null || ema200series[i - 1] === null) continue;
        const justCrossed = closes[i - 1] <= ema200series[i - 1] && closes[i] > ema200series[i];
        if (!justCrossed) continue;
        // Kırılımdan sonra (i'den n-2'ye kadar) hep üstünde kalmış mı?
        let held = true;
        for (let j = i; j <= n - 2; j++) {
          if (ema200series[j] === null || closes[j] <= ema200series[j]) { held = false; break; }
        }
        if (held) { crossedAndHeld = true; break; }
      }
      if (crossedAndHeld) vote(1, 'EMA200 Kırılımı', 'Son 5 kapanmış barda EMA200 üstüne çıkıp üstünde kaldı.');
    })();

// KURAL 2: Son 3 kapanmış barın en az 2'sinde fiyat arttı + son (mevcut) bar artıyor
    //          + bu süreçteki her fiyat artışında hacim de arttıysa +1
    (function () {
      if (n < 5) return;
      const currentUp = closes[n - 1] > closes[n - 2];
      if (!currentUp) return;
      const closedBars = [n - 4, n - 3, n - 2];
      let upCount = 0;
      let allUpHaveVolUp = true;
      closedBars.forEach(function (i) {
        const priceUp = closes[i] > closes[i - 1];
        if (priceUp) {
          upCount++;
          if (!(vols[i] > vols[i - 1])) allUpHaveVolUp = false;
        }
      });
      const currentVolUp = vols[n - 1] > vols[n - 2];
      if (!currentVolUp) allUpHaveVolUp = false;
      if (upCount >= 2 && allUpHaveVolUp) vote(1, 'Hacimli Yükseliş', 'Son 3 barın en az 2\'si + mevcut bar yükseliş, hepsinde hacim de arttı.');
    })();

    // KURAL 3: Parabolic SAR — son 3 kapanmış bardan birinde SAR fiyatın altına geçip
    //          orada kaldıysa (içinde bulunulan bar hariç) +1
    (function () {
      if (n < 6) return;
      const sar = calcPSAR(highs, lows, 0.02, 0.2);
      let flipped = false;
      for (let i = n - 4; i <= n - 2; i++) {
        if (i < 1 || sar[i] === null || sar[i - 1] === null) continue;
        const justBelow = sar[i - 1] >= closes[i - 1] && sar[i] < closes[i];
        if (!justBelow) continue;
        let held = true;
        for (let j = i; j <= n - 2; j++) {
          if (sar[j] === null || sar[j] >= closes[j]) { held = false; break; }
        }
        if (held) { flipped = true; break; }
      }
      if (flipped) vote(1, 'Parabolik SAR', 'Son 3 kapanmış barda SAR fiyatın altına geçip altında kaldı (yükseliş).');
    })();
    // Ekran kutuları için RSI hâlâ hesaplansın (puana katılmıyor)
    const rsiS = calcRSISeries(closes, 14); const rsiV = rsiS.filter(x => x !== null); const rsi = rsiV.length ? rsiV[rsiV.length - 1] : 0;

    return {
      ticker, price: parseFloat(price.toFixed(2)),
      total: parseFloat(total.toFixed(2)),
      breakdown
    };
  } catch (e) { return null; }
}
app.get('/analyze-ozel/:ticker', async (req, res) => {
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'application/json' };
  const tf = req.query.tf || '1d';
  const result = await quickScoreOzel(req.params.ticker.toUpperCase(), headers, tf);
  if (!result) return res.status(500).json({ error: 'Hisse bulunamadı veya yeterli veri yok' });
  res.json(result);
});

app.get('/scan-ozel', async (req, res) => {
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'application/json' };
  const tf = req.query.tf || '1d';
  const results = [];
  for (let i = 0; i < BIST100.length; i += 5) {
    const chunk = BIST100.slice(i, i + 5);
    const part = await Promise.all(chunk.map(t => quickScoreOzel(t, headers, tf)));
    part.forEach(p => { if (p) results.push(p); });
  }
  results.sort((a, b) => b.total - a.total);
  res.json({ count: results.length, results });
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sunucu çalışıyor: ${PORT}`));
