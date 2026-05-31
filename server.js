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

app.get('/analyze/:ticker', async (req, res) => {
  try {
    const ticker = req.params.ticker.toUpperCase() + '.IS';
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1y`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      }
    });

    const data = await response.json();

    if (!data.chart || !data.chart.result || !data.chart.result[0]) {
      return res.status(500).json({ error: 'Hisse bulunamadı: ' + ticker });
    }

    const quote = data.chart.result[0].indicators.quote[0];
    const timestamps = data.chart.result[0].timestamp;

    const valid = quote.close.map((p, i) => ({
      p, v: quote.volume[i]
    })).filter(x => x.p !== null && x.v !== null);

    const closes = valid.map(x => x.p);
    const vols = valid.map(x => x.v);
    const currentPrice = closes[closes.length - 1];
    const currentVol = vols[vols.length - 1];

    const ma200 = closes.slice(-200).reduce((a, b) => a + b, 0) / Math.min(closes.length, 200);
    const ma50 = closes.slice(-50).reduce((a, b) => a + b, 0) / Math.min(closes.length, 50);

    const rsiArr = closes.slice(-15);
    let gains = 0, losses = 0;
    for (let i = 1; i < rsiArr.length; i++) {
      const diff = rsiArr[i] - rsiArr[i - 1];
      if (diff > 0) gains += diff;
      else losses += Math.abs(diff);
    }
    const rsi = 100 - (100 / (1 + gains / (losses || 1)));

    const avgVol = vols.slice(-20).reduce((a, b) => a + b, 0) / 20;

    res.json({
      ticker: req.params.ticker.toUpperCase(),
      currentPrice: currentPrice.toFixed(2),
      ma200: ma200.toFixed(2),
      ma50: ma50.toFixed(2),
      rsi: rsi.toFixed(1),
      currentVol,
      avgVol: Math.round(avgVol),
      aboveMA200: currentPrice > ma200,
      aboveMA50: currentPrice > ma50,
      highVolume: currentVol > avgVol,
      veryHighVolume: currentVol > avgVol * 2
    });

  } catch (err) {
    console.log('Hata:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sunucu çalışıyor: ${PORT}`));
