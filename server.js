// השוואת מחירים - חנויות ישראליות + עליאקספרס
const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = process.env.PORT || 3000;
const SERPAPI_KEY = process.env.SERPAPI_KEY || '';
const MAX_STORES = 10;

// ---------- עזרים ----------
const cache = new Map(); // חיסכון בקריאות API
const TTL = 1000 * 60 * 30;
async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.v;
  const v = await fn();
  cache.set(key, { v, t: Date.now() });
  return v;
}

function parseShipping(item) {
  const txt = [item.delivery, item.shipping, ...(item.extensions || [])].filter(Boolean).join(' ');
  if (!txt) return { text: 'לא צוין באתר', cost: null };
  if (/חינם|free/i.test(txt)) return { text: 'משלוח חינם', cost: 0 };
  const m = txt.match(/(\d+(?:\.\d+)?)/);
  return { text: txt, cost: m ? Number(m[1]) : null };
}

// ---------- ספק נתונים: SerpAPI Google Shopping (ישראל) ----------
async function serp(params) {
  const url = new URL('https://serpapi.com/search.json');
  Object.entries({ ...params, api_key: SERPAPI_KEY }).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url);
  if (!r.ok) throw new Error('SerpAPI ' + r.status);
  return r.json();
}

async function searchIsrael(q) {
  const data = await serp({ engine: 'google_shopping', q, gl: 'il', hl: 'iw', google_domain: 'google.co.il' });
  const seen = new Set();
  const out = [];
  for (const it of data.shopping_results || []) {
    const store = it.source || 'חנות';
    if (seen.has(store) || /aliexpress/i.test(store)) continue; // חנות אחת לכל תוצאה, עד 10 חנויות
    seen.add(store);
    const ship = parseShipping(it);
    const price = it.extracted_price ?? null;
    out.push({
      title: it.title, store, image: it.thumbnail, link: it.product_link || it.link,
      price, priceText: it.price, shipping: ship.text, shippingCost: ship.cost,
      total: price != null ? price + (ship.cost || 0) : null, rating: it.rating || null
    });
    if (out.length >= MAX_STORES) break;
  }
  return out;
}

// השוואה מול עליאקספרס - לפי שם המוצר (שלב 1). שלב 2: לפי תמונה.
async function searchAli(q) {
  const link = 'https://he.aliexpress.com/wholesale?SearchText=' + encodeURIComponent(q);
  try {
    const data = await serp({ engine: 'google_shopping', q: q + ' aliexpress', gl: 'il', hl: 'iw', google_domain: 'google.co.il' });
    const items = (data.shopping_results || []).filter(i => /aliexpress/i.test(i.source || '')).slice(0, 5)
      .map(it => ({ title: it.title, store: 'AliExpress', image: it.thumbnail, link: it.product_link || it.link,
        price: it.extracted_price ?? null, priceText: it.price, ...(() => { const s = parseShipping(it); return { shipping: s.text, shippingCost: s.cost }; })() }));
    return { items, searchLink: link };
  } catch (e) { return { items: [], searchLink: link }; }
}

// ---------- מצב הדגמה (בלי מפתח API) ----------
function svg(color, label) {
  const s = `<svg xmlns='http://www.w3.org/2000/svg' width='300' height='300'><rect width='300' height='300' fill='${color}'/><text x='150' y='160' font-size='28' text-anchor='middle' fill='white' font-family='Arial'>${label}</text></svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(s);
}
function demo(q) {
  const stores = ['מחסני תאורה', 'דיל תאורה', 'IKEA', 'KSP', 'הום סנטר', 'לד מרקט', 'ארכה', 'אייס', 'זאפ תאורה', 'מגה תאורה'];
  const colors = ['#c0392b', '#2980b9', '#f1c40f', '#27ae60', '#e67e22', '#8e44ad', '#16a085', '#34495e', '#d35400', '#7f8c8d'];
  const items = stores.map((s, i) => {
    const price = 89 + i * 23; const cost = i % 3 === 0 ? 0 : 29;
    return { title: q + ' - דגם ' + (i + 1), store: s, image: svg(colors[i], s), link: '#', price, priceText: '₪' + price,
      shipping: cost ? 'משלוח ₪' + cost : 'משלוח חינם', shippingCost: cost, total: price + cost, rating: 4 + (i % 10) / 10 };
  });
  const ali = { items: [{ title: q + ' (עליאקספרס)', store: 'AliExpress', image: svg('#e62e04', 'AliExpress'), link: '#', price: 34, priceText: '₪34', shipping: 'משלוח חינם (14-30 ימים)', shippingCost: 0 }],
    searchLink: 'https://he.aliexpress.com/wholesale?SearchText=' + encodeURIComponent(q) };
  return { items, ali };
}

// ---------- API + קבצים סטטיים ----------
async function handleSearch(q) {
  if (!q) return [400, { error: 'חסר מונח חיפוש' }];
  try {
    if (!SERPAPI_KEY) return [200, { mode: 'demo', query: q, ...demo(q) }];
    const result = await cached('s:' + q, async () => {
      const [items, ali] = await Promise.all([searchIsrael(q), searchAli(q)]);
      return { items, ali };
    });
    return [200, { mode: 'live', query: q, ...result }];
  } catch (e) {
    console.error(e);
    return [502, { error: 'שגיאה בשליפת התוצאות: ' + e.message }];
  }
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/search') {
    const [code, body] = await handleSearch((u.searchParams.get('q') || '').trim());
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(body));
  }
  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
  }
  res.writeHead(404); res.end('not found');
}).listen(PORT, () => console.log('running on ' + PORT + (SERPAPI_KEY ? ' (live)' : ' (demo mode)')));
