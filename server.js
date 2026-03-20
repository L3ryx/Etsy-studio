require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const FormData = require('form-data');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── Proxy image
app.get('/proxy-image', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('Missing url');
  try {
    const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
    res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
    res.send(Buffer.from(response.data));
  } catch { res.status(502).send('Image fetch failed'); }
});

// ── Health
app.get('/api/health', (req, res) => res.json({ ok: true }));

// ── ETSY OAUTH — Step 1 : redirect
app.get('/api/etsy/auth', (req, res) => {
  const clientId = process.env.ETSY_CLIENT_ID;
  if (!clientId) return res.status(500).json({ error: 'ETSY_CLIENT_ID missing' });
  const redirectUri = process.env.ETSY_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/etsy/callback`;
  const scopes = 'listings_w listings_r';
  const state = Math.random().toString(36).slice(2);
  const url = `https://www.etsy.com/oauth/connect?response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes)}&client_id=${clientId}&state=${state}&code_challenge_method=S256&code_challenge=`;
  // Simple PKCE — in production use a proper code_verifier
  res.redirect(url);
});

// ── ETSY OAUTH — Step 2 : callback
app.get('/api/etsy/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code');
  try {
    const redirectUri = process.env.ETSY_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/etsy/callback`;
    const r = await axios.post('https://api.etsy.com/v3/public/oauth/token', {
      grant_type: 'authorization_code',
      client_id: process.env.ETSY_CLIENT_ID,
      redirect_uri: redirectUri,
      code,
      code_verifier: 'placeholder', // à remplacer par vrai PKCE
    });
    const { access_token, refresh_token } = r.data;
    res.redirect(`/?token=${access_token}&refresh=${refresh_token}`);
  } catch (e) {
    res.status(500).send('OAuth error: ' + (e.response?.data ? JSON.stringify(e.response.data) : e.message));
  }
});

// ── ETSY — Get shop info
app.get('/api/etsy/me', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const r = await axios.get('https://openapi.etsy.com/v3/application/users/me', {
      headers: { 'Authorization': `Bearer ${token}`, 'x-api-key': process.env.ETSY_CLIENT_ID }
    });
    res.json(r.data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

// ── GEMINI — Generate description + tags from title + images
app.post('/api/generate', upload.array('images', 10), async (req, res) => {
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY missing' });
  const { title, category } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });

  try {
    const parts = [];

    // Ajouter les images en base64
    if (req.files && req.files.length > 0) {
      for (const file of req.files.slice(0, 3)) {
        parts.push({
          inline_data: {
            mime_type: file.mimetype,
            data: file.buffer.toString('base64')
          }
        });
      }
    }

    parts.push({
      text: `You are an expert Etsy SEO copywriter. Analyze the product images and title below, then generate optimized content for an Etsy listing.

Product title: "${title}"
Category: "${category || 'General'}"

Generate the following in JSON format:
{
  "description": "A compelling 150-200 word product description in English. Start with the most important keywords. Include: what it is, materials/process, dimensions if visible, use cases, perfect for who. Use line breaks for readability. End with a call to action.",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5", "tag6", "tag7", "tag8", "tag9", "tag10", "tag11", "tag12", "tag13"]
}

Rules for tags:
- Exactly 13 tags
- Each tag max 20 characters
- Mix: specific product terms, materials, style, occasion, recipient
- Optimize for Etsy SEO search volume
- English only
- No brand names
- Use multi-word phrases when possible (e.g. "personalized gift" not just "gift")

Respond ONLY with the JSON, no explanation, no markdown.`
    });

    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { contents: [{ parts }] },
      { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
    );

    const raw = (r.data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
    const clean = raw.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);

    if (!result.description || !result.tags) throw new Error('Invalid Gemini response');
    if (result.tags.length !== 13) result.tags = result.tags.slice(0, 13);

    res.json(result);
  } catch (e) {
    console.error('Gemini error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── IMGBB — Upload image
app.post('/api/upload-image', upload.single('image'), async (req, res) => {
  if (!process.env.IMGBB_API_KEY) return res.status(500).json({ error: 'IMGBB_API_KEY missing' });
  if (!req.file) return res.status(400).json({ error: 'No file' });
  try {
    const form = new FormData();
    form.append('key', process.env.IMGBB_API_KEY);
    form.append('image', req.file.buffer.toString('base64'));
    const r = await axios.post('https://api.imgbb.com/1/upload', form, {
      headers: form.getHeaders(), timeout: 20000
    });
    res.json({ url: r.data.data.url, deleteUrl: r.data.data.delete_url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ETSY — Create listing
app.post('/api/etsy/listing', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });

  const { shopId, title, description, tags, price, quantity, images } = req.body;
  if (!shopId || !title || !description || !tags || !price) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // 1. Créer le listing
    const listingData = {
      quantity: quantity || 1,
      title,
      description,
      price: parseFloat(price),
      who_made: 'i_did',
      when_made: 'made_to_order',
      taxonomy_id: 1,
      tags: tags.slice(0, 13),
      state: 'draft', // draft d'abord, activer ensuite
      shipping_profile_id: null,
    };

    const listingRes = await axios.post(
      `https://openapi.etsy.com/v3/application/shops/${shopId}/listings`,
      listingData,
      { headers: { 'Authorization': `Bearer ${token}`, 'x-api-key': process.env.ETSY_CLIENT_ID, 'Content-Type': 'application/json' } }
    );

    const listingId = listingRes.data.listing_id;

    // 2. Uploader les images si présentes
    if (images && images.length > 0) {
      for (let i = 0; i < Math.min(images.length, 10); i++) {
        try {
          const imgRes = await axios.get(images[i], { responseType: 'arraybuffer' });
          const form = new FormData();
          form.append('image', Buffer.from(imgRes.data), { filename: `image_${i}.jpg`, contentType: 'image/jpeg' });
          form.append('rank', i + 1);
          await axios.post(
            `https://openapi.etsy.com/v3/application/shops/${shopId}/listings/${listingId}/images`,
            form,
            { headers: { ...form.getHeaders(), 'Authorization': `Bearer ${token}`, 'x-api-key': process.env.ETSY_CLIENT_ID } }
          );
        } catch (imgErr) {
          console.warn(`Image ${i} upload failed:`, imgErr.message);
        }
      }
    }

    res.json({ ok: true, listingId, url: `https://www.etsy.com/listing/${listingId}` });
  } catch (e) {
    console.error('Etsy listing error:', e.response?.data || e.message);
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`✅ Etsy Studio running on http://localhost:${PORT}`));
