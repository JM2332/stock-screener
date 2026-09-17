const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const webpush = require("web-push");

admin.initializeApp();
const db = admin.firestore();

const FMP_API_KEY = defineSecret("FMP_API_KEY");
const FINNHUB_API_KEY = defineSecret("FINNHUB_API_KEY");
const VAPID_PRIVATE_KEY = defineSecret("VAPID_PRIVATE_KEY");
// Public counterpart is not secret — it's embedded in app.js and required by
// pushManager.subscribe(). Keep these two in sync if ever regenerated.
const VAPID_PUBLIC_KEY = "BNK0LglRw3lW_dj_p4D9bjVm-0_RjCoPE5brxdmWx5yQ2_TnC7OkigbL5G_kboXKdQLVyYkzF0cJyKRyDj9MvrA";
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
  "transcript-dates": (t) => `/earning-call-transcript-dates?symbol=${t}`,
};

// sector-pe-snapshot is keyed by exchange+date, not by ticker, so it's worth
// caching across requests within a warm instance — many tickers share an
// exchange, and the value only changes once a day. Keeps this fair-value
// method from burning extra FMP quota on every ticker search.
const sectorPeCache = new Map(); // exchange -> { fetchedAt, rows }
const SECTOR_PE_TTL_MS = 60 * 60 * 1000;

let marketNewsCache = null; // { fetchedAt, body } — same feed for every visitor
const MARKET_NEWS_TTL_MS = 10 * 60 * 1000;

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

