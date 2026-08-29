const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

const FMP_API_KEY = defineSecret("FMP_API_KEY");
const FINNHUB_API_KEY = defineSecret("FINNHUB_API_KEY");
const FMP_BASE = "https://financialmodelingprep.com/stable";
const FINNHUB_BASE = "https://finnhub.io/api/v1";

// Whitelisted endpoint templates against FMP's current "stable" API.
// {ticker} is substituted from the request path; everything else is fixed
// or passed through, so this can't become an open relay for arbitrary paths.
const ENDPOINTS = {
  quote: (t) => `/quote?symbol=${t}`,
  profile: (t) => `/profile?symbol=${t}`,
  dcf: (t) => `/discounted-cash-flow?symbol=${t}`,
  "ratings-snapshot": (t) => `/ratings-snapshot?symbol=${t}`,
  "grades-consensus": (t) => `/grades-consensus?symbol=${t}`,
  grades: (t) => `/grades?symbol=${t}`,
  "price-target": (t) => `/price-target-consensus?symbol=${t}`,
  estimates: (t) => `/analyst-estimates?symbol=${t}&period=annual&limit=8`,
  "balance-sheet": (t) => `/balance-sheet-statement?symbol=${t}&limit=5`,
  "income-statement": (t) => `/income-statement?symbol=${t}&limit=5`,
  "cash-flow": (t) => `/cash-flow-statement?symbol=${t}&limit=5`,
  ratios: (t) => `/ratios?symbol=${t}&limit=5`,
  "key-metrics": (t) => `/key-metrics?symbol=${t}&limit=1`,
};

// sector-pe-snapshot is keyed by exchange+date, not by ticker, so it's worth
// caching across requests within a warm instance — many tickers share an
// exchange, and the value only changes once a day. Keeps this fair-value
// method from burning extra FMP quota on every ticker search.
const sectorPeCache = new Map(); // exchange -> { fetchedAt, rows }
const SECTOR_PE_TTL_MS = 60 * 60 * 1000;

const ALLOWED_ORIGINS = new Set([
  "https://jm2332.github.io",
  "http://localhost:8127",
  "http://127.0.0.1:8127",
]);

function setCors(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.has(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
  }
  res.set("Access-Control-Allow-Methods", "GET");
  res.set("Access-Control-Allow-Headers", "Content-Type");
}

async function fetchFmp(path, res) {
  const url = FMP_BASE + path + (path.includes("?") ? "&" : "?") + `apikey=${FMP_API_KEY.value()}`;
  const upstream = await fetch(url);
  const body = await upstream.text();
  res.status(upstream.status).set("Content-Type", "application/json").send(body);
}

exports.api = onRequest({ secrets: [FMP_API_KEY, FINNHUB_API_KEY], cors: false }, async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  const parts = req.path.split("/").filter(Boolean); // e.g. ["quote", "AAPL"]
  const [endpoint, ticker] = parts;

  try {
    if (endpoint === "news") {
      if (!ticker || !/^[A-Za-z0-9.\-]{1,10}$/.test(ticker)) {
        return res.status(400).json({ error: "invalid or missing ticker" });
      }
      const to = new Date();
      const from = new Date(to.getTime() - 14 * 24 * 60 * 60 * 1000);
      const iso = (d) => d.toISOString().slice(0, 10);
      const url = `${FINNHUB_BASE}/company-news?symbol=${ticker.toUpperCase()}&from=${iso(from)}&to=${iso(to)}&token=${FINNHUB_API_KEY.value()}`;
      const upstream = await fetch(url);
      const body = await upstream.text();
      return res.status(upstream.status).set("Content-Type", "application/json").send(body);
    }

    // Finnhub-backed "core" data — quote/profile/basic ratios/recommendation
    // trends all work on Finnhub's free tier for effectively any US-listed
    // ticker (no per-symbol whitelist like FMP has), so these carry the hero
    // card and give it something to show even for tickers FMP itself blocks.
    if (endpoint === "fh-quote" || endpoint === "fh-profile" || endpoint === "fh-metrics" || endpoint === "fh-recommendation") {
      if (!ticker || !/^[A-Za-z0-9.\-]{1,10}$/.test(ticker)) {
        return res.status(400).json({ error: "invalid or missing ticker" });
      }
      const t = ticker.toUpperCase();
      const path = {
        "fh-quote": `/quote?symbol=${t}`,
        "fh-profile": `/stock/profile2?symbol=${t}`,
        "fh-metrics": `/stock/metric?symbol=${t}&metric=all`,
        "fh-recommendation": `/stock/recommendation?symbol=${t}`,
      }[endpoint];
      const url = `${FINNHUB_BASE}${path}&token=${FINNHUB_API_KEY.value()}`;
      const upstream = await fetch(url);
      const body = await upstream.text();
      return res.status(upstream.status).set("Content-Type", "application/json").send(body);
    }

    if (endpoint === "sector-pe") {
      const sector = req.query.sector;
      const exchange = req.query.exchange;
      if (!sector || !exchange) return res.status(400).json({ error: "missing sector or exchange param" });

      const cached = sectorPeCache.get(exchange);
      let rows = cached && Date.now() - cached.fetchedAt < SECTOR_PE_TTL_MS ? cached.rows : null;

      if (!rows) {
        // Free tier only has a short recent window and weekends/holidays
        // have no snapshot, so walk back a few days for the last trading day.
        for (let i = 0; i <= 3 && !rows; i++) {
          const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
          const iso = d.toISOString().slice(0, 10);
          const url = `${FMP_BASE}/sector-pe-snapshot?date=${iso}&exchange=${encodeURIComponent(exchange)}&apikey=${FMP_API_KEY.value()}`;
          const upstream = await fetch(url);
          if (!upstream.ok) continue;
          const body = await upstream.json().catch(() => []);
          if (Array.isArray(body) && body.length) rows = body;
        }
        if (rows) sectorPeCache.set(exchange, { fetchedAt: Date.now(), rows });
      }

      const match = rows && rows.find((r) => r.sector === sector);
      return res.status(200).json(match || null);
    }

    if (endpoint === "search") {
      const q = req.query.q;
      if (!q) return res.status(400).json({ error: "missing q param" });
      const encoded = encodeURIComponent(q);
      // Symbol search covers tickers; fall back to name search only when it
      // draws a blank, so a typical ticker lookup costs one FMP call, not two.
      const symbolUrl = `${FMP_BASE}/search-symbol?query=${encoded}&limit=10&apikey=${FMP_API_KEY.value()}`;
      const symbolRes = await fetch(symbolUrl);
      const symbolBody = await symbolRes.json().catch(() => []);
      if (!symbolRes.ok) {
        return res.status(symbolRes.status).json(symbolBody);
      }
      if (Array.isArray(symbolBody) && symbolBody.length) {
        return res.status(200).json(symbolBody);
      }
      const nameUrl = `${FMP_BASE}/search-name?query=${encoded}&limit=10&apikey=${FMP_API_KEY.value()}`;
      const nameRes = await fetch(nameUrl);
      const nameBody = await nameRes.text();
      return res.status(nameRes.status).set("Content-Type", "application/json").send(nameBody);
    }

    if (!ENDPOINTS[endpoint]) {
      return res.status(404).json({ error: "unknown endpoint" });
    }
    if (!ticker || !/^[A-Za-z0-9.\-]{1,10}$/.test(ticker)) {
      return res.status(400).json({ error: "invalid or missing ticker" });
    }
    await fetchFmp(ENDPOINTS[endpoint](ticker.toUpperCase()), res);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "upstream fetch failed" });
  }
});
