const API_BASE = "https://us-central1-stock-screener-kml.cloudfunctions.net/api";

const $ = (sel) => document.querySelector(sel);
const searchInput = $("#search-input");
const searchResults = $("#search-results");
const emptyState = $("#empty-state");
const stockView = $("#stock-view");

let searchDebounce = null;
let activeSearchIndex = -1;
let currentSearchItems = [];

async function api(path) {
  bumpUsage();
  return rawApi(path);
}

// Everything sourced from Finnhub or SEC EDGAR (news, quote/profile/basic
// ratios/recommendation trends, financial statements, search) runs through
// here instead of api() — both are free and effectively uncapped, and
// Finnhub covers tickers FMP's free tier blocks outright, so these calls
// deliberately don't touch the FMP usage pill.
async function freeApi(path) {
  return rawApi(path);
}

async function rawApi(path) {
  const res = await fetch(`${API_BASE}/${path}`);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error((body && body.error) || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

// ---------- FMP free-tier usage tracker (250 calls/day) ----------

const FMP_DAILY_LIMIT = 250;
const USAGE_KEY = "fmp_usage_v1";

function todayStr() {
  return new Date().toDateString();
}

function getUsage() {
  try {
    const raw = JSON.parse(localStorage.getItem(USAGE_KEY));
    if (raw && raw.date === todayStr()) return raw;
  } catch {}
  return { date: todayStr(), count: 0 };
}

function bumpUsage() {
  const usage = getUsage();
  usage.count += 1;
  try {
    localStorage.setItem(USAGE_KEY, JSON.stringify(usage));
  } catch {}
  renderUsage(usage.count);
}

function renderUsage(count) {
  const el = $("#usage-pill");
  if (!el) return;
  el.textContent = `${count} / ${FMP_DAILY_LIMIT} today`;
  el.classList.toggle("usage-warn", count >= FMP_DAILY_LIMIT * 0.8 && count < FMP_DAILY_LIMIT);
  el.classList.toggle("usage-over", count >= FMP_DAILY_LIMIT);
}

renderUsage(getUsage().count);

// ---------- Search ----------

searchInput.addEventListener("input", () => {
  const q = searchInput.value.trim();
  clearTimeout(searchDebounce);
  if (!q) {
    hideSearchResults();
    return;
  }
  searchDebounce = setTimeout(() => runSearch(q), 250);
});

searchInput.addEventListener("keydown", (e) => {
  if (searchResults.classList.contains("hidden")) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    activeSearchIndex = Math.min(activeSearchIndex + 1, currentSearchItems.length - 1);
    highlightSearchRow();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    activeSearchIndex = Math.max(activeSearchIndex - 1, 0);
    highlightSearchRow();
  } else if (e.key === "Enter") {
    if (activeSearchIndex >= 0 && currentSearchItems[activeSearchIndex]) {
      selectTicker(currentSearchItems[activeSearchIndex].symbol);
    }
  } else if (e.key === "Escape") {
    hideSearchResults();
  }
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-wrap")) hideSearchResults();
});

function hideSearchResults() {
  searchResults.classList.add("hidden");
  searchResults.innerHTML = "";
  activeSearchIndex = -1;
  currentSearchItems = [];
}

function highlightSearchRow() {
  [...searchResults.children].forEach((el, i) => el.classList.toggle("active", i === activeSearchIndex));
}

async function runSearch(q) {
  let items;
  try {
    items = await freeApi(`search?q=${encodeURIComponent(q)}`);
  } catch {
    searchResults.innerHTML = `<div class="search-empty">Search failed — try again</div>`;
    searchResults.classList.remove("hidden");
    return;
  }
  currentSearchItems = Array.isArray(items) ? items : [];
  activeSearchIndex = -1;
  if (!currentSearchItems.length) {
    searchResults.innerHTML = `<div class="search-empty">No matches</div>`;
    searchResults.classList.remove("hidden");
    return;
  }
  searchResults.innerHTML = currentSearchItems
    .map(
      (it) => `
      <div class="search-row" data-symbol="${it.symbol}">
        <span class="search-row-symbol">${it.symbol}</span>
        <span class="search-row-name">${it.name || ""}</span>
        <span class="search-row-exch">${it.type === "Common Stock" ? "" : it.type || ""}</span>
      </div>`
    )
    .join("");
  searchResults.classList.remove("hidden");
  searchResults.querySelectorAll(".search-row").forEach((row) => {
    row.addEventListener("click", () => selectTicker(row.dataset.symbol));
  });
}

function selectTicker(symbol) {
  searchInput.value = symbol;
  hideSearchResults();
  loadTicker(symbol);
}

// ---------- Loading a ticker ----------

function loadTicker(symbol) {
  emptyState.classList.add("hidden");
  stockView.classList.remove("hidden");
  setLoadingStates();

  // Reset per-ticker financials state synchronously, before any async loader
  // below gets a chance to run — otherwise a Financials tab click landing
  // mid-load could read or write into the previous ticker's cache.
  currentSymbol = symbol;
  finCache = {};
  activeFinTab = "balance";
  [...$("#fin-tabs").children].forEach((b) => b.classList.toggle("active", b.dataset.tab === "balance"));
  chartCache = {};
  activeRange = "1y";
  [...$("#range-tabs").children].forEach((b) => b.classList.toggle("active", b.dataset.range === "1y"));

  // Finnhub + SEC EDGAR "core" data — quote/profile/basic ratios/
  // recommendation trends/financial statements — works for effectively any
  // US-listed ticker, free and with no daily cap. This is what actually
  // carries the page now; FMP fills in the extras that genuinely have no
  // free unlimited alternative (sector P/E, price targets, forward
  // estimates) on a best-effort basis that can fail outright for a ticker
  // FMP doesn't cover without taking the rest of the page down with it.
  const fhQuotePromise = freeApi(`fh-quote/${symbol}`);
  const fhProfilePromise = freeApi(`fh-profile/${symbol}`);
  const fhMetricsPromise = freeApi(`fh-metrics/${symbol}`);
  const fhRecPromise = freeApi(`fh-recommendation/${symbol}`);
  const secPromise = freeApi(`sec-financials/${symbol}`);

  const fmpQuotePromise = api(`quote/${symbol}`);
  const fmpProfilePromise = api(`profile/${symbol}`);
  const priceTargetPromise = api(`price-target/${symbol}`);

  loadHero(symbol, fhQuotePromise, fhProfilePromise, fhMetricsPromise, fmpQuotePromise);
  loadChart(symbol);
  loadFairValue(symbol, fhQuotePromise, fhMetricsPromise, fmpQuotePromise, fmpProfilePromise, priceTargetPromise);
  loadRatings(symbol, fhRecPromise, priceTargetPromise);
  loadFinancials(symbol, secPromise, fhMetricsPromise);
  loadNews(symbol);
}

function setLoadingStates() {
  $("#s-name").textContent = "Loading…";
  $("#s-symbol").textContent = "—";
  $("#s-exchange").textContent = "—";
  $("#s-sector").textContent = "—";
  $("#s-price").textContent = "—";
  $("#s-change").textContent = "";
  $("#s-change").className = "hero-change";
  $("#s-stats").innerHTML = "";
  $("#chart-body").innerHTML = `<div class="spinner-line">Loading…</div>`;
  $("#fv-body").innerHTML = `<div class="spinner-line">Loading…</div>`;
  $("#ratings-body").innerHTML = `<div class="spinner-line">Loading…</div>`;
  $("#fin-body").innerHTML = `<div class="spinner-line">Loading…</div>`;
  $("#news-body").innerHTML = `<div class="spinner-line">Loading…</div>`;
}

function fmtNum(n, opts = {}) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return Number(n).toLocaleString(undefined, opts);
}