// ---------- Curated screener ----------
// FMP's real screener endpoint turned out to be paid-only (402 on the live
// key) despite looking free-tier in the docs, and Finnhub has no screener
// endpoint at all (404). So this runs against a small hand-picked universe of
// well-known, liquid US tickers instead — sector is assigned here rather than
// trusted from an API (Finnhub's industry taxonomy is inconsistent), and
// name/sector cost nothing to fetch since they're already known.
const SCREENER_UNIVERSE = [
  ["AAPL", "Apple", "Technology"], ["MSFT", "Microsoft", "Technology"], ["NVDA", "NVIDIA", "Technology"],
  ["AVGO", "Broadcom", "Technology"], ["ORCL", "Oracle", "Technology"], ["CRM", "Salesforce", "Technology"],
  ["ADBE", "Adobe", "Technology"], ["AMD", "Advanced Micro Devices", "Technology"],
  ["UNH", "UnitedHealth Group", "Healthcare"], ["JNJ", "Johnson & Johnson", "Healthcare"], ["LLY", "Eli Lilly", "Healthcare"],
  ["ABBV", "AbbVie", "Healthcare"], ["MRK", "Merck", "Healthcare"], ["PFE", "Pfizer", "Healthcare"],
  ["TMO", "Thermo Fisher Scientific", "Healthcare"], ["ABT", "Abbott Laboratories", "Healthcare"],
  ["JPM", "JPMorgan Chase", "Financials"], ["BAC", "Bank of America", "Financials"], ["WFC", "Wells Fargo", "Financials"],
  ["GS", "Goldman Sachs", "Financials"], ["MS", "Morgan Stanley", "Financials"], ["V", "Visa", "Financials"],
  ["MA", "Mastercard", "Financials"], ["AXP", "American Express", "Financials"],
  ["AMZN", "Amazon", "Consumer Discretionary"], ["TSLA", "Tesla", "Consumer Discretionary"], ["HD", "Home Depot", "Consumer Discretionary"],
  ["MCD", "McDonald's", "Consumer Discretionary"], ["NKE", "Nike", "Consumer Discretionary"], ["SBUX", "Starbucks", "Consumer Discretionary"],
  ["LOW", "Lowe's", "Consumer Discretionary"], ["BKNG", "Booking Holdings", "Consumer Discretionary"],
  ["WMT", "Walmart", "Consumer Staples"], ["PG", "Procter & Gamble", "Consumer Staples"], ["KO", "Coca-Cola", "Consumer Staples"],
  ["PEP", "PepsiCo", "Consumer Staples"], ["COST", "Costco", "Consumer Staples"], ["PM", "Philip Morris International", "Consumer Staples"],
  ["MDLZ", "Mondelez International", "Consumer Staples"], ["CL", "Colgate-Palmolive", "Consumer Staples"],
  ["XOM", "Exxon Mobil", "Energy"], ["CVX", "Chevron", "Energy"], ["COP", "ConocoPhillips", "Energy"],
  ["SLB", "Schlumberger", "Energy"], ["EOG", "EOG Resources", "Energy"], ["MPC", "Marathon Petroleum", "Energy"],
  ["PSX", "Phillips 66", "Energy"], ["OXY", "Occidental Petroleum", "Energy"],
  ["CAT", "Caterpillar", "Industrials"], ["BA", "Boeing", "Industrials"], ["HON", "Honeywell", "Industrials"],
  ["UNP", "Union Pacific", "Industrials"], ["UPS", "United Parcel Service", "Industrials"], ["GE", "GE Aerospace", "Industrials"],
  ["LMT", "Lockheed Martin", "Industrials"], ["RTX", "RTX Corporation", "Industrials"],
  ["LIN", "Linde", "Materials"], ["SHW", "Sherwin-Williams", "Materials"], ["APD", "Air Products", "Materials"],
  ["FCX", "Freeport-McMoRan", "Materials"], ["NEM", "Newmont", "Materials"], ["ECL", "Ecolab", "Materials"],
  ["NUE", "Nucor", "Materials"], ["DOW", "Dow Inc", "Materials"],
  ["NEE", "NextEra Energy", "Utilities"], ["DUK", "Duke Energy", "Utilities"], ["SO", "Southern Company", "Utilities"],
  ["D", "Dominion Energy", "Utilities"], ["AEP", "American Electric Power", "Utilities"], ["EXC", "Exelon", "Utilities"],
  ["SRE", "Sempra", "Utilities"], ["XEL", "Xcel Energy", "Utilities"],
  ["PLD", "Prologis", "Real Estate"], ["AMT", "American Tower", "Real Estate"], ["EQIX", "Equinix", "Real Estate"],
  ["CCI", "Crown Castle", "Real Estate"], ["PSA", "Public Storage", "Real Estate"], ["SPG", "Simon Property Group", "Real Estate"],
  ["O", "Realty Income", "Real Estate"], ["WELL", "Welltower", "Real Estate"],
  ["GOOGL", "Alphabet", "Communication Services"], ["META", "Meta Platforms", "Communication Services"], ["NFLX", "Netflix", "Communication Services"],
  ["DIS", "Walt Disney", "Communication Services"], ["CMCSA", "Comcast", "Communication Services"], ["TMUS", "T-Mobile US", "Communication Services"],
  ["VZ", "Verizon Communications", "Communication Services"], ["T", "AT&T", "Communication Services"],
];
const SCREENER_SECTORS = [...new Set(SCREENER_UNIVERSE.map((r) => r[2]))];

const screenerCache = new Map(); // symbol -> { fetchedAt, quote, metrics }
const SCREENER_TTL_MS = 20 * 60 * 1000;

// Caps actual Finnhub call *rate* (not just in-flight concurrency) across a
// rolling 60s window. An unfiltered screen fires up to 176 calls (88 tickers
// x 2), and bounding concurrency alone doesn't stop that from blowing past
// Finnhub's free-tier 60/min cap over a few seconds — which would 429 every
// other feature in the app sharing the same key (home page, ticker pages,
// checkAlerts) for the rest of that minute, not just the screener itself.
// 50/min leaves some headroom for other concurrent app traffic. Note this
// window is per-service (api and warmScreenerCache each throttle
// independently, same reason the cache itself had to move to Firestore) —
// in the rare case both are genuinely hitting Finnhub at once, rather than
// one serving from the other's warmed Firestore cache, the combined rate
// could exceed 50/min. Not worth a cross-service counter for a personal app.
const SCREENER_RATE_LIMIT_PER_MIN = 50;
const screenerRequestTimes = [];

