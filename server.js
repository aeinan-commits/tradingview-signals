const fetch = require('node-fetch');
const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const ALPHA_KEY = '4FO7QHSOROV1J3XV';
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
    const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${ticker}&outputsize=full&apikey=${ALPHA_KEY}`;

    const response = await fetch(url);
    const data = await response.json();

    console.log('Alpha yanıtı:', JSON.stringify(data).substring(0, 300));

    if (data['Note'] || data['Information']) {
      return res.status(500).json({ error: 'API limit aşıldı, biraz bekleyin' });
    }

    if (!data['Time Series (Daily)']) {
      return res.status(500).json({ error: 'Hisse bulunamadı: ' + ticker });
    }

    const series = data['Time Series (Daily)'];
    const dates = Object.keys(series).sort();
    const closes = dates.map(d => parseFloat(series[d]['4. close']));
    const volumes = dates.map(d => parseFloat(series[d]['5. volume']));

    const currentPrice = closes[closes.length - 1];
    const currentVol = volumes[volumes.length - 1];

    const ma200arr = closes.slice(-200);
    const ma200 = ma200arr.reduce((a, b) => a + b, 0) / ma200arr.length;

    const ma50arr = closes.slice(-50);
    const ma50 = ma50arr.reduce((a, b) => a + b, 0) / ma50arr.length;

    const rsiArr = closes.slice(-15);
    let gains = 0, losses = 0;
    for (let i = 1; i < rsiArr.length; i++) {
      const diff = rsiArr[i] - rsiArr[i - 1];
      if (diff > 0) gains += diff;
      else losses += Math.abs(diff);
    }
    const rsi = 100 - (100 / (1 + gains / (losses || 1)));

    const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;

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
