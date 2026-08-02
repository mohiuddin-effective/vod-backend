const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Cloudflare Stream - Generate Direct Upload URL using Global API Key
app.post('/api/videos/upload-url', async (req, res) => {
  try {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiKey = process.env.CLOUDFLARE_API_KEY;
    const email = process.env.CLOUDFLARE_EMAIL;

    if (!accountId || !apiKey || !email) {
      return res.status(500).json({
        error: "Cloudflare credentials missing (Account ID, API Key, or Email)"
      });
    }

    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/direct_upload`, {
      method: 'POST',
      headers: {
        'X-Auth-Email': email.trim(),
        'X-Auth-Key': apiKey.trim(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        maxDurationSeconds: 3600,
        creator: 'admin'
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: "Cloudflare API Error",
        details: data
      });
    }

    res.json({
      uploadURL: data.result.uploadURL,
      videoId: data.result.uid
    });
  } catch (err) {
    res.status(500).json({ error: "Internal Server Error", details: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