function fmtBig(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e12) return (n / 1e12).toFixed(2) + "T";
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
  return fmtNum(n);
}

// Finnhub's profile exchange field is a messy long form ("NASDAQ NMS - GLOBAL
// MARKET", "NEW YORK STOCK EXCHANGE, INC.") — normalize the common ones for
// display; anything unrecognized just falls back to the raw string.
function normalizeExchange(raw) {
  if (!raw) return "—";
  const upper = raw.toUpperCase();
  if (upper.includes("NASDAQ")) return "NASDAQ";
  if (upper.includes("NEW YORK STOCK EXCHANGE") || upper.startsWith("NYSE")) return "NYSE";
  return raw;
}

// ---------- Hero ----------
// Sourced entirely from Finnhub now — it covers effectively any US-listed
// ticker for free, unlike FMP's curated whitelist, so the hero card (and
// the app generally) no longer fails outright for a ticker FMP doesn't
// cover. "Volume" (today's, not the 3-month average) is the one stat FMP
// still uniquely provides for free, so it's fetched best-effort and shown
// as "—" rather than blocking the rest of the card if FMP doesn't have it.

async function loadHero(symbol, fhQuotePromise, fhProfilePromise, fhMetricsPromise, fmpQuotePromise) {
  try {
    const [quote, profile, metrics] = await Promise.all([fhQuotePromise, fhProfilePromise, fhMetricsPromise]);
    const m = (metrics && metrics.metric) || {};

    if (!quote || quote.c === undefined || quote.c === null) {
      $("#s-name").textContent = "Not found";
      return;
    }

    $("#s-name").textContent = (profile && profile.name) || symbol;
    $("#s-symbol").textContent = symbol;
    $("#s-exchange").textContent = normalizeExchange(profile && profile.exchange);
    $("#s-sector").textContent = (profile && profile.finnhubIndustry) || "—";
    $("#s-price").textContent = "$" + fmtNum(quote.c, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const change = quote.d;
    const changePct = quote.dp;
    const changeEl = $("#s-change");
    const up = change >= 0;
    changeEl.className = "hero-change " + (up ? "up" : "down");
    changeEl.textContent = `${up ? "+" : ""}${fmtNum(change, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${up ? "+" : ""}${fmtNum(changePct, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%)`;

    let fmpVolume = "—";
    try {
      const q = await fmpQuotePromise;
      if (q && q[0] && q[0].volume) fmpVolume = fmtBig(q[0].volume);
    } catch {
      // best-effort only — FMP may not cover this ticker at all
    }

    const stats = [
      ["Market Cap", profile && profile.marketCapitalization ? fmtBig(profile.marketCapitalization * 1e6) : "—"],
      ["P/E Ratio", m.peTTM ? fmtNum(m.peTTM, { maximumFractionDigits: 2 }) : "—"],
      ["EPS (TTM)", m.epsTTM ? "$" + fmtNum(m.epsTTM, { maximumFractionDigits: 2 }) : "—"],
      ["Day Range", quote.l && quote.h ? `$${fmtNum(quote.l, { maximumFractionDigits: 2 })} – $${fmtNum(quote.h, { maximumFractionDigits: 2 })}` : "—"],
      ["52W Range", m["52WeekLow"] && m["52WeekHigh"] ? `$${fmtNum(m["52WeekLow"], { maximumFractionDigits: 2 })} – $${fmtNum(m["52WeekHigh"], { maximumFractionDigits: 2 })}` : "—"],
      ["Volume", fmpVolume],
      ["Avg Volume (3mo)", m["3MonthAverageTradingVolume"] ? fmtBig(m["3MonthAverageTradingVolume"] * 1e6) : "—"],
      ["Open", quote.o ? "$" + fmtNum(quote.o, { maximumFractionDigits: 2 }) : "—"],
    ];
    $("#s-stats").innerHTML = stats
      .map(([label, value]) => `<div class="stat-item"><span class="stat-label">${label}</span><span class="stat-value">${value}</span></div>`)
      .join("");
  } catch (err) {
    // Finnhub's free tier reliably 403s on non-US-listed tickers (e.g. LSE's
    // RR.L for Rolls-Royce) — this tool is US-stocks-only for now, so that's
    // worth saying plainly rather than a generic "couldn't load" that reads
    // like a bug.
    $("#s-name").textContent = err.status === 403
      ? "Not a supported market — this tool covers US-listed stocks only"
      : "Couldn't load this ticker";
  }
}

// ---------- Price chart ----------
// Finnhub's candle endpoint is paid-only on the free tier, so this stays on
// FMP (counted against the 250/day quota — roughly 1 call per range viewed,
// cached per range so switching back to an already-viewed range is free).

let currentChartSymbol = null;
let activeRange = "1y";
let chartCache = {};

$("#range-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab-btn");
  if (!btn) return;
  activeRange = btn.dataset.range;
  [...$("#range-tabs").children].forEach((b) => b.classList.toggle("active", b === btn));
  renderChart();
});