async function throttleScreenerRequests(count) {
  for (;;) {
    const cutoff = Date.now() - 60000;
    while (screenerRequestTimes.length && screenerRequestTimes[0] < cutoff) screenerRequestTimes.shift();
    if (screenerRequestTimes.length + count <= SCREENER_RATE_LIMIT_PER_MIN) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const now = Date.now();
  for (let i = 0; i < count; i++) screenerRequestTimes.push(now);
}

// Firestore-backed, not just in-memory: Functions v2 deploys `api` and
// `warmScreenerCache` as separate Cloud Run services, each with its own
// process, so an in-memory Map alone would mean the warming job populates a
// cache nobody else ever reads. Firestore is the layer that actually lets
// the warming job's fetches speed up real requests to `api`. The in-memory
// Map stays as a same-instance fast path so a warm `api` container doesn't
// re-read Firestore on every call within its own lifetime.
const SCREENER_CACHE_COLLECTION = "screenerCache";

async function getScreenerRow(symbol, finnhubKey) {
  const cached = screenerCache.get(symbol);
  if (cached && Date.now() - cached.fetchedAt < SCREENER_TTL_MS) return cached;

  try {
    const doc = await db.collection(SCREENER_CACHE_COLLECTION).doc(symbol).get();
    if (doc.exists) {
      const data = doc.data();
      if (data.fetchedAt && Date.now() - data.fetchedAt < SCREENER_TTL_MS) {
        screenerCache.set(symbol, data);
        return data;
      }
    }
  } catch (err) {
    console.error("screenerCache Firestore read failed:", err);
  }

  await throttleScreenerRequests(2);
  const [quoteRes, metricsRes] = await Promise.allSettled([
    fetch(`${FINNHUB_BASE}/quote?symbol=${symbol}&token=${finnhubKey}`).then((r) => (r.ok ? r.json() : null)),
    fetch(`${FINNHUB_BASE}/stock/metric?symbol=${symbol}&metric=all&token=${finnhubKey}`).then((r) => (r.ok ? r.json() : null)),
  ]);
  const entry = {
    fetchedAt: Date.now(),
    quote: quoteRes.status === "fulfilled" ? quoteRes.value : null,
    metrics: metricsRes.status === "fulfilled" && metricsRes.value ? metricsRes.value.metric : null,
  };
  // Only persist a genuine success. A transient Finnhub hiccup (a momentary
  // 5xx, a request cut short by this function's own timeout) otherwise gets
  // cached as if it were real data — real bug hit in practice: several
  // tickers were served as "—" for a full 20-minute TTL because one bad
  // fetch got frozen into the cache alongside all the good ones. Without
  // quote data there's nothing worth showing anyway, so skip caching and let
  // the next call (warming cycle or a live request) retry from scratch.
  if (entry.quote) {
    screenerCache.set(symbol, entry);
    db.collection(SCREENER_CACHE_COLLECTION).doc(symbol).set(entry).catch((err) => console.error("screenerCache Firestore write failed:", err));
  }
  return entry;
}

// Bounds concurrent in-flight requests so workers arrive at the rate
// throttle above gradually rather than all piling up on it at once.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
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

// timeoutSeconds bumped from the 60s default: a fully cold /screener request
// (no Firestore cache yet, e.g. right after this deploy, before
// warmScreenerCache's first scheduled run) can take several minutes under
// the Finnhub rate throttle. Every other endpoint here finishes in well
// under a second, so the higher ceiling doesn't change anything for them.
exports.api = onRequest({ secrets: [FMP_API_KEY, FINNHUB_API_KEY], cors: false, timeoutSeconds: 300 }, async (req, res) => {
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

    if (endpoint === "market-news") {
      // General financial/business news, not tied to any one ticker —
      // Finnhub's free tier (confirmed live, not just from docs) under
      // category=general. Same value for every visitor, so a short
      // in-memory cache avoids re-hitting Finnhub on every home-page load.
      const cached = marketNewsCache;
      if (cached && Date.now() - cached.fetchedAt < MARKET_NEWS_TTL_MS) {
        return res.status(200).json(cached.body);
      }
      const upstream = await fetch(`${FINNHUB_BASE}/news?category=general&token=${FINNHUB_API_KEY.value()}`);
      if (!upstream.ok) return res.status(upstream.status).json({ error: "market news unavailable" });
      const body = await upstream.json();
      marketNewsCache = { fetchedAt: Date.now(), body };
      return res.status(200).json(body);
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

    if (endpoint === "fh-earnings-calendar") {
      // Free, uncapped on Finnhub — replaces what would otherwise be another
      // FMP quota hit for "next earnings date."
      if (!ticker || !/^[A-Za-z0-9.\-]{1,10}$/.test(ticker)) {
        return res.status(400).json({ error: "invalid or missing ticker" });
      }
      const t = ticker.toUpperCase();
      const from = new Date();
      const to = new Date(from.getTime() + 180 * 24 * 60 * 60 * 1000);
      const iso = (d) => d.toISOString().slice(0, 10);
      const url = `${FINNHUB_BASE}/calendar/earnings?symbol=${t}&from=${iso(from)}&to=${iso(to)}&token=${FINNHUB_API_KEY.value()}`;
      const upstream = await fetch(url);
      const body = await upstream.text();
      return res.status(upstream.status).set("Content-Type", "application/json").send(body);
    }

    if (endpoint === "transcript") {
      // Full earnings call transcript for one specific quarter — a real
      // payload (can be 10,000+ words), so this is fetched on demand only
      // (the client fetches transcript-dates first, cheaply, and only pulls
      // a transcript's content when the user picks a specific quarter).
      if (!ticker || !/^[A-Za-z0-9.\-]{1,10}$/.test(ticker)) {
        return res.status(400).json({ error: "invalid or missing ticker" });
      }
      const year = req.query.year;
      const quarter = req.query.quarter;
      if (!year || !quarter || !/^\d{4}$/.test(year) || !/^\d$/.test(quarter)) {
        return res.status(400).json({ error: "missing or invalid year/quarter" });
      }
      await fetchFmp(`/earning-call-transcript?symbol=${ticker.toUpperCase()}&year=${year}&quarter=${quarter}`, res);
      return;
    }

    if (endpoint === "screener-meta") {
      return res.status(200).json({ sectors: SCREENER_SECTORS });
    }

    if (endpoint === "screener") {
      const sector = req.query.sector || null;
      const candidates = sector ? SCREENER_UNIVERSE.filter((r) => r[2] === sector) : SCREENER_UNIVERSE;

      const rows = await mapWithConcurrency(candidates, 10, async ([symbol, name, sec]) => {
        const { quote, metrics } = await getScreenerRow(symbol, FINNHUB_API_KEY.value());
        return {
          symbol,
          name,
          sector: sec,
          price: quote && typeof quote.c === "number" ? quote.c : null,
          changePct: quote && typeof quote.dp === "number" ? quote.dp : null,
          marketCap: metrics && typeof metrics.marketCapitalization === "number" ? metrics.marketCapitalization : null,
          beta: metrics && typeof metrics.beta === "number" ? metrics.beta : null,
          dividendYield: metrics && typeof metrics.dividendYieldIndicatedAnnual === "number" ? metrics.dividendYieldIndicatedAnnual : null,
        };
      });

      const num = (v) => (v === undefined || v === "" ? null : parseFloat(v));
      const mcapMin = num(req.query.mcapMin);
      const mcapMax = num(req.query.mcapMax);
      const priceMin = num(req.query.priceMin);
      const priceMax = num(req.query.priceMax);
      const betaMin = num(req.query.betaMin);
      const betaMax = num(req.query.betaMax);
      const divMin = num(req.query.divMin);

      const filtered = rows.filter((r) => {
        if (mcapMin != null && !(r.marketCap >= mcapMin)) return false;
        if (mcapMax != null && !(r.marketCap <= mcapMax)) return false;
        if (priceMin != null && !(r.price >= priceMin)) return false;
        if (priceMax != null && !(r.price <= priceMax)) return false;
        if (betaMin != null && !(r.beta >= betaMin)) return false;
        if (betaMax != null && !(r.beta <= betaMax)) return false;
        if (divMin != null && !(r.dividendYield >= divMin)) return false;
        return true;
      });

      return res.status(200).json(filtered);
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

// Keeps the screener cache warm so an actual page load (a user opening the
// screener/popular-stocks view) almost always hits cache instead of
// triggering a cold fetch of all 88 tickers — which, throttled to 50
// Finnhub calls/min (see throttleScreenerRequests), would otherwise take
// several minutes on the very view meant to be a fast, default landing page.
// Runs a bit more often than the 20-min cache TTL so entries never fully
// expire between warmings. Long timeout because a fully cold run (176 calls
// at 50/min) genuinely takes minutes, not seconds.
exports.warmScreenerCache = onSchedule(
  { schedule: "every 15 minutes", secrets: [FINNHUB_API_KEY], timeoutSeconds: 300 },
  async () => {
    await mapWithConcurrency(SCREENER_UNIVERSE, 10, ([symbol]) => getScreenerRow(symbol, FINNHUB_API_KEY.value()));
  }
);

// Price alerts: runs every 15 minutes, checks each saved threshold against a
// live Finnhub quote, and pushes a notification the moment it's crossed —
// then deletes that one alert (fire-once, matching the client's manual
// remove-alert behaviour) so it doesn't re-notify on the next tick.
exports.checkAlerts = onSchedule(
  { schedule: "every 15 minutes", secrets: [FINNHUB_API_KEY, VAPID_PRIVATE_KEY] },
  async () => {
    const alertsSnap = await db.collection("alerts").doc("main").get();
    const alerts = alertsSnap.exists ? alertsSnap.data() : {};
    const tickers = Object.keys(alerts || {});
    if (!tickers.length) return;

    const subsSnap = await db.collection("pushSubscriptions").doc("main").get();
    const subs = subsSnap.exists ? (subsSnap.data().subscriptions || []) : [];
    if (!subs.length) return;

    webpush.setVapidDetails("mailto:jakemawby23@gmail.com", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY.value());

    const firedTickers = [];
    const deadEndpoints = [];

    for (const ticker of tickers) {
      const { direction, price: threshold } = alerts[ticker] || {};
      if (!direction || typeof threshold !== "number") continue;

      let quote;
      try {
        const res = await fetch(`${FINNHUB_BASE}/quote?symbol=${ticker}&token=${FINNHUB_API_KEY.value()}`);
        if (!res.ok) continue;
        quote = await res.json();
      } catch {
        continue;
      }
      const price = quote && quote.c;
      if (typeof price !== "number" || !price) continue;

      const crossed = direction === "above" ? price >= threshold : price <= threshold;
      if (!crossed) continue;

      firedTickers.push(ticker);
      const payload = JSON.stringify({
        title: `${ticker} ${direction === "above" ? "rose above" : "fell below"} $${threshold}`,
        body: `Now trading at $${price.toFixed(2)}`,
        url: `/?ticker=${ticker}`,
      });

      for (const sub of subs) {
        try {
          await webpush.sendNotification(sub, payload);
        } catch (err) {
          // 404/410 = the browser/device unsubscribed or expired; anything
          // else is a transient delivery failure worth leaving alone.
          if (err.statusCode === 404 || err.statusCode === 410) deadEndpoints.push(sub.endpoint);
        }
      }
    }

    if (firedTickers.length) {
      const update = {};
      for (const t of firedTickers) update[t] = admin.firestore.FieldValue.delete();
      await db.collection("alerts").doc("main").set(update, { merge: true });
    }
    if (deadEndpoints.length) {
      const stillGood = subs.filter((s) => !deadEndpoints.includes(s.endpoint));
      await db.collection("pushSubscriptions").doc("main").set({ subscriptions: stillGood });
    }
  }
);
