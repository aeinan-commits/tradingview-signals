const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Sinyalleri hafızada tutuyoruz
let signals = [];

// TradingView webhook buraya gönderecek
app.post('/webhook', (req, res) => {
  const signal = {
    id: Date.now(),
    ticker: req.body.ticker || 'Bilinmiyor',
    price: req.body.price || 0,
    message: req.body.message || '',
    time: new Date().toLocaleString('tr-TR')
  };
  signals.unshift(signal);
  if (signals.length > 100) signals.pop(); // Son 100 sinyal
  console.log('Yeni sinyal:', signal);
  res.json({ status: 'ok' });
});

// Uygulama sinyalleri buradan çekiyor
app.get('/signals', (req, res) => {
  res.json(signals);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sunucu çalışıyor: ${PORT}`));