async function loadChart(symbol) {
  currentChartSymbol = symbol;
  await fetchChartRange(activeRange);
  renderChart();
}

function fetchChartRange(range) {
  if (!chartCache[range]) {
    chartCache[range] = api(`history/${currentChartSymbol}?range=${range}`)
      .then((data) => ({ data, error: null }))
      .catch((err) => ({ data: null, error: err }));
  }
  return chartCache[range];
}

async function renderChart() {
  const el = $("#chart-body");
  const symbol = currentChartSymbol;
  const range = activeRange;
  el.innerHTML = `<div class="spinner-line">Loading…</div>`;
  const result = await fetchChartRange(range);
  if (symbol !== currentChartSymbol || range !== activeRange) return; // stale, ticker/range changed since

  if (result.error || !Array.isArray(result.data) || result.data.length < 2) {
    let msg = "Not enough price history available for this ticker.";
    if (result.error && result.error.status === 429) msg = fmpFailureNote("rate-limited");
    else if (result.error && (result.error.status === 402 || result.error.status === 403)) {
      msg = "Price history isn't available for this ticker on the free FMP plan.";
    }
    el.innerHTML = `<div class="muted-note">${msg}</div>`;
    return;
  }

  el.innerHTML = buildChartSvg(result.data);
}

function buildChartSvg(data) {
  const points = data.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  const prices = points.map((p) => p.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const first = prices[0];
  const last = prices[prices.length - 1];
  const changePct = ((last - first) / first) * 100;
  const up = changePct >= 0;
  const colorVar = up ? "var(--green)" : "var(--red)";

  const W = 700, H = 200, padX = 4, padY = 10;
  const spanRange = max - min || 1;
  const stepX = points.length > 1 ? (W - padX * 2) / (points.length - 1) : 0;
  const coords = prices.map((p, i) => {
    const x = padX + i * stepX;
    const y = padY + (H - padY * 2) * (1 - (p - min) / spanRange);
    return [x, y];
  });
  const linePath = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const areaPath = `${linePath} L${coords[coords.length - 1][0].toFixed(2)},${H - padY} L${coords[0][0].toFixed(2)},${H - padY} Z`;

  return `
    <div class="chart-summary">
      <span class="chart-price">$${fmtNum(last, { maximumFractionDigits: 2 })}</span>
      <span class="chart-change ${up ? "up" : "down"}">${up ? "+" : ""}${changePct.toFixed(2)}% over period</span>
    </div>
    <svg viewBox="0 0 ${W} ${H}" class="price-chart" preserveAspectRatio="none">
      <path d="${areaPath}" style="fill:${colorVar};opacity:0.1;stroke:none"></path>
      <path d="${linePath}" style="fill:none;stroke:${colorVar};stroke-width:2"></path>
    </svg>
    <div class="chart-dates"><span>${points[0].date}</span><span>${points[points.length - 1].date}</span></div>`;
}

// ---------- Fair value (multiple independent methods) ----------
// A single DCF read can be wildly off for growth stocks with thin current
// earnings (TSLA has read >1000% "overvalued" on DCF alone) since it's built
// entirely around projected cash flows. Showing several differently-grounded
// methods side by side — cash-flow, accounting-value, market-relative, and
// street-sentiment — gives a fuller picture than trusting any one number.

function verdictFor(diffPct) {
  if (diffPct > 8) return { verdict: "Overvalued", cls: "over" };
  if (diffPct < -8) return { verdict: "Undervalued", cls: "under" };
  return { verdict: "Fair", cls: "fair" };
}

// Graham Number and a simple 2-stage DCF, both computed from Finnhub's
// basic-financials (free tier, no daily cap) instead of FMP's paid-quota'd
// versions — these were the two fair-value methods most likely to be
// unavailable right when someone hits FMP's 250/day limit, so moving them
// off FMP entirely means Fair Value now shows at least two methods for
// *any* ticker, regardless of FMP's quota state.

function computeGrahamNumber(m) {
  if (!m || !(m.epsTTM > 0) || !(m.bookValuePerShareAnnual > 0)) return null;
  return Math.sqrt(22.5 * m.epsTTM * m.bookValuePerShareAnnual);
}

// 2-stage DCF: 5 years of free cash flow growing at a capped historical
// rate, discounted at a CAPM-derived rate, plus a discounted terminal value
// at a conservative 2.5% long-run growth. The growth cap (-5% to +15%/yr) is
// deliberately conservative — uncapped growth extrapolation is exactly what
// made FMP's own DCF read as wildly unreliable for volatile growth stocks.
function computeDiyDcf(price, m) {
  if (!m || !(m.pfcfShareTTM > 0)) return null;
  const fcfps = price / m.pfcfShareTTM;
  if (!(fcfps > 0) || typeof m.focfCagr5Y !== "number" || Number.isNaN(m.focfCagr5Y)) return null;
  const g1 = Math.max(-0.05, Math.min(0.15, m.focfCagr5Y / 100));
  const beta = typeof m.beta === "number" && m.beta > 0 ? m.beta : 1;
  const r = 0.045 + Math.max(0.5, Math.min(2, beta)) * 0.05; // CAPM: risk-free + beta × equity risk premium
  const g2 = 0.025;
  if (r <= g2) return null;
  let pv = 0;
  let fcf = fcfps;
  for (let t = 1; t <= 5; t++) {
    fcf *= 1 + g1;
    pv += fcf / Math.pow(1 + r, t);
  }
  pv += (fcf * (1 + g2)) / (r - g2) / Math.pow(1 + r, 5);
  return { value: pv, growthPct: g1 * 100, discountPct: r * 100 };
}

// Distinguishes "FMP doesn't cover this ticker" (402/403, permanent for that
// ticker) from "today's 250-call quota is used up" (429, temporary and
// nothing to do with which ticker this is) — very different messages for
// the user, so this shouldn't be flattened into one generic failure.
function fmpFailureKind(results) {
  const rejected = results.filter((r) => r.status === "rejected");
  if (!rejected.length) return null;
  if (rejected.some((r) => r.reason && r.reason.status === 429)) return "rate-limited";
  if (rejected.every((r) => r.reason && (r.reason.status === 402 || r.reason.status === 403))) return "blocked";
  return "error";
}

function fmpFailureNote(kind, fallback) {
  if (kind === "rate-limited") return "Today's free FMP quota (250 calls) is used up — this will come back once it resets.";
  return fallback;
}

async function loadFairValue(symbol, fhQuotePromise, fhMetricsPromise, fmpQuotePromise, fmpProfilePromise, priceTargetPromise) {
  const el = $("#fv-body");
  try {
    const [fhQuoteRes, fhMetricsRes, fmpQuoteRes, fmpProfileRes, ptRes] = await Promise.allSettled([
      fhQuotePromise,
      fhMetricsPromise,
      fmpQuotePromise,
      fmpProfilePromise,
      priceTargetPromise,
    ]);

    // Price always comes from Finnhub — it's guaranteed available and keeps
    // this card consistent with the hero, even when every FMP method below
    // fails outright for a ticker FMP doesn't cover.
    const price = fhQuoteRes.status === "fulfilled" && fhQuoteRes.value && fhQuoteRes.value.c;
    if (!price) {
      el.innerHTML = `<div class="muted-note">Fair value data isn't available for this ticker.</div>`;
      return;
    }

    const methods = [];
    const m = fhMetricsRes.status === "fulfilled" && fhMetricsRes.value && fhMetricsRes.value.metric;

    const dcf = computeDiyDcf(price, m);
    if (dcf) {
      methods.push({
        name: "DCF",
        value: dcf.value,
        note: `Our own 2-stage DCF from Finnhub's cash-flow data: ${dcf.growthPct.toFixed(1)}%/yr growth (capped -5% to +15%) for 5 years, ${dcf.discountPct.toFixed(1)}% discount rate (CAPM), 2.5% terminal growth. Simplified — treat as a starting point, not a target price.`,
      });
    }

    const graham = computeGrahamNumber(m);
    if (graham) {
      methods.push({
        name: "Graham Number",
        value: graham,
        note: "Conservative formula from earnings + book value. Tends to read low for asset-light or high-growth companies.",
      });
    }

    // Sector P/E still needs FMP's own sector/exchange taxonomy since
    // sector-pe-snapshot's category names have to match FMP's exactly —
    // Finnhub's industry strings don't line up with them.
    const eps = m && m.epsTTM;
    const profile = fmpProfileRes.status === "fulfilled" && fmpProfileRes.value[0];
    const sector = profile && profile.sector;
    const exchange = fmpQuoteRes.status === "fulfilled" && fmpQuoteRes.value[0] && fmpQuoteRes.value[0].exchange;
    if (eps && sector && exchange) {
      try {
        const sectorPe = await api(`sector-pe?sector=${encodeURIComponent(sector)}&exchange=${encodeURIComponent(exchange)}`);
        if (sectorPe && sectorPe.pe) {
          methods.push({
            name: `Sector P/E (${sector})`,
            value: eps * sectorPe.pe,
            note: `EPS × ${sector} sector average P/E (${sectorPe.pe.toFixed(1)}×) on ${exchange}. Reflects what similar companies currently trade at, not intrinsic worth.`,
          });
        }
      } catch {
        // sector-pe is a nice-to-have method; skip silently if it fails
      }
    }

    if (ptRes.status === "fulfilled" && ptRes.value && ptRes.value[0] && ptRes.value[0].targetConsensus) {
      methods.push({
        name: "Analyst Price Target",
        value: ptRes.value[0].targetConsensus,
        note: "Consensus of Wall Street 12-month price targets. Forward-looking, but reflects sentiment as much as fundamentals.",
      });
    }

    if (!methods.length) {
      const kind = fmpFailureKind([fmpQuoteRes, fmpProfileRes, ptRes]);
      const fallback = kind === "blocked"
        ? `Fair value methods aren't available for this ticker on the free FMP plan. Current price: $${fmtNum(price, { maximumFractionDigits: 2 })}.`
        : "Fair value data isn't available for this ticker.";
      el.innerHTML = `<div class="muted-note">${fmpFailureNote(kind, fallback)}</div>`;
      return;
    }

    const withDiff = methods.map((method) => ({ ...method, diffPct: ((price - method.value) / method.value) * 100 }));
    const verdicts = withDiff.map((m) => verdictFor(m.diffPct).verdict);
    const agreeCount = Math.max(...["Overvalued", "Undervalued", "Fair"].map((v) => verdicts.filter((x) => x === v).length));
    const majority = verdicts.find((v) => verdicts.filter((x) => x === v).length === agreeCount);
    const summaryLine = agreeCount === methods.length
      ? `All ${methods.length} method${methods.length > 1 ? "s" : ""} agree: potentially ${majority.toLowerCase()}`
      : `Mixed signal — ${agreeCount} of ${methods.length} methods lean ${majority.toLowerCase()}`;
    const headlineCls = agreeCount === methods.length ? verdictFor(withDiff[0].diffPct).cls : "fair";

    const rows = withDiff
      .map((m) => {
        const { verdict, cls } = verdictFor(m.diffPct);
        return `
        <div class="fv-method-row">
          <div class="fv-method-top">
            <span class="fv-method-name">${m.name}</span>
            <span class="fv-method-value">$${fmtNum(m.value, { maximumFractionDigits: 2 })}</span>
            <span class="fv-method-diff ${cls}">${m.diffPct > 0 ? "+" : ""}${m.diffPct.toFixed(1)}%</span>
          </div>
          <div class="fv-method-note">${m.note}</div>
        </div>`;
      })
      .join("");

    el.innerHTML = `
      <div class="fv-details">
        <div class="fv-verdict ${headlineCls}">${summaryLine}</div>
        <div class="fv-sub">Current price: <strong>$${fmtNum(price, { maximumFractionDigits: 2 })}</strong> — compared against ${methods.length} independent estimate${methods.length > 1 ? "s" : ""} below.</div>
      </div>
      <div class="fv-methods">${rows}</div>`;
  } catch (err) {
    el.innerHTML = `<div class="error-note">Couldn't load fair value.</div>`;
  }
}

// ---------- Ratings & estimates ----------

async function loadRatings(symbol, fhRecPromise, priceTargetPromise) {
  const el = $("#ratings-body");
  const results = await Promise.allSettled([
    fhRecPromise,
    api(`ratings-snapshot/${symbol}`),
    priceTargetPromise,
    api(`grades/${symbol}`),
    api(`estimates/${symbol}`),
  ]);
  const [recRes, snapshotRes, ptRes, gradesRes, estRes] = results;

  const rows = [];

  // Finnhub recommendation trends: always available on the free tier, so
  // this is the one row guaranteed to show even for a ticker FMP blocks.
  if (recRes.status === "fulfilled" && Array.isArray(recRes.value) && recRes.value.length) {
    const c = recRes.value[0]; // most recent period first
    const buyish = (c.strongBuy || 0) + (c.buy || 0);
    const sellish = (c.strongSell || 0) + (c.sell || 0);
    const holdish = c.hold || 0;
    const label = buyish >= holdish && buyish >= sellish ? "Buy" : sellish >= holdish ? "Sell" : "Hold";
    const badgeCls = label === "Buy" ? "buy" : label === "Sell" ? "sell" : "hold";
    rows.push(`<div class="rating-row"><span class="rating-label">Analyst Consensus (${c.period || ""})</span><span class="badge ${badgeCls}">${label}</span></div>`);
    rows.push(`<div class="rating-row"><span class="rating-label">Breakdown</span><span class="rating-value">${buyish} buy · ${holdish} hold · ${sellish} sell</span></div>`);
  }

  if (snapshotRes.status === "fulfilled" && snapshotRes.value && snapshotRes.value[0]) {
    const s = snapshotRes.value[0];
    rows.push(`<div class="rating-row"><span class="rating-label">FMP Rating</span><span class="rating-value">${s.rating || "—"} (${s.overallScore ?? "—"} / 5)</span></div>`);
  }

  if (ptRes.status === "fulfilled" && ptRes.value && ptRes.value[0]) {
    const pt = ptRes.value[0];
    rows.push(`<div class="rating-row"><span class="rating-label">Avg Price Target</span><span class="rating-value">${pt.targetConsensus ? "$" + fmtNum(pt.targetConsensus, { maximumFractionDigits: 2 }) : "—"}</span></div>`);
    rows.push(`<div class="rating-row"><span class="rating-label">High / Low Target</span><span class="rating-value">${pt.targetHigh ? "$" + fmtNum(pt.targetHigh, { maximumFractionDigits: 2 }) : "—"} / ${pt.targetLow ? "$" + fmtNum(pt.targetLow, { maximumFractionDigits: 2 }) : "—"}</span></div>`);
  }

  if (gradesRes.status === "fulfilled" && Array.isArray(gradesRes.value) && gradesRes.value.length) {
    const latest = gradesRes.value[0];
    rows.push(`<div class="rating-row"><span class="rating-label">Latest Action</span><span class="rating-value">${latest.gradingCompany || ""}: ${latest.previousGrade || "?"} → ${latest.newGrade || "?"}</span></div>`);
  }

  if (estRes.status === "fulfilled" && Array.isArray(estRes.value) && estRes.value.length) {
    const e = estRes.value[0];
    rows.push(`<div class="rating-row"><span class="rating-label">Est. Revenue (FY${(e.date || "").slice(0, 4)})</span><span class="rating-value">${fmtBig(e.revenueAvg)}</span></div>`);
    rows.push(`<div class="rating-row"><span class="rating-label">Est. EPS (FY${(e.date || "").slice(0, 4)})</span><span class="rating-value">${e.epsAvg ? "$" + fmtNum(e.epsAvg, { maximumFractionDigits: 2 }) : "—"}</span></div>`);
  }

  if (!rows.length) {
    el.innerHTML = `<div class="muted-note">No analyst data available for this ticker.</div>`;
    return;
  }

  const fmpResults = results.slice(1);
  const fmpRowsShown = fmpResults.some((r) => r.status === "fulfilled");
  if (!fmpRowsShown) {
    const kind = fmpFailureKind(fmpResults);
    const note = fmpFailureNote(kind, "Price target, latest grade action, and forward estimates aren't available for this ticker on the free FMP plan.");
    el.innerHTML = rows.join("") + `<div class="muted-note" style="margin-top:10px">${note}</div>`;
    return;
  }
  el.innerHTML = rows.join("");
}

// ---------- Financials ----------
// Balance sheet/income/cash flow come from SEC EDGAR (free, unlimited, the
// original source FMP itself builds from) instead of FMP — see the Cloud
// Function's sec-financials endpoint. Ratios comes from Finnhub's basic
// financials (also free/unlimited) instead of FMP, but as a current snapshot
// rather than a 5-year history, since that's the shape Finnhub's free tier
// actually offers.

const FIN_STATEMENT_ROWS = {
  balance: [
    ["Total Assets", "totalAssets"], ["Total Liabilities", "totalLiabilities"],
    ["Total Equity", "totalStockholdersEquity"], ["Cash & Equivalents", "cashAndCashEquivalents"],
  ],
  income: [
    ["Revenue", "revenue"], ["Gross Profit", "grossProfit"], ["Operating Income", "operatingIncome"],
    ["Net Income", "netIncome"], ["EPS", "eps"],
  ],
  cashflow: [
    ["Operating Cash Flow", "operatingCashFlow"], ["Capital Expenditure", "capitalExpenditure"],
    ["Free Cash Flow", "freeCashFlow"], ["Dividends Paid", "netDividendsPaid"],
  ],
};

const SEC_STATEMENT_KEY = { balance: "balanceSheet", income: "incomeStatement", cashflow: "cashFlow" };

let finCache = {};
let currentSymbol = null;
let activeFinTab = "balance";
let currentSecPromise = null;
let currentFhMetricsPromise = null;

$("#fin-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab-btn");
  if (!btn) return;
  activeFinTab = btn.dataset.tab;
  [...$("#fin-tabs").children].forEach((b) => b.classList.toggle("active", b === btn));
  renderFinTab();
});

