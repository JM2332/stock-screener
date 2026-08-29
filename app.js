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

// News runs through Finnhub, not FMP — it has its own, much more generous
// quota (60/min), so it deliberately doesn't touch the FMP usage pill.
async function newsApi(path) {
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
    items = await api(`search?q=${encodeURIComponent(q)}`);
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
        <span class="search-row-exch">${it.exchange || ""}</span>
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
  // below gets a chance to run — otherwise loadHero's own prefetch (it reuses
  // fetchFinTab for ratios/income so the Financials tabs don't re-fetch) could
  // read or write into the previous ticker's cache.
  currentSymbol = symbol;
  finCache = {};
  activeFinTab = "balance";
  [...$("#fin-tabs").children].forEach((b) => b.classList.toggle("active", b.dataset.tab === "balance"));

  // Shared once so loadHero and loadFairValue don't each pay for their own
  // quote/AAPL call — they both just await this same in-flight request.
  const quotePromise = api(`quote/${symbol}`);

  loadHero(symbol, quotePromise);
  loadFairValue(symbol, quotePromise);
  loadRatings(symbol);
  loadFinancials(symbol);
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

function fmtPct(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return (n * (Math.abs(n) < 1.5 ? 100 : 1)).toFixed(2) + "%";
}

// ---------- Hero ----------

async function loadHero(symbol, quotePromise) {
  try {
    const [quoteArr, profileArr, ratiosRes, incomeRes] = await Promise.all([
      quotePromise,
      api(`profile/${symbol}`),
      fetchFinTab("ratios", symbol),
      fetchFinTab("income", symbol),
    ]);
    const q = quoteArr && quoteArr[0];
    const p = profileArr && profileArr[0];
    const r = ratiosRes && !ratiosRes.error && ratiosRes.data && ratiosRes.data[0];
    const inc = incomeRes && !incomeRes.error && incomeRes.data && incomeRes.data[0];
    if (!q) {
      $("#s-name").textContent = "Not found";
      return;
    }
    $("#s-name").textContent = (p && p.companyName) || q.name || symbol;
    $("#s-symbol").textContent = q.symbol || symbol;
    $("#s-exchange").textContent = q.exchange || (p && p.exchangeShortName) || "—";
    $("#s-sector").textContent = (p && p.sector) || "—";
    $("#s-price").textContent = "$" + fmtNum(q.price, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const change = q.change;
    const changePct = q.changePercentage;
    const changeEl = $("#s-change");
    const up = change >= 0;
    changeEl.className = "hero-change " + (up ? "up" : "down");
    changeEl.textContent = `${up ? "+" : ""}${fmtNum(change, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${up ? "+" : ""}${fmtNum(changePct, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%)`;

    const stats = [
      ["Market Cap", fmtBig(q.marketCap ?? (p && p.marketCap))],
      ["P/E Ratio", r && r.priceToEarningsRatio ? fmtNum(r.priceToEarningsRatio, { maximumFractionDigits: 2 }) : "—"],
      ["EPS (TTM)", inc && inc.eps ? "$" + fmtNum(inc.eps, { maximumFractionDigits: 2 }) : "—"],
      ["Day Range", q.dayLow && q.dayHigh ? `$${fmtNum(q.dayLow, { maximumFractionDigits: 2 })} – $${fmtNum(q.dayHigh, { maximumFractionDigits: 2 })}` : "—"],
      ["52W Range", q.yearLow && q.yearHigh ? `$${fmtNum(q.yearLow, { maximumFractionDigits: 2 })} – $${fmtNum(q.yearHigh, { maximumFractionDigits: 2 })}` : "—"],
      ["Volume", fmtBig(q.volume)],
      ["Avg Volume", fmtBig(p && p.averageVolume)],
      ["Open", q.open ? "$" + fmtNum(q.open, { maximumFractionDigits: 2 }) : "—"],
    ];
    $("#s-stats").innerHTML = stats
      .map(([label, value]) => `<div class="stat-item"><span class="stat-label">${label}</span><span class="stat-value">${value}</span></div>`)
      .join("");
  } catch (err) {
    $("#s-name").textContent = err.status === 402 || err.status === 403
      ? "Not available on the free FMP plan"
      : "Couldn't load this ticker";
  }
}

// ---------- Fair value (DCF) ----------

async function loadFairValue(symbol, quotePromise) {
  const el = $("#fv-body");
  try {
    const [dcfArr, quoteArr] = await Promise.all([api(`dcf/${symbol}`), quotePromise]);
    const dcf = dcfArr && dcfArr[0];
    const price = quoteArr && quoteArr[0] && quoteArr[0].price;
    if (!dcf || dcf.dcf === undefined || price === undefined) {
      el.innerHTML = `<div class="muted-note">Fair value data isn't available for this ticker.</div>`;
      return;
    }
    const fairValue = dcf.dcf;
    const diffPct = ((price - fairValue) / fairValue) * 100;
    let verdict, cls;
    if (diffPct > 8) {
      verdict = "Potentially Overvalued";
      cls = "over";
    } else if (diffPct < -8) {
      verdict = "Potentially Undervalued";
      cls = "under";
    } else {
      verdict = "Fairly Valued";
      cls = "fair";
    }
    el.innerHTML = `
      <div class="fv-details">
        <div class="fv-verdict ${cls}">${verdict}</div>
        <div class="fv-sub">
          DCF fair value estimate: <strong>$${fmtNum(fairValue, { maximumFractionDigits: 2 })}</strong><br/>
          Current price: <strong>$${fmtNum(price, { maximumFractionDigits: 2 })}</strong> (${diffPct > 0 ? "+" : ""}${diffPct.toFixed(1)}% vs fair value)
        </div>
        <div class="fv-note">Based on a discounted cash flow model. One estimate among many — treat as a starting point, not a target price.</div>
      </div>`;
  } catch (err) {
    el.innerHTML = err.status === 403 || err.status === 402
      ? `<div class="muted-note">Fair value requires a higher Financial Modeling Prep plan.</div>`
      : `<div class="error-note">Couldn't load fair value.</div>`;
  }
}

// ---------- Ratings & estimates ----------

async function loadRatings(symbol) {
  const el = $("#ratings-body");
  const results = await Promise.allSettled([
    api(`grades-consensus/${symbol}`),
    api(`ratings-snapshot/${symbol}`),
    api(`price-target/${symbol}`),
    api(`grades/${symbol}`),
    api(`estimates/${symbol}`),
  ]);
  const [consensusRes, snapshotRes, ptRes, gradesRes, estRes] = results;

  const rows = [];

  if (consensusRes.status === "fulfilled" && consensusRes.value && consensusRes.value[0]) {
    const c = consensusRes.value[0];
    const rec = (c.consensus || "").toLowerCase();
    const badgeCls = rec.includes("buy") ? "buy" : rec.includes("sell") ? "sell" : "hold";
    rows.push(`<div class="rating-row"><span class="rating-label">Analyst Consensus</span><span class="badge ${badgeCls}">${c.consensus || "—"}</span></div>`);
    const total = (c.strongBuy || 0) + (c.buy || 0) + (c.hold || 0) + (c.sell || 0) + (c.strongSell || 0);
    if (total) {
      rows.push(`<div class="rating-row"><span class="rating-label">Breakdown</span><span class="rating-value">${c.strongBuy + c.buy} buy · ${c.hold} hold · ${c.sell + c.strongSell} sell</span></div>`);
    }
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

  const allFailed = results.every((r) => r.status === "rejected");
  const anyPaywalled = results.some((r) => r.status === "rejected" && (r.reason.status === 403 || r.reason.status === 402));

  if (!rows.length) {
    el.innerHTML = allFailed && anyPaywalled
      ? `<div class="muted-note">Analyst ratings require a higher Financial Modeling Prep plan.</div>`
      : `<div class="muted-note">No analyst data available for this ticker.</div>`;
    return;
  }
  el.innerHTML = rows.join("");
}

// ---------- Financials ----------

const FIN_ENDPOINTS = {
  balance: { path: "balance-sheet", rows: [
    ["Total Assets", "totalAssets"], ["Total Liabilities", "totalLiabilities"],
    ["Total Equity", "totalStockholdersEquity"], ["Cash & Equivalents", "cashAndCashEquivalents"],
    ["Total Debt", "totalDebt"], ["Net Debt", "netDebt"],
  ]},
  income: { path: "income-statement", rows: [
    ["Revenue", "revenue"], ["Gross Profit", "grossProfit"], ["Operating Income", "operatingIncome"],
    ["Net Income", "netIncome"], ["EPS", "eps"], ["EBITDA", "ebitda"],
  ]},
  cashflow: { path: "cash-flow", rows: [
    ["Operating Cash Flow", "operatingCashFlow"], ["Capital Expenditure", "capitalExpenditure"],
    ["Free Cash Flow", "freeCashFlow"], ["Dividends Paid", "netDividendsPaid"],
  ]},
  ratios: { path: "ratios", rows: [
    ["Current Ratio", "currentRatio"], ["Debt / Equity", "debtToEquityRatio"],
    ["Gross Margin", "grossProfitMargin"], ["Net Margin", "netProfitMargin"],
    ["Dividend Yield", "dividendYield"], ["Price / Book", "priceToBookRatio"],
  ]},
};

let finCache = {};
let currentSymbol = null;
let activeFinTab = "balance";

$("#fin-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab-btn");
  if (!btn) return;
  activeFinTab = btn.dataset.tab;
  [...$("#fin-tabs").children].forEach((b) => b.classList.toggle("active", b === btn));
  renderFinTab();
});

async function loadFinancials(symbol) {
  await fetchFinTab("balance", symbol);
  renderFinTab();
}

async function fetchFinTab(tab, symbol) {
  if (finCache[tab]) return finCache[tab];
  try {
    const data = await api(`${FIN_ENDPOINTS[tab].path}/${symbol}`);
    finCache[tab] = { data, error: null };
  } catch (err) {
    finCache[tab] = { data: null, error: err };
  }
  return finCache[tab];
}

async function renderFinTab() {
  const el = $("#fin-body");
  const tab = activeFinTab;
  const symbol = currentSymbol;
  el.innerHTML = `<div class="spinner-line">Loading…</div>`;
  const result = await fetchFinTab(tab, symbol);
  if (symbol !== currentSymbol || tab !== activeFinTab) return; // stale response, ticker/tab changed since

  if (result.error || !Array.isArray(result.data) || !result.data.length) {
    el.innerHTML = result.error && (result.error.status === 403 || result.error.status === 402)
      ? `<div class="muted-note">This statement requires a higher Financial Modeling Prep plan.</div>`
      : `<div class="muted-note">No data available.</div>`;
    return;
  }

  const periods = result.data.slice(0, 5);
  const rowsDef = FIN_ENDPOINTS[tab].rows;
  const isPct = (key) => ["grossProfitMargin", "netProfitMargin", "dividendYield"].includes(key);
  const isRatio = (key) => ["currentRatio", "debtToEquityRatio", "priceToBookRatio"].includes(key);

  const header = `<tr><th>Metric</th>${periods.map((p) => `<th>${p.fiscalYear || (p.date || "").slice(0, 4)}</th>`).join("")}</tr>`;
  const body = rowsDef
    .map(([label, key]) => {
      const cells = periods
        .map((p) => {
          const v = p[key];
          if (v === undefined || v === null) return "<td>—</td>";
          if (isPct(key)) return `<td>${fmtPct(v)}</td>`;
          if (isRatio(key)) return `<td>${fmtNum(v, { maximumFractionDigits: 2 })}</td>`;
          if (key === "eps") return `<td>$${fmtNum(v, { maximumFractionDigits: 2 })}</td>`;
          return `<td>${fmtBig(v)}</td>`;
        })
        .join("");
      return `<tr><td>${label}</td>${cells}</tr>`;
    })
    .join("");

  el.innerHTML = `<div class="fin-table-wrap"><table class="fin-table"><thead>${header}</thead><tbody>${body}</tbody></table></div>`;
}

// ---------- News ----------
// FMP restricted every news endpoint to paid plans, so this runs through
// Finnhub's free company-news endpoint instead (proxied the same way, key
// hidden server-side) — see newsApi() above for why it skips the FMP pill.

async function loadNews(symbol) {
  const el = $("#news-body");
  try {
    const items = await newsApi(`news/${symbol}`);
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
