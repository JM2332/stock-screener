const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

const FMP_API_KEY = defineSecret("FMP_API_KEY");
const FMP_BASE = "https://financialmodelingprep.com/stable";

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
};

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

exports.api = onRequest({ secrets: [FMP_API_KEY], cors: false }, async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  const parts = req.path.split("/").filter(Boolean); // e.g. ["quote", "AAPL"]
  const [endpoint, ticker] = parts;

  try {
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