async function loadFinancials(symbol, secPromise, fhMetricsPromise) {
  currentSecPromise = secPromise;
  currentFhMetricsPromise = fhMetricsPromise;
  await fetchFinTab("balance");
  renderFinTab();
}

function fetchFinTab(tab) {
  // Caches the in-flight promise itself, synchronously, not just the
  // resolved result — otherwise two callers racing before either's first
  // await could each see an empty cache slot and fire duplicate requests.
  if (!finCache[tab]) {
    if (tab === "ratios") {
      finCache[tab] = currentFhMetricsPromise
        .then((data) => ({ data: data && data.metric, error: null }))
        .catch((err) => ({ data: null, error: err }));
    } else {
      finCache[tab] = currentSecPromise
        .then((data) => ({ data: data && data[SEC_STATEMENT_KEY[tab]], error: null }))
        .catch((err) => ({ data: null, error: err }));
    }
  }
  return finCache[tab];
}

async function renderFinTab() {
  const el = $("#fin-body");
  const tab = activeFinTab;
  const symbol = currentSymbol;
  el.innerHTML = `<div class="spinner-line">Loading…</div>`;
  const result = await fetchFinTab(tab);
  if (symbol !== currentSymbol || tab !== activeFinTab) return; // stale response, ticker/tab changed since

  if (tab === "ratios") {
    renderRatiosTab(el, result);
    return;
  }

  if (result.error || !Array.isArray(result.data) || !result.data.length) {
    const msg = result.error && result.error.status === 404
      ? "No SEC filings found for this ticker — it may not be a US SEC filer."
      : "No data available.";
    el.innerHTML = `<div class="muted-note">${msg}</div>`;
    return;
  }

  const periods = result.data.slice(0, 5);
  const rowsDef = FIN_STATEMENT_ROWS[tab];

  const header = `<tr><th>Metric</th>${periods.map((p) => `<th>${p.fiscalYear}</th>`).join("")}</tr>`;
  const body = rowsDef
    .map(([label, key]) => {
      const cells = periods
        .map((p) => {
          const v = p[key];
          if (v === undefined || v === null) return "<td>—</td>";
          if (key === "eps") return `<td>$${fmtNum(v, { maximumFractionDigits: 2 })}</td>`;
          return `<td>${fmtBig(v)}</td>`;
        })
        .join("");
      return `<tr><td>${label}</td>${cells}</tr>`;
    })
    .join("");

  el.innerHTML = `<div class="fin-table-wrap"><table class="fin-table"><thead>${header}</thead><tbody>${body}</tbody></table></div>
    <div class="muted-note" style="margin-top:10px">Source: SEC EDGAR filings (free, unlimited).</div>`;
}

