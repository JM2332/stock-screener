const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

const FMP_API_KEY = defineSecret("FMP_API_KEY");
const FINNHUB_API_KEY = defineSecret("FINNHUB_API_KEY");
const FMP_BASE = "https://financialmodelingprep.com/stable";
const FINNHUB_BASE = "https://finnhub.io/api/v1";

// Whitelisted endpoint templates against FMP's current "stable" API.
// {ticker} is substituted from the request path; everything else is fixed
// or passed through, so this can't become an open relay for arbitrary paths.
// DCF, Graham Number, financial statements, and ratios all moved off FMP
// (see fh-metrics/DIY calc client-side, and sec-financials below) — what's
// left here is what genuinely has no free unlimited alternative anywhere:
// FMP's own quant rating, latest analyst grade action, price targets, and
// forward estimates.
const ENDPOINTS = {
  quote: (t) => `/quote?symbol=${t}`,
  profile: (t) => `/profile?symbol=${t}`,
  "ratings-snapshot": (t) => `/ratings-snapshot?symbol=${t}`,
  grades: (t) => `/grades?symbol=${t}`,
  "price-target": (t) => `/price-target-consensus?symbol=${t}`,
  estimates: (t) => `/analyst-estimates?symbol=${t}&period=annual&limit=8`,
};

// sector-pe-snapshot is keyed by exchange+date, not by ticker, so it's worth
// caching across requests within a warm instance — many tickers share an
// exchange, and the value only changes once a day. Keeps this fair-value
// method from burning extra FMP quota on every ticker search.
const sectorPeCache = new Map(); // exchange -> { fetchedAt, rows }
const SECTOR_PE_TTL_MS = 60 * 60 * 1000;

// SEC EDGAR — free, unlimited (no key, just a descriptive User-Agent per
// their fair-access policy), and the original source FMP/Finnhub both build
// their own numbers from. Used for balance sheet/income/cash flow statements
// so those tabs stop depending on FMP's 250/day quota entirely.
const SEC_UA = "stock-screener-personal-project (contact: jakemawby23@gmail.com)";
const SEC_BASE = "https://data.sec.gov";

let cikMap = null;
let cikMapFetchedAt = 0;
const CIK_MAP_TTL_MS = 24 * 60 * 60 * 1000;

async function ensureCikMap() {
  if (cikMap && Date.now() - cikMapFetchedAt < CIK_MAP_TTL_MS) return cikMap;
  const res = await fetch("https://www.sec.gov/files/company_tickers.json", { headers: { "User-Agent": SEC_UA } });
  if (!res.ok) return cikMap; // keep serving a stale map rather than nothing, if SEC hiccups
  const body = await res.json();
  const map = new Map();
  Object.values(body).forEach((v) => map.set(String(v.ticker).toUpperCase(), String(v.cik_str).padStart(10, "0")));
  cikMap = map;
  cikMapFetchedAt = Date.now();
  return map;
}

const companyFactsCache = new Map(); // cik -> { fetchedAt, facts }
const FACTS_TTL_MS = 6 * 60 * 60 * 1000;

async function getCompanyFacts(cik) {
  const cached = companyFactsCache.get(cik);
  if (cached && Date.now() - cached.fetchedAt < FACTS_TTL_MS) return cached.facts;
  const res = await fetch(`${SEC_BASE}/api/xbrl/companyfacts/CIK${cik}.json`, { headers: { "User-Agent": SEC_UA } });
  if (!res.ok) return null;
  const facts = await res.json();
  companyFactsCache.set(cik, { fetchedAt: Date.now(), facts });
  return facts;
}

// Companies tag the same real-world concept with different XBRL tags
// depending on their filing history — e.g. Apple's "Revenues" tag only has
// data through FY2018, before they switched to
// "RevenueFromContractWithCustomerExcludingAssessedTax". Taking the first
// candidate tag with ANY data (rather than merging all of them) silently
// drops recent years whenever a company has switched tags, so every
// candidate is merged into one series instead, keyed by the exact period end
// date (not SEC's "fy" field, which reflects which filing disclosed a value,
// not which period it covers — a 10-K routinely re-discloses prior years as
// comparatives under its own fy, which would misalign them against other
// line items' fiscal years if used as the join key).
function extractSeries(facts, tags) {
  const gaap = facts && facts.facts && facts.facts["us-gaap"];
  if (!gaap) return [];
  const merged = new Map(); // period-end date -> entry
  for (const tag of tags) {
    const concept = gaap[tag];
    const units = concept && concept.units && (concept.units.USD || concept.units["USD/shares"]);
    if (!units) continue;
    const annual = units.filter((e) => {
      if (e.form !== "10-K" || e.fp !== "FY") return false;
      if (!e.start || !e.end) return true; // instant fact (balance sheet) — no duration to check
      const days = (new Date(e.end) - new Date(e.start)) / 86400000;
      return days > 340; // excludes quarterly comparatives disclosed inside the same 10-K
    });
    for (const e of annual) {
      const existing = merged.get(e.end);
      if (!existing || (e.filed || "") > (existing.filed || "")) merged.set(e.end, e);
    }
  }
  return [...merged.entries()].map(([end, e]) => ({ end, val: e.val })).sort((a, b) => (a.end < b.end ? 1 : -1));
}

