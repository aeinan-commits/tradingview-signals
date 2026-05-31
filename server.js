const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let signals = [];

// Webhook endpoint
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

// Hisse analiz endpoint
app.get('/analyze/:ticker', async (req, res) => {
  try {
    const ticker = req.params.ticker.toUpperCase() + '.IS';
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1y`;
    
    const response = await fetch(url);
    const data = await response.json();
    
    const prices = data.chart.result[0].indicators.quote[0].close;
    const volumes = data.chart.result[0].indicators.quote[0].volume;
    const timestamps = data.chart.result[0].timestamp;
    
    // Geçerli verileri filtrele
    const valid = prices.map((p, i) => ({ p, v: volumes[i], t: timestamps[i] })).filter(x => x.p !== null);
    
    const closes = valid.map(x => x.p);
    const vols = valid.map(x => x.v);
    const currentPrice = closes[closes.length - 1];
    const currentVol = vols[vols.length - 1];

    // MA200
    const ma200closes = closes.slice(-200);
    const ma200 = ma200closes.reduce((a, b) => a + b, 0) / ma200closes.length;

    // MA50
    const ma50closes = closes.slice(-50);
    const ma50 = ma50closes.reduce((a, b) => a + b, 0) / ma50closes.length;

    // RSI 14
    const rsiPrices = closes.slice(-15);
    let gains = 0, losses = 0;
    for (let i = 1; i < rsiPrices.length; i++) {
      const diff = rsiPrices[i] - rsiPrices[i - 1];
      if (diff > 0) gains += diff;
      else losses += Math.abs(diff);
    }
    const rs = gains / (losses || 1);
    const rsi = 100 - (100 / (1 + rs));

    // Hacim ortalaması (20 gün)
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
    res.status(500).json({ error: 'Hisse bulunamadı veya veri alınamadı' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sunucu çalışıyor: ${PORT}`));
