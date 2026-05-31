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

app.get('/signals', (req, res) => {
  res.json(signals);
});

function ema(arr, period) {
  if (arr.length < period) period = arr.length;
  const k = 2 / (period + 1);
  let emaVal = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < arr.length; i++) {
    emaVal = arr[i] * k + emaVal * (1 - k);
  }
  return emaVal;
}

function calcRSI(closes, period) {
  if (closes.length < period + 1) period = closes.length - 1;
  let gains = 0, losses = 0;
  // İlk ortalama
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses += Math.abs(diff);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  // Wilder smoothing
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  const rs = avgGain / (avgLoss || 0.0001);
  return 100 - (100 / (1 + rs));
}

function priceVolSignal(closes, vols, days, avgVol20) {
  const len = closes.length;
  if (len <= days) days = len - 1;
  const priceNow = closes[len - 1];
  const priceThen = closes[len - 1 - days];
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

// 1 saatlik veriyi 4 saatliğe çevir
function resampleTo4h(closes, vols) {
  const newCloses = [], newVols = [];
  for (let i = 0; i < closes.length; i += 4) {
    const chunk = closes.slice(i, i + 4);
    const vchunk = vols.slice(i, i + 4);
    if (chunk.length === 0) continue;
    newCloses.push(chunk[chunk.length - 1]); // son kapanış
    newVols.push(vchunk.reduce((a, b) => a + b, 0)); // toplam hacim
  }
  return { closes: newCloses, vols: newVols };
}

const TF_CONFIG = {
  '15m': { interval: '15m', range: '60d' },
  '1h':  { interval: '1h',  range: '730d' },
  '4h':  { interval: '1h',  range: '730d', resample: true },
  '1d':  { interval: '1d',  range: '5y' },
  '1wk': { interval: '1wk', range: '10y' },
  '1mo': { interval: '1mo', range: 'max' }
};

app.get('/analyze/:ticker', async (req, res) => {
  try {
    const ticker = req.params.ticker.toUpperCase() + '.IS';
    const tickerClean = req.params.ticker.toUpperCase();
    const tf = req.query.tf || '1d';
    const cfg = TF_CONFIG[tf] || TF_CONFIG['1d'];

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json'
    };

    const chartRes = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${cfg.interval}&range=${cfg.range}&events=div%2Csplit`, { headers });
    const chartData = await chartRes.json();

    if (!chartData.chart || !chartData.chart.result || !chartData.chart.result[0]) {
      return res.status(500).json({ error: 'Hisse bulunamadı: ' + ticker });
    }

    const meta = chartData.chart.result[0].meta;
    const quote = chartData.chart.result[0].indicators.quote[0];
    let valid = quote.close.map((p, i) => ({ p, v: quote.volume[i] })).filter(x => x.p !== null && x.v !== null);
    let closes = valid.map(x => x.p);
    let vols = valid.map(x => x.v);

    // 4 saatlik için resample
    if (cfg.resample) {
      const r = resampleTo4h(closes, vols);
      closes = r.closes;
      vols = r.vols;
    }

    if (closes.length < 10) {
      return res.status(500).json({ error: 'Bu zaman dilimi için yeterli veri yok' });
    }

    const currentPrice = closes[closes.length - 1];
    const currentVol = vols[vols.length - 1];

    // EMA
    const periods = [5, 20, 50, 100, 200];
    const mas = periods.map(p => {
      const value = ema(closes, p);
      const diff = ((currentPrice - value) / value) * 100;
      return { period: p, value: parseFloat(value.toFixed(2)), above: currentPrice > value, diff: parseFloat(diff.toFixed(2)) };
    });

    // RSI (14)
    const rsi = calcRSI(closes, 14);

    // HACİM
    const avgVol20 = vols.slice(-20).reduce((a, b) => a + b, 0) / Math.min(vols.length, 20);
    const avgVol5 = vols.slice(-5).reduce((a, b) => a + b, 0) / Math.min(vols.length, 5);
    const volRatio = currentVol / avgVol20;

    const priceVol = {
      d1: priceVolSignal(closes, vols, 1, avgVol20),
      d5: priceVolSignal(closes, vols, 5, avgVol20),
      d20: priceVolSignal(closes, vols, 20, avgVol20)
    };

    const volTrendPct = ((avgVol5 - avgVol20) / avgVol20) * 100;
    let volTrend;
    if (volTrendPct > 15) volTrend = 'rising';
    else if (volTrendPct < -15) volTrend = 'falling';
    else volTrend = 'stable';

    const last50Vols = vols.slice(-50);
    const max50Vol = Math.max(...last50Vols);
    const volPosPct = (currentVol / max50Vol) * 100;

    // OBV
    let obv = 0;
    const obvSeries = [0];
    for (let i = 1; i < closes.length; i++) {
      if (closes[i] > closes[i - 1]) obv += vols[i];
      else if (closes[i] < closes[i - 1]) obv -= vols[i];
      obvSeries.push(obv);
    }
    const obvNow = obvSeries[obvSeries.length - 1];
    const obv20Ago = obvSeries[obvSeries.length - 21] || obvSeries[0];
    const obvRising = obvNow > obv20Ago;
    const price20Ago = closes[closes.length - 21] || closes[0];
    const priceRising20 = currentPrice > price20Ago;
    let obvSignal;
    if (obvRising && priceRising20) obvSignal = 'confirm_up';
    else if (!obvRising && !priceRising20) obvSignal = 'confirm_down';
    else if (obvRising && !priceRising20) obvSignal = 'bull_div';
    else obvSignal = 'bear_div';

    res.json({
      ticker: tickerClean,
      timeframe: tf,
      currentPrice: parseFloat(currentPrice.toFixed(2)),
      mas,
      rsi: parseFloat(rsi.toFixed(1)),
      volume: {
        current: currentVol,
        avg20: Math.round(avgVol20),
        avg5: Math.round(avgVol5),
        ratio: parseFloat(volRatio.toFixed(2)),
        priceVol,
        trend: volTrend,
        trendPct: parseFloat(volTrendPct.toFixed(1)),
        posPct: parseFloat(volPosPct.toFixed(0)),
        max50: Math.round(max50Vol),
        obvSignal,
        obvRising
      }
    });

  } catch (err) {
    console.log('Hata:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sunucu çalışıyor: ${PORT}`));