const SEC_LINE_ITEMS = {
  balanceSheet: [
    ["totalAssets", ["Assets"]],
    ["totalLiabilities", ["Liabilities"]],
    ["totalStockholdersEquity", ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"]],
    ["cashAndCashEquivalents", ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"]],
  ],
  incomeStatement: [
    ["revenue", ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet"]],
    ["grossProfit", ["GrossProfit"]],
    ["operatingIncome", ["OperatingIncomeLoss"]],
    ["netIncome", ["NetIncomeLoss"]],
    ["eps", ["EarningsPerShareDiluted", "EarningsPerShareBasic"]],
  ],
  cashFlow: [
    ["operatingCashFlow", ["NetCashProvidedByUsedInOperatingActivities"]],
    ["capitalExpenditure", ["PaymentsToAcquirePropertyPlantAndEquipment"]],
    ["netDividendsPaid", ["PaymentsOfDividends", "PaymentsOfDividendsCommonStock"]],
  ],
};

function buildStatement(facts, items) {
  const seriesByKey = {};
  for (const [key, tags] of items) {
    seriesByKey[key] = new Map(extractSeries(facts, tags).map((s) => [s.end, s.val]));
  }
  let bestKey = items[0][0];
  for (const [key] of items) {
    if (seriesByKey[key].size > seriesByKey[bestKey].size) bestKey = key;
  }
  const ends = [...seriesByKey[bestKey].keys()].sort().reverse().slice(0, 5);
  return ends.map((end) => {
    const row = { fiscalYear: String(new Date(end).getFullYear()) };
    for (const [key] of items) {
      const v = seriesByKey[key].get(end);
      row[key] = v === undefined ? null : v;
    }
    return row;
  });
}

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

    if (endpoint === "sec-financials") {
      if (!ticker || !/^[A-Za-z0-9.\-]{1,10}$/.test(ticker)) {
        return res.status(400).json({ error: "invalid or missing ticker" });
      }
      const map = await ensureCikMap();
      const cik = map && map.get(ticker.toUpperCase());
      if (!cik) return res.status(404).json({ error: "no SEC filer found for this ticker" });
      const facts = await getCompanyFacts(cik);
      if (!facts) return res.status(502).json({ error: "SEC data unavailable" });

      const balanceSheet = buildStatement(facts, SEC_LINE_ITEMS.balanceSheet);
      const incomeStatement = buildStatement(facts, SEC_LINE_ITEMS.incomeStatement);
      const cashFlow = buildStatement(facts, SEC_LINE_ITEMS.cashFlow).map((row) => {
        // XBRL reports capex/dividends as positive payment amounts; flip to
        // negative (cash outflow) to match how the app displays cash flow.
        if (row.capitalExpenditure != null) row.capitalExpenditure = -Math.abs(row.capitalExpenditure);
        if (row.netDividendsPaid != null) row.netDividendsPaid = -Math.abs(row.netDividendsPaid);
        if (row.operatingCashFlow != null && row.capitalExpenditure != null) row.freeCashFlow = row.operatingCashFlow + row.capitalExpenditure;
        return row;
      });

      return res.status(200).json({ balanceSheet, incomeStatement, cashFlow });
    }

    if (endpoint === "history") {
      // Price charts — Finnhub's candle endpoint is paid-only on the free
      // tier (confirmed via direct test, 403), but FMP's free tier does
      // include EOD historical price data, so this stays on FMP (counted
      // against the 250/day quota, ~1 call per range switch).
      if (!ticker || !/^[A-Za-z0-9.\-]{1,10}$/.test(ticker)) {
        return res.status(400).json({ error: "invalid or missing ticker" });
      }
      const days = { "1m": 30, "6m": 182, "1y": 365, "5y": 365 * 5 }[req.query.range] || 365;
      const to = new Date();
      const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
      const iso = (d) => d.toISOString().slice(0, 10);
      await fetchFmp(`/historical-price-eod/light?symbol=${ticker.toUpperCase()}&from=${iso(from)}&to=${iso(to)}`, res);
      return;
    }

    if (endpoint === "search") {
      // Runs on Finnhub, not FMP — it has no daily cap (unlike FMP's 250/day,
      // which search used to share with every other call and could go down
      // with the rest of the app), and its one endpoint already matches by
      // both symbol and company name, where FMP needed two separate calls.
      const q = req.query.q;
      if (!q) return res.status(400).json({ error: "missing q param" });

      const runFinnhubSearch = async (query) => {
        const url = `${FINNHUB_BASE}/search?q=${encodeURIComponent(query)}&token=${FINNHUB_API_KEY.value()}`;
        const upstream = await fetch(url);
        const body = await upstream.json().catch(() => null);
        return { ok: upstream.ok, status: upstream.status, body };
      };

      let result = await runFinnhubSearch(q);
      // Finnhub's search doesn't reliably match a hyphenated official name
      // against a space-separated query — "rolls royce" finds nothing, but
      // "rolls-royce" finds Rolls-Royce Holdings PLC. Retry once with spaces
      // collapsed onto hyphens before giving up.
      if (result.ok && (!result.body || !result.body.result || !result.body.result.length) && q.includes(" ")) {
        result = await runFinnhubSearch(q.replace(/\s+/g, "-"));
      }

      if (!result.ok || !result.body) {
        return res.status(result.status || 502).json(result.body || { error: "search failed" });
      }
      const results = (result.body.result || []).slice(0, 10).map((r) => ({ symbol: r.symbol, name: r.description, type: r.type }));
      return res.status(200).json(results);
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