function renderRatiosTab(el, result) {
  const m = result.data;
  if (result.error || !m) {
    el.innerHTML = `<div class="muted-note">No data available.</div>`;
    return;
  }
  const rows = [
    ["Current Ratio", m.currentRatioAnnual, "num"],
    ["Debt / Equity", m["totalDebt/totalEquityAnnual"], "num"],
    ["Gross Margin", m.grossMarginTTM ?? m.grossMarginAnnual, "pct"],
    ["Net Margin", m.netProfitMarginTTM ?? m.netProfitMarginAnnual, "pct"],
    ["Dividend Yield", m.currentDividendYieldTTM, "pct"],
    ["Price / Book", m.pb ?? m.pbAnnual, "num"],
    ["Return on Equity", m.roeTTM, "pct"],
  ];
  const body = rows
    .map(([label, v, kind]) => {
      const display = typeof v === "number" && !Number.isNaN(v)
        ? (kind === "pct" ? `${v.toFixed(2)}%` : fmtNum(v, { maximumFractionDigits: 2 }))
        : "—";
      return `<div class="rating-row"><span class="rating-label">${label}</span><span class="rating-value">${display}</span></div>`;
    })
    .join("");
  el.innerHTML = body + `<div class="muted-note" style="margin-top:10px">Current snapshot from Finnhub (free, unlimited) — not a 5-year history like the other tabs.</div>`;
}

