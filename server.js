import express from 'express';
import https from 'https';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const PDF_URL = 'https://hub.masoncountywa.gov/sheriff/reports/incustdy.pdf';

// Serve static files
app.use(express.static('public'));

// Status endpoint
app.get('/api/status', (req, res) => {
  res.json({
    status: 'active',
    lastCheck: new Date().toISOString(),
    nextCheck: 'Every 6 hours'
  });
});

// Check roster endpoint
app.get('/api/check-roster', async (req, res) => {
  try {
    const response = await fetch(PDF_URL);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const hash = crypto.createHash('md5').update(buffer).digest('hex');
    
    res.json({
      success: true,
      message: 'PDF check successful!',
      timestamp: new Date().toISOString(),
      hash: hash.substring(0, 12),
      size: `${(buffer.length / 1024).toFixed(2)} KB`
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});