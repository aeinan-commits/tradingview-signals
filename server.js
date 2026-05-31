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

// Fiyat+Hacim ilişkisini belirli bir periyot için hesapla
function priceVolSignal(closes, vols, days, avgVol20) {
  const len = closes.length;
  // Fiyat yönü: bugün vs 'days' gün önce
  const priceNow = closes[len - 1];
  const priceThen = closes[len - 1 - days];
  const priceUp = priceNow > priceThen;
  const pricePct = ((priceNow - priceThen) / priceThen) * 100;

  // Hacim: son 'days' gün ortalaması vs 20 günlük ortalama
  const recentVolAvg = vols.slice(-days).reduce((a, b) => a + b, 0) / days;
  const volAboveAvg = recentVolAvg > avgVol20;

  let signal;
  if (priceUp && volAboveAvg) signal = 'strong_up';
  else if (priceUp && !volAboveAvg) signal = 'weak_up';
  else if (!priceUp && volAboveAvg) signal = 'strong_down';
  else signal = 'weak_down';

  return {
    signal,
    priceUp,
    pricePct: parseFloat(pricePct.toFixed(2)),
    volAboveAvg,
    recentVolAvg: Math.round(recentVolAvg)
  };
}

app.get('/analyze/:ticker', async (req, res) => {
  try {
    const ticker = req.params.ticker.toUpperCase() + '.IS';
    const tickerClean = req.params.ticker.toUpperCase();
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json'
    };

    const chartRes = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=5y&events=div%2Csplit`, { headers });
    const chartData = await chartRes.json();

    if (!chartData.chart || !chartData.chart.result || !chartData.chart.result[0]) {
      return res.status(500).json({ error: 'Hisse bulunamadı: ' + ticker });
    }

    const meta = chartData.chart.result[0].meta;
    const quote = chartData.chart.result[0].indicators.quote[0];
    const valid = quote.close.map((p, i) => ({ p, v: quote.volume[i] })).filter(x => x.p !== null && x.v !== null);
    const closes = valid.map(x => x.p);
    const vols = valid.map(x => x.v);
    const currentPrice = closes[closes.length - 1];
    const currentVol = vols[vols.length - 1];

    // EMA
    const periods = [5, 20, 50, 100, 200];
    const mas = periods.map(p => {
      const value = ema(closes, p);
      const diff = ((currentPrice - value) / value) * 100;
      return {
        period: p,
        value: parseFloat(value.toFixed(2)),
        above: currentPrice > value,
        diff: parseFloat(diff.toFixed(2))
      };
    });

    // RSI
    const rsiArr = closes.slice(-15);
    let gains = 0, losses = 0;
    for (let i = 1; i < rsiArr.length; i++) {
      const diff = rsiArr[i] - rsiArr[i - 1];
      if (diff > 0) gains += diff;
      else losses += Math.abs(diff);
    }
    const rsi = 100 - (100 / (1 + gains / (losses || 1)));

    // ===== HACİM =====
    const avgVol20 = vols.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const avgVol5 = vols.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const volRatio = currentVol / avgVol20;

    // Fiyat+Hacim ilişkisi - üç periyot için
    const priceVol = {
      d1: priceVolSignal(closes, vols, 1, avgVol20),
      d5: priceVolSignal(closes, vols, 5, avgVol20),
      d20: priceVolSignal(closes, vols, 20, avgVol20)
    };

    // Hacim trendi
    const volTrendPct = ((avgVol5 - avgVol20) / avgVol20) * 100;
    let volTrend;
    if (volTrendPct > 15) volTrend = 'rising';
    else if (volTrendPct < -15) volTrend = 'falling';
    else volTrend = 'stable';

    const week52High = meta.fiftyTwoWeekHigh || null;
    const week52Low = meta.fiftyTwoWeekLow || null;

    res.json({
      ticker: tickerClean,
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
        trendPct: parseFloat(volTrendPct.toFixed(1))
      },
      week52High: week52High ? parseFloat(week52High.toFixed(2)) : null,
      week52Low: week52Low ? parseFloat(week52Low.toFixed(2)) : null
    });

  } catch (err) {
    console.log('Hata:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sunucu çalışıyor: ${PORT}`));