// ---------- News ----------
// FMP restricted every news endpoint to paid plans, so this runs through
// Finnhub's free company-news endpoint instead (proxied the same way, key
// hidden server-side) — see freeApi() above for why it skips the FMP pill.

async function loadNews(symbol) {
  const el = $("#news-body");
  try {
    const items = await freeApi(`news/${symbol}`);
    if (!Array.isArray(items) || !items.length) {
      el.innerHTML = `<div class="muted-note">No recent news found in the last 14 days.</div>`;
      return;
    }
    el.innerHTML = items
      .slice(0, 12)
      .map((it) => {
        const date = it.datetime ? new Date(it.datetime * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
        return `
        <a class="news-item" href="${it.url}" target="_blank" rel="noopener noreferrer">
          ${it.image ? `<img class="news-thumb" src="${it.image}" loading="lazy" onerror="this.remove()" />` : ""}
          <div>
            <div class="news-title">${it.headline || ""}</div>
            <div class="news-meta">${it.source || ""} · ${date}</div>
          </div>
        </a>`;
      })
      .join("");
  } catch (err) {
    el.innerHTML = err.status === 402 || err.status === 403
      ? `<div class="muted-note">News requires a paid Finnhub plan.</div>`
      : `<div class="error-note">Couldn't load news.</div>`;
  }
}
