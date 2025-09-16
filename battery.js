/*
HomeyScript: Battery control with tags (SE3)
Regler (2025-09):
- SoC min/max: 10% / 90% (hårda)
- Sälj: topp 10% dyraste timmar → export OK
- Nästa 30% dyraste timmar → endast last-shaving (ingen export)
- Solar-first, plan för idag (+ imorgon efter kl 13)
- Endast tags (inga logic-variabler). Alla taggar skrivs med String/Number-objekt.

Indata (args eller "A;B;C;D;E"):
  producing_W; grid_flow_W; local_flow_W; battery_flow_W; battery_soc
  - producing_W    >= 0 (PV)
  - grid_flow_W    >0 import, <0 export
  - local_flow_W   >= 0 (last)
  - battery_flow_W <0 laddning, >0 urladdning
  - battery_soc    % (0..100) eller 0..1
*/

// =================== KONFIG ===================
const REGION = "SE3";
const import_extra = 0.86; // kr/kWh (köp-påslag)
const export_extra = 0.60; // kr/kWh (sälj-påslag)

// Batteri
const batteryCapacity_kWh   = 15;
const HARD_MIN_SOC         = 0.10;
const HARD_MAX_SOC         = 0.90;
const maxChargePower_kW    = 6.0;
const maxDischargePower_kW = 6.0;
const roundTripEff         = 0.92;
const chargeEff            = Math.sqrt(roundTripEff);
const dischargeEff         = Math.sqrt(roundTripEff);

// Marginalkrav för export (slitage)
const minimumSellMargin_SEK = 0.50; // minst 50 öre marginal för att sälja till nätet

// Pris-klasser
const cheapPercent       = 0.30; // billigaste 30% → ladda
const expensiveTop10Pct  = 0.10; // dyraste 10% → sälj (export OK)
const expensiveNext30Pct = 0.30; // nästa 30% dyraste → endast last-shaving

// Beteende
const allowGridChargeWhenCheap          = true; // tillåten import i cheap
const allowGridChargeToMeetTomorrowGoal = true; // ladda mot mål till midnatt om lönsamt
const pvNoiseFloor_kW = 0.01;

// Håll morgonbuffert för solenergi (framförallt mars–sept)
const solarReserve = {
  enabled: true,
  maxMorningSoC: 0.75,     // 75% → lämna 25% till PV
  startHour: 0,
  releaseHour: 11,
  monthsActive: [3,4,5,6,7,8,9], // mars–sept (1=jan)
  skipExpensiveHours: false // true = hoppa dyra timmar
};

// “Mid”/buffert
const midDischargeFloorSoC = HARD_MIN_SOC; // gå inte under hård min i mid
const priceMidBias         = 1.0;          // 1.0 => tröskel = dagens snittpris

// =================== HJÄLP ===================
function round2(x){ return Math.round(x * 100) / 100; }
function round3(x){ return Math.round(x * 1000) / 1000; }
function clamp01(x){ return Math.min(1, Math.max(0, x)); }
const socCapOverrides = new Map();

function hourKey(date) {
  if (!date) return null;
  const dt = new Date(date);
  if (Number.isNaN(dt.getTime())) return null;
  dt.setMinutes(0, 0, 0);
  return dt.toISOString();
}

function setSocCapOverride(date, cap) {
  const key = hourKey(date);
  if (!key) return;
  const limited = Math.min(HARD_MAX_SOC, Math.max(HARD_MIN_SOC, clamp01(cap)));
  if (!socCapOverrides.has(key)) socCapOverrides.set(key, limited);
  else socCapOverrides.set(key, Math.min(socCapOverrides.get(key), limited));
}

function capSoCForHour(date){
  const key = hourKey(date);
  if (!key) return HARD_MAX_SOC;
  const override = socCapOverrides.get(key);
  return (override != null) ? override : HARD_MAX_SOC;
} // hårt tak 90%

function normalizeMode(m) {
  if (m === 'charge' || m === 'discharge' || m === 'idle') return m;
  if (m && String(m).toLowerCase().startsWith('discharge')) return 'discharge';
  return 'idle';
}

// Skriv taggar med wrapper-objekt (fix för vissa Flow-körningar)
function tagErrorMessage(err) {
  if (!err) return "";
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const known = err.message || err.error || err.reason;
    if (typeof known === "string" && known.trim() !== "") return known;
    try { return JSON.stringify(err); }
    catch (_) { /* ignore */ }
  }
  return String(err);
}

async function updateTag(name, expectedType, candidates) {
  if (typeof tag !== "function") return true;

  let lastError = null;
  for (const candidate of candidates) {
    try {
      const result = await tag(name, candidate);
      const failure = (result === false)
        || (result && typeof result === "object" && (
             result.success === false
             || result.ok === false
             || result.result === false
             || (result.error != null)
           ));
      if (failure) {
        lastError = result;
        continue;
      }
      return true;
    } catch (err) {
      lastError = err;
    }
  }

  const message = (lastError === false) ? "tag() returned false" : tagErrorMessage(lastError);
  console.error(`❌ tag '${name}' (${expectedType})`, message || "okänt fel");
  return false;
}

async function setTagString(name, value) {
  const str = String(value ?? "");
  const candidates = [
    { type: "String", value: str },
    new String(str),
    str
  ];
  return updateTag(name, "String", candidates);
}
async function setTagNumber(name, value) {
  const num = Number.isFinite(value) ? Number(value) : 0;
  const candidates = [
    { type: "Number", value: num },
    new Number(num),
    num
  ];
  return updateTag(name, "Number", candidates);
}

// --- Argument ---
function getArgString() {
  let a = [];
  if (typeof args !== "undefined" && Array.isArray(args)) a = args;
  else if (typeof Homey !== "undefined" && Array.isArray(Homey.args)) a = Homey.args;
  a = (a || []).filter(x => x != null && String(x).trim() !== "");
  if (a.length === 0) {
    const fallback = "1300;60;261;-970;16";
    console.log("ℹ️ Inga arguments, använder fallback:", fallback);
    return fallback;
  }
  if (a.length === 1) return String(a[0]);
  return a.map(String).join(";");
}
function parseArgString(argStr) {
  if (!argStr || typeof argStr !== "string") return {};
  const parts = argStr.split(";").map(s => s.trim()).filter(Boolean);
  const toNum = (s) => {
    if (s == null) return NaN;
    const t = String(s).replace(",", ".");
    const n = Number(t);
    return Number.isFinite(n) ? n : NaN;
  };
  const v = parts.map(toNum);
  return {
    producing_W: v[0],
    grid_flow_W: v[1],
    local_flow_W: v[2],
    battery_flow_W: v[3],
    battery_soc_raw: v[4]
  };
}
function normalizeSoc(socRaw) {
  if (!Number.isFinite(socRaw)) return 0.5;
  if (socRaw > 1.5) return clamp01(socRaw / 100);
  return clamp01(socRaw);
}
function normalizeFlowsFromW({ producing_W, grid_flow_W, local_flow_W, battery_flow_W }) {
  const W2kW = (w) => (Number(w) || 0) / 1000;
  const prod_kW = Math.max(0, W2kW(producing_W));
  const load_kW = Math.max(0, W2kW(local_flow_W));
  const gridW = Number(grid_flow_W) || 0;
  const gridImport_kW = gridW > 0 ? gridW / 1000 : 0;
  const gridExport_kW = gridW < 0 ? Math.abs(gridW) / 1000 : 0;
  const battW = Number(battery_flow_W) || 0;
  const battCharge_kW = battW < 0 ? Math.abs(battW) / 1000 : 0;
  const battDischarge_kW = battW > 0 ? battW / 1000 : 0;
  return { prod_kW, load_kW, gridImport_kW, gridExport_kW, battCharge_kW, battDischarge_kW };
}
function balanceCheck({ prod_kW, load_kW, gridImport_kW, gridExport_kW, battCharge_kW, battDischarge_kW }) {
  const left = prod_kW + gridImport_kW + battDischarge_kW;
  const right = load_kW + gridExport_kW + battCharge_kW;
  const diff = left - right;
  return { left: round3(left), right: round3(right), diff: round3(diff), ok: Math.abs(diff) < 0.2 };
}

function slotDurationHours(slot) {
  if (!slot) return 1;
  const start = new Date(slot.start ?? slot.hourStartISO ?? slot);
  const end = slot.end ? new Date(slot.end) : null;
  if (Number.isNaN(start.getTime())) return 1;
  let durationMs = 60 * 60 * 1000; // default 1h
  if (end && !Number.isNaN(end.getTime())) {
    durationMs = Math.max(1, end.getTime() - start.getTime());
  }
  const hours = durationMs / (60 * 60 * 1000);
  return Math.max(1 / 60, Number.isFinite(hours) ? hours : 1);
}

function averagePriceForSet(hours, keySet, field) {
  if (!Array.isArray(hours) || !(keySet instanceof Set) || keySet.size === 0) return NaN;
  let sum = 0;
  let count = 0;
  for (const h of hours) {
    if (!h || !h.start || !keySet.has(h.start)) continue;
    const value = Number(h?.[field]);
    if (!Number.isFinite(value)) continue;
    sum += value;
    count += 1;
  }
  return count > 0 ? (sum / count) : NaN;
}

function sellMarginOk(sellPrice, baselineBuyPrice) {
  if (!Number.isFinite(sellPrice) || !Number.isFinite(baselineBuyPrice)) return false;
  const effectiveCost = baselineBuyPrice / roundTripEff;
  return (sellPrice - effectiveCost) >= minimumSellMargin_SEK;
}

function marginBaselineForSlot(slotStartISO, avgCheapToday, avgCheapTomorrow, avgCheapAll) {
  const fallback = Number.isFinite(avgCheapAll) ? avgCheapAll : (Number.isFinite(avgCheapToday) ? avgCheapToday : NaN);
  if (!slotStartISO) return fallback;
  const dt = new Date(slotStartISO);
  if (Number.isNaN(dt.getTime())) return fallback;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  const dayAfter = new Date(tomorrow.getTime() + 24 * 60 * 60 * 1000);
  if (dt >= today && dt < tomorrow) {
    return Number.isFinite(avgCheapToday) ? avgCheapToday : fallback;
  }
  if (dt >= tomorrow && dt < dayAfter) {
    return Number.isFinite(avgCheapTomorrow) ? avgCheapTomorrow : fallback;
  }
  return fallback;
}

// =================== PRISER ===================
function ymd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return { y, m, d };
}
async function fetchPricesFor(date, region) {
  const { y, m, d } = ymd(date);
  const url = `https://www.elprisetjustnu.se/api/v1/prices/${y}/${m}-${d}_${region}.json`;
  console.log("🌐 Hämtar priser:", url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pris-API svarade ${res.status} för ${y}-${m}-${d}`);
  const data = await res.json();
  data.sort((a, b) => new Date(a.time_start) - new Date(b.time_start));
  return data.map(p => ({
    start: p.time_start,
    end: p.time_end,
    spot_SEK: Number(p.SEK_per_kWh),
    buy_SEK:  Number(p.SEK_per_kWh) + import_extra,
    sell_SEK: Number(p.SEK_per_kWh) + export_extra,
  }));
}
async function fetchTodayAndMaybeTomorrow(region) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today.getTime() + 24*60*60*1000);
  const todayHours = await fetchPricesFor(today, region);
  let tomorrowHours = [];
  if (now.getHours() >= 13) {
    try { tomorrowHours = await fetchPricesFor(tomorrow, region); }
    catch (e) { console.log("ℹ️ Morgondagens priser ej tillgängliga:", String(e)); }
  }
  return { todayHours, tomorrowHours };
}
function classifyPrices(hours) {
  if (!hours || !hours.length) {
    return { cheapSet:new Set(), expTop10:new Set(), expNext30:new Set() };
  }
  // Cheap (köp)
  const byBuyAsc = [...hours].sort((a,b)=>a.buy_SEK-b.buy_SEK);
  const cheapN = Math.max(1, Math.round(hours.length * cheapPercent));
  const cheapSet = new Set(byBuyAsc.slice(0, cheapN).map(h=>h.start));

  // Expensive (sälj/last-shave)
  const bySellDesc = [...hours].sort((a,b)=>b.sell_SEK-a.sell_SEK);
  const top10N  = Math.max(1, Math.round(hours.length * expensiveTop10Pct));
  const next30N = Math.max(0, Math.round(hours.length * expensiveNext30Pct));
  const expTop10  = new Set(bySellDesc.slice(0, top10N).map(h=>h.start));
  const expNext30 = new Set(bySellDesc.slice(top10N, top10N + next30N).map(h=>h.start));

  return { cheapSet, expTop10, expNext30 };
}
function avgBuy(hours) {
  if (!hours || !hours.length) return NaN;
  return hours.reduce((a,h)=>a + (h.buy_SEK||0), 0) / hours.length;
}
function priceStateNow(hours, classes) {
  const now = new Date();
  const slot = hours.find(h => {
    const s = new Date(h.start);
    const e = new Date(h.end);
    return now >= s && now < e;
  });
  if (!slot) return { state: "normal", price: NaN, sellPrice: NaN, slot: null, inTop10:false, inNext30:false, inCheap:false };
  const key = slot.start;
  const inCheap  = classes.cheapSet.has(key);
  const inTop10  = classes.expTop10.has(key);
  const inNext30 = classes.expNext30.has(key);

  let state = "normal";
  if (inCheap) state = "cheap";
  else if (inTop10 || inNext30) state = "expensive";

  return { state, price: slot.buy_SEK, sellPrice: slot.sell_SEK, slot, inTop10, inNext30, inCheap };
}

function applySolarReserveCaps(todayHours, tomorrowHours, classesAll) {
  socCapOverrides.clear();

  if (!solarReserve?.enabled) {
    console.log("☀️ Solar-reserve: avstängd.");
    return;
  }

  const reserveCap = Math.min(HARD_MAX_SOC, Math.max(HARD_MIN_SOC, clamp01(solarReserve.maxMorningSoC ?? HARD_MAX_SOC)));
  if (reserveCap >= HARD_MAX_SOC - 1e-6) {
    console.log("☀️ Solar-reserve: maxMorningSoC når hårt tak → ingen begränsning.");
    return;
  }

  const monthsArray = Array.isArray(solarReserve.monthsActive) ? solarReserve.monthsActive : [];
  const activeMonths = new Set(monthsArray);
  const enforceMonth = activeMonths.size > 0;
  const startHour = Number.isFinite(solarReserve.startHour) ? Math.max(0, Math.min(23, Math.floor(solarReserve.startHour))) : 0;
  const releaseHourRaw = Number.isFinite(solarReserve.releaseHour) ? Math.max(0, Math.min(24, Math.floor(solarReserve.releaseHour))) : 11;
  const releaseHour = Math.max(0, Math.min(24, releaseHourRaw));
  if (startHour === releaseHour) {
    console.log("☀️ Solar-reserve: start och stopp är samma timme → hoppar över.");
    return;
  }
  const windowWraps = startHour > releaseHour;

  const expTop10 = (classesAll && classesAll.expTop10 instanceof Set) ? classesAll.expTop10 : new Set();
  const expNext30 = (classesAll && classesAll.expNext30 instanceof Set) ? classesAll.expNext30 : new Set();
  const skipExpensive = solarReserve.skipExpensiveHours !== false;

  const summary = {};
  const register = (date) => {
    const key = date.toISOString().slice(0, 10);
    summary[key] = (summary[key] || 0) + 1;
  };

  const inWindow = (hour) => {
    if (!windowWraps) return hour >= startHour && hour < releaseHour;
    return (hour >= startHour) || (hour < releaseHour);
  };

  const processHours = (hours) => {
    if (!Array.isArray(hours)) return;
    for (const h of hours) {
      if (!h || !h.start) continue;
      const dt = new Date(h.start);
      if (Number.isNaN(dt.getTime())) continue;
      if (enforceMonth) {
        const month = dt.getMonth() + 1;
        if (!activeMonths.has(month)) continue;
      }
      const hour = dt.getHours();
      if (!inWindow(hour)) continue;
      if (skipExpensive) {
        const key = h.start;
        if (expTop10.has(key) || expNext30.has(key)) continue;
      }
      setSocCapOverride(dt, reserveCap);
      register(dt);
    }
  };

  processHours(todayHours);
  processHours(tomorrowHours);

  if (Object.keys(summary).length) {
    console.log(`☀️ Solar-reserve: max SoC ${Math.round(reserveCap*100)}%`, summary);
  } else {
    console.log("☀️ Solar-reserve: ingen aktiv begränsning.");
  }
}

// =================== MÅL INFÖR IMORGON ===================
function computeSoCTargetForMidnight(todayHours, tomorrowHours, classesAll) {
  const now = new Date();

  const cheapTodayRemaining = todayHours.filter(h => new Date(h.start) > now && classesAll.cheapSet.has(h.start));
  const avgCheapTodayRemaining = cheapTodayRemaining.length
    ? cheapTodayRemaining.reduce((a,h)=>a+h.buy_SEK,0)/cheapTodayRemaining.length
    : Infinity;

  const expTomorrowTop10  = tomorrowHours.filter(h => classesAll.expTop10.has(h.start));
  const expTomorrowNext30 = tomorrowHours.filter(h => classesAll.expNext30.has(h.start));
  const expTomorrowAll = [...expTomorrowTop10, ...expTomorrowNext30];
  const avgSellExpTomorrow = expTomorrowAll.length
    ? expTomorrowAll.reduce((a,h)=>a + (Number.isFinite(h?.sell_SEK) ? Number(h.sell_SEK) : Number(h.buy_SEK) || 0), 0) / expTomorrowAll.length
    : -Infinity;
  const expCount = expTomorrowAll.length;

  if (!tomorrowHours.length || expCount === 0) {
    return { targetSoC: null, profitCheck: null };
  }

  const marginAdjustedSell = Number.isFinite(avgSellExpTomorrow) ? (avgSellExpTomorrow - minimumSellMargin_SEK) : -Infinity;
  const maxProfitableBuy = (Number.isFinite(marginAdjustedSell) && marginAdjustedSell > 0)
    ? marginAdjustedSell * roundTripEff
    : -Infinity;
  const profitable = Number.isFinite(avgCheapTodayRemaining) && Number.isFinite(maxProfitableBuy) && avgCheapTodayRemaining <= maxProfitableBuy;

  const energyNeed_kWh = expCount * maxDischargePower_kW * 1.0; // antag 1h/timme
  const maxFill_kWh = batteryCapacity_kWh * (HARD_MAX_SOC - HARD_MIN_SOC);
  const targetSoC = clamp01(HARD_MIN_SOC + Math.min(energyNeed_kWh, maxFill_kWh) / batteryCapacity_kWh);

  return {
    targetSoC: profitable ? targetSoC : null,
    profitCheck: {
      avgCheapTodayRemaining: Number.isFinite(avgCheapTodayRemaining) ? round3(avgCheapTodayRemaining) : null,
      avgSellTomorrow: Number.isFinite(avgSellExpTomorrow) ? round3(avgSellExpTomorrow) : null,
      requiredBuyForMargin: Number.isFinite(maxProfitableBuy) ? round3(maxProfitableBuy) : null,
      margin_SEK: round3(minimumSellMargin_SEK),
      profitable
    }
  };
}

// =================== PLANBYGGARE ===================
function buildPlan(hours, classes, startSoc, avgBuyOfDay, cheapAvgBuy) {
  const startSocClamped = clamp01(startSoc);
  let soc = startSocClamped;
  const plan = [];
  const midPriceThreshold = Number.isFinite(avgBuyOfDay)
    ? avgBuyOfDay * priceMidBias
    : Infinity;

  const marginBaselineDefault = Number.isFinite(cheapAvgBuy)
    ? cheapAvgBuy
    : (Number.isFinite(avgBuyOfDay) ? avgBuyOfDay : NaN);

  const dischargeCandidates = [];
  if (Array.isArray(hours)) {
    for (const h of hours) {
      if (!h || !h.start) continue;
      const key = h.start;
      const inCheap = classes.cheapSet.has(key);
      const inTop10 = classes.expTop10.has(key);
      const inNext30 = classes.expNext30.has(key);
      const buyPriceRaw = Number(h?.buy_SEK);
      const sellPriceRaw = Number(h?.sell_SEK);
      const duration = slotDurationHours(h);

      const qualifiesMid = !inCheap
        && !inTop10
        && !inNext30
        && Number.isFinite(midPriceThreshold)
        && Number.isFinite(buyPriceRaw)
        && buyPriceRaw >= midPriceThreshold;
      if (!inTop10 && !inNext30 && !qualifiesMid) continue;

      const classRank = inTop10 ? 3 : (inNext30 ? 2 : 1);
      const sortPrice = Number.isFinite(sellPriceRaw)
        ? sellPriceRaw
        : (Number.isFinite(buyPriceRaw) ? buyPriceRaw : -Infinity);
      const marginOk = sellMarginOk(sellPriceRaw, marginBaselineDefault);
      const ts = new Date(key).getTime();
      const order = Number.isFinite(ts) ? ts : 0;
      const marginBonus = marginOk ? 100 : 0;
      const score = sortPrice + marginBonus + classRank * 5;

      dischargeCandidates.push({
        start: key,
        score,
        order,
        duration,
        maxEnergy_kWh: maxDischargePower_kW * duration
      });
    }
  }

  dischargeCandidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.order - b.order;
  });

  const startDeliverableBudget_kWh = Math.max(0, (startSocClamped - HARD_MIN_SOC) * batteryCapacity_kWh) * dischargeEff;
  let remainingDeliverableBudget_kWh = startDeliverableBudget_kWh;
  const dischargeAllocation = new Map();
  for (const candidate of dischargeCandidates) {
    if (!candidate || !candidate.start) continue;
    if (remainingDeliverableBudget_kWh <= 1e-6) break;
    if (dischargeAllocation.has(candidate.start)) continue;
    const capacityForSlot_kWh = Math.max(0, Math.min(candidate.maxEnergy_kWh, remainingDeliverableBudget_kWh));
    if (capacityForSlot_kWh <= 1e-6) continue;
    dischargeAllocation.set(candidate.start, capacityForSlot_kWh);
    remainingDeliverableBudget_kWh -= capacityForSlot_kWh;
  }

  let totalReservedRemaining_kWh = startDeliverableBudget_kWh - remainingDeliverableBudget_kWh;
  totalReservedRemaining_kWh = Math.max(0, totalReservedRemaining_kWh);

  for (const h of hours) {
    const dt = new Date(h.start);
    const duration = slotDurationHours(h);
    const cap = capSoCForHour(dt);
    const inCheap  = classes.cheapSet.has(h.start);
    const inTop10  = classes.expTop10.has(h.start);
    const inNext30 = classes.expNext30.has(h.start);
    const isMid    = !inCheap && !inTop10 && !inNext30;
    const price    = h.buy_SEK || 0;
    const sellPrice = Number.isFinite(h?.sell_SEK) ? Number(h.sell_SEK) : price;
    const marginBaseline = marginBaselineDefault;
    const marginOk = sellMarginOk(sellPrice, marginBaseline);

    let decision = "idle";
    let power_kW = 0;

    const capActive = cap < HARD_MAX_SOC - 1e-6;
    const aboveCap = soc > cap + 1e-6;
    let forcedBleedPower_kW = 0;
    if (capActive && aboveCap) {
      const deltaSoc = soc - Math.max(cap, HARD_MIN_SOC);
      if (deltaSoc > 1e-4) {
        const bleedEnergy_kWh = deltaSoc * batteryCapacity_kWh * dischargeEff;
        forcedBleedPower_kW = Math.min(maxDischargePower_kW, bleedEnergy_kWh / duration);
      }
    }

    const reservedRaw_kWh = dischargeAllocation.get(h.start);
    const reservedForHour_kWh = (typeof reservedRaw_kWh === "number" && Number.isFinite(reservedRaw_kWh)) ? reservedRaw_kWh : 0;
    const reservedForFuture_kWh = Math.max(0, totalReservedRemaining_kWh - reservedForHour_kWh);

    const energyAboveMin_kWh = Math.max(0, (soc - HARD_MIN_SOC) * batteryCapacity_kWh);
    const deliverableNow_kWh = energyAboveMin_kWh * dischargeEff;
    let dischargeBudget_kWh = deliverableNow_kWh - reservedForFuture_kWh;
    if (!Number.isFinite(dischargeBudget_kWh)) dischargeBudget_kWh = 0;
    dischargeBudget_kWh = Math.max(0, Math.min(dischargeBudget_kWh, maxDischargePower_kW * duration));
    let dischargeBudgetPower_kW = dischargeBudget_kWh / duration;

    const energyAboveMid_kWh = Math.max(0, (soc - midDischargeFloorSoC) * batteryCapacity_kWh);
    const midBudget_kWh = Math.min(energyAboveMid_kWh * dischargeEff, maxDischargePower_kW * duration);
    const midBudgetPower_kW = midBudget_kWh / duration;

    if (inCheap) {
      const room_kWh = Math.max(0, (cap - soc) * batteryCapacity_kWh);
      const maxChargeEnergy_kWh = maxChargePower_kW * duration * chargeEff;
      const toStore_kWh = Math.min(room_kWh, maxChargeEnergy_kWh);
      power_kW = (toStore_kWh > 1e-6 && duration > 0) ? (toStore_kWh / (chargeEff * duration)) : 0;
      if (power_kW > 0.01) decision = "charge";
    } else if (inTop10) {
      const allowedPower = Math.min(dischargeBudgetPower_kW, maxDischargePower_kW);
      if (marginOk) {
        if (allowedPower > 0.01) {
          power_kW = round2(allowedPower);
          decision = "discharge";
        }
      } else {
        const shavePower = Math.min(allowedPower, midBudgetPower_kW);
        if (shavePower > 0.01) {
          power_kW = round2(shavePower);
          decision = "load_shaving";
        }
      }
    } else if (inNext30) {
      const allowedPower = Math.min(dischargeBudgetPower_kW, midBudgetPower_kW);
      if (allowedPower > 0.01) {
        power_kW = round2(allowedPower);
        decision = "load_shaving";
      }
    } else if (isMid) {
      if (Number.isFinite(midPriceThreshold) && price >= midPriceThreshold && soc > midDischargeFloorSoC + 1e-3) {
        const allowedPower = Math.min(dischargeBudgetPower_kW, midBudgetPower_kW);
        if (allowedPower > 0.01) {
          power_kW = round2(allowedPower);
          decision = "load_shaving";
        }
      }
    }

    if (forcedBleedPower_kW > power_kW) {
      const bleedPower = Math.min(maxDischargePower_kW, forcedBleedPower_kW);
      if (bleedPower > power_kW) {
        power_kW = round2(bleedPower);
        if (decision === "charge" || decision === "idle") {
          decision = "load_shaving";
        }
      }
    }

    const isChargeDecision = decision.startsWith("charge");
    const isDischargeDecision = decision.startsWith("discharge") || decision === "load_shaving";
    const deliveredEnergy_kWh = isDischargeDecision ? power_kW * duration : 0;
    let extraFromFuture_kWh = deliveredEnergy_kWh - Math.max(0, dischargeBudget_kWh);
    if (!Number.isFinite(extraFromFuture_kWh) || extraFromFuture_kWh < 1e-6) extraFromFuture_kWh = 0;
    let reservedTotalAfter_kWh = reservedForFuture_kWh - extraFromFuture_kWh;
    if (!Number.isFinite(reservedTotalAfter_kWh)) reservedTotalAfter_kWh = 0;
    totalReservedRemaining_kWh = Math.max(0, reservedTotalAfter_kWh);
    dischargeAllocation.delete(h.start);

    if (isChargeDecision) {
      const stored_kWh = power_kW * duration * chargeEff;
      soc = clamp01(Math.min(HARD_MAX_SOC, soc + stored_kWh / batteryCapacity_kWh));
    } else if (isDischargeDecision) {
      const taken_kWh = (power_kW * duration) / dischargeEff;
      soc = clamp01(Math.max(HARD_MIN_SOC, soc - taken_kWh / batteryCapacity_kWh));
    }

    plan.push({
      hourStartISO: h.start,
      decision,
      targetPower_kW: round2(power_kW),
      socEnd: round3(soc),
      price_buy_SEK: round2(price)
    });
  }

  return plan;
}

// =================== REALTIDS-BESLUT ===================
function decideRealtime(flows_kW, socNow, priceNowState, socTargetEndOfToday, todayHours, classesAll, avgBuyToday, avgCheapBuyToday, avgCheapBuyTomorrow, avgCheapBuyAll) {
  const now = new Date();

  const pv_surplus_kW = Math.max(0, (flows_kW.prod_kW || 0) - (flows_kW.load_kW || 0));
  const load_gap_kW   = Math.max(0, (flows_kW.load_kW || 0) - (flows_kW.prod_kW || 0));

  const baseCap = capSoCForHour(now);
  const reserveActive = baseCap < HARD_MAX_SOC - 1e-6;
  const socClamped = clamp01(socNow);

  let capNow = baseCap;
  if (pv_surplus_kW > pvNoiseFloor_kW && capNow < HARD_MAX_SOC) {
    capNow = HARD_MAX_SOC;
  }

  // SoC-baserade begränsningar
  const room_kWh = Math.max(0, (capNow - Math.min(socClamped, HARD_MAX_SOC)) * batteryCapacity_kWh);
  const socLimitedCharge_kW = Math.max(0, room_kWh / chargeEff);

  const avail_kWh = Math.max(0, (Math.max(socClamped, HARD_MIN_SOC) - HARD_MIN_SOC) * batteryCapacity_kWh);
  const socLimitedDischarge_kW = Math.max(0, avail_kWh * dischargeEff);

  // Definiera “var är vi i klassningen” för aktuell timme
  const inTop10  = priceNowState.inTop10 === true;
  const inNext30 = priceNowState.inNext30 === true;
  const slotSellPrice = Number(priceNowState.sellPrice);
  const marginBaselineNow = marginBaselineForSlot(priceNowState?.slot?.start, avgCheapBuyToday, avgCheapBuyTomorrow, avgCheapBuyAll);

  if (reserveActive && pv_surplus_kW <= pvNoiseFloor_kW && socClamped > baseCap + 1e-3 && socLimitedDischarge_kW > pvNoiseFloor_kW) {
    const deltaSoc = socClamped - Math.max(baseCap, HARD_MIN_SOC);
    if (deltaSoc > 1e-4) {
      const bleedNeed_kW = Math.min(maxDischargePower_kW, socLimitedDischarge_kW, deltaSoc * batteryCapacity_kWh * dischargeEff);
      const loadTarget = Math.min(load_gap_kW, bleedNeed_kW);
      if (loadTarget > pvNoiseFloor_kW) {
        return { mode: "discharge", power_kW: round2(loadTarget), reason: `RESERVE: sänker SoC mot ${Math.round(baseCap*100)}%` };
      }
      if (inTop10 && sellMarginOk(slotSellPrice, marginBaselineNow) && bleedNeed_kW > pvNoiseFloor_kW) {
        return { mode: "discharge", power_kW: round2(bleedNeed_kW), reason: `RESERVE: export för att nå ${Math.round(baseCap*100)}%` };
      }
    }
  }

  // 0) Solar-first (respektera cap)
  if (pv_surplus_kW > pvNoiseFloor_kW && socClamped < HARD_MAX_SOC - 1e-6) {
    const p = Math.min(pv_surplus_kW, socLimitedCharge_kW, maxChargePower_kW);
    if (p > pvNoiseFloor_kW) {
      return { mode: "charge", power_kW: round2(p), reason: `Solar-first: PV-överskott ${round2(pv_surplus_kW)} kW (cap ${Math.round(capNow*100)}%)` };
    }
  }

  // 1) Dyraste 10% → export tillåten (sälj)
  if (inTop10) {
    const marginReady = sellMarginOk(slotSellPrice, marginBaselineNow);
    if (!marginReady) {
      if (socLimitedDischarge_kW > 0) {
        const shaveTarget = Math.min(load_gap_kW, socLimitedDischarge_kW, maxDischargePower_kW);
        if (shaveTarget > 0) {
          return { mode: "discharge", power_kW: round2(shaveTarget), reason: `SELL: marginal < ${Math.round(minimumSellMargin_SEK*100)} öre → load-shaving` };
        }
      }
      return { mode: "idle", power_kW: 0, reason: `SELL: marginal < ${Math.round(minimumSellMargin_SEK*100)} öre (sparar batteriet)` };
    }
    if (socLimitedDischarge_kW > 0) {
      const target = Math.min(maxDischargePower_kW, socLimitedDischarge_kW);
      return { mode: "discharge", power_kW: round2(target), reason: `SELL: topp 10% dyrast – export OK` };
    }
    return { mode: "idle", power_kW: 0, reason: "SELL: topp 10% – men SoC vid min" };
  }

  // 2) Nästa 30% dyrast → endast last-shaving (ingen export)
  if (inNext30) {
    const target = Math.min(load_gap_kW, socLimitedDischarge_kW, maxDischargePower_kW);
    if (target > 0) {
      return { mode: "discharge", power_kW: round2(target), reason: `EXPENSIVE (30%): last-shaving, ingen export` };
    }
    // ingen last att shava → idle
    return { mode: "idle", power_kW: 0, reason: `EXPENSIVE (30%): ingen last att shava` };
  }

  // 3) Billigt → ladda (import OK), men aldrig över 90%
  if (priceNowState.state === "cheap" && allowGridChargeWhenCheap && socClamped < HARD_MAX_SOC - 1e-6) {
    const p = Math.min(socLimitedCharge_kW, maxChargePower_kW);
    if (p > 0) return { mode: "charge", power_kW: round2(p), reason: `CHEAP: laddar (cap ${Math.round(baseCap*100)}%)` };
  }

  // 4) “Mid” → ev. last-shaving om pris ≥ snitt*bias (ingen export)
  if (priceNowState.state === "normal") {
    const midThreshold = (avgBuyToday || 0) * priceMidBias;
    if (priceNowState.price >= midThreshold && socClamped > midDischargeFloorSoC + 1e-3) {
      const availOverFloor_kWh = Math.max(0, (socClamped - midDischargeFloorSoC) * batteryCapacity_kWh);
      const allow_kW = Math.min(availOverFloor_kWh * dischargeEff, maxDischargePower_kW);
      const target = Math.min(load_gap_kW, allow_kW); // begränsa till last → ingen export
      if (target > 0) return { mode: "discharge", power_kW: round2(target), reason: `MID: shavar import (buffert ≥ ${Math.round(midDischargeFloorSoC*100)}%)` };
    }
  }

  // 5) Ladda mot mål till midnatt om det behövs (ej över 90)
  if (socTargetEndOfToday != null && socClamped < socTargetEndOfToday && allowGridChargeToMeetTomorrowGoal) {
    const p = Math.min(socLimitedCharge_kW, maxChargePower_kW);
    if (p > 0) return { mode: "charge", power_kW: round2(p), reason: `Mot mål till midnatt (cap ${Math.round(capNow*100)}%)` };
  }

  return { mode: "idle", power_kW: 0, reason: "Neutral: ingen PV-överskott/pristrigger" };
}

// =================== MAIN ===================
async function main() {
  // Indata
  const argStr = getArgString();
  console.log("🔧 Argumentsträng:", argStr);
  const parsed = parseArgString(argStr);

  const battery_soc = normalizeSoc(parsed.battery_soc_raw);
  const flows_kW = normalizeFlowsFromW({
    producing_W: parsed.producing_W ?? 0,
    grid_flow_W: parsed.grid_flow_W ?? 0,
    local_flow_W: parsed.local_flow_W ?? 0,
    battery_flow_W: parsed.battery_flow_W ?? 0
  });
  const bal = balanceCheck(flows_kW);

  console.log("📥 Indata (rå, W):", {
    producing_W: parsed.producing_W ?? 0,
    grid_flow_W: parsed.grid_flow_W ?? 0,
    local_flow_W: parsed.local_flow_W ?? 0,
    battery_flow_W: parsed.battery_flow_W ?? 0,
    battery_soc_raw: parsed.battery_soc_raw
  });
  console.log("🔁 Normaliserade flöden (kW):", flows_kW);
  console.log("🔋 SoC:", `${Math.round(battery_soc*100)}%`);
  console.log("⚖️ Balanscheck (kW):", bal);

  // Priser
  const { todayHours, tomorrowHours } = await fetchTodayAndMaybeTomorrow(REGION);
  const classesToday    = classifyPrices(todayHours);
  const classesAll      = classifyPrices([...todayHours, ...tomorrowHours]); // för “nu”
  const priceNowState   = priceStateNow([...todayHours, ...tomorrowHours], classesAll);
  const classesTomorrow = classifyPrices(tomorrowHours);
  const avgBuyTodaySEK  = avgBuy(todayHours);
  const avgCheapBuyTodaySEK = averagePriceForSet(todayHours, classesToday.cheapSet, 'buy_SEK');
  const avgCheapBuyTomorrowSEK = averagePriceForSet(tomorrowHours, classesTomorrow.cheapSet, 'buy_SEK');
  const avgCheapBuyAllSEK = averagePriceForSet([...todayHours, ...tomorrowHours], classesAll.cheapSet, 'buy_SEK');

  console.log("💸 Pris nu:", { state: priceNowState.state, price_buy_SEK_per_kWh: round2(priceNowState.price || NaN), avg_buy_today: round2(avgBuyTodaySEK) });

  // Mål SoC till midnatt (hårda gränser beaktas i computeSoCTarget…)
  const { targetSoC, profitCheck } = computeSoCTargetForMidnight(todayHours, tomorrowHours, classesAll);
  if (profitCheck) console.log("📈 Lönsamhetskoll inför imorgon:", profitCheck);
  if (targetSoC != null) console.log("🎯 SoC-mål till midnatt:", `${Math.round(targetSoC*100)}%`);

  applySolarReserveCaps(todayHours, tomorrowHours, classesAll);
  const capNowForLog = capSoCForHour(new Date());
  console.log("🔝 SoC-cap nu:", `${Math.round(capNowForLog*100)}%`);

  // Realtidsbeslut
  const actionNow = decideRealtime(flows_kW, battery_soc, priceNowState, targetSoC, todayHours, classesAll, avgBuyTodaySEK, avgCheapBuyTodaySEK, avgCheapBuyTomorrowSEK, avgCheapBuyAllSEK);
  const safeMode = normalizeMode(actionNow.mode);
  const power_W = Math.max(0, Math.round(actionNow.power_kW * 1000)); // positiv effekt, riktning via mode

  // ===== Plan (resterande idag) =====
  const now = new Date();
  const futureToday = todayHours.filter(h => new Date(h.start) > now);
  const planToday = buildPlan(futureToday, classesToday, battery_soc, avgBuyTodaySEK, avgCheapBuyTodaySEK);

  console.log("🗓️ Plan (resterande idag):");
  if (planToday.length === 0) console.log("— Inga timmar kvar idag.");
  else planToday.forEach(p => console.log(`${p.hourStartISO} → ${p.decision.toUpperCase()} @ ${p.targetPower_kW} kW (SoC end: ${(p.socEnd*100).toFixed(1)}%) [${p.price_buy_SEK} kr/kWh]`));

  const socAtMidnight = planToday.length ? planToday[planToday.length - 1].socEnd : battery_soc;

  // ===== Plan (imorgon) =====
  console.log("🗓️ Plan (imorgon):");
  let planTomorrow = [];
  if (tomorrowHours.length === 0) {
    console.log("— Ej tillgängligt ännu (morgondagens priser publiceras efter kl 13).");
  } else {
    const startSocTomorrow   = (targetSoC != null) ? targetSoC : socAtMidnight;
    const avgBuyTomorrowSEK  = avgBuy(tomorrowHours);
    planTomorrow = buildPlan(tomorrowHours, classesTomorrow, startSocTomorrow, avgBuyTomorrowSEK, avgCheapBuyTomorrowSEK);
    planTomorrow.forEach(p => console.log(`${p.hourStartISO} → ${p.decision.toUpperCase()} @ ${p.targetPower_kW} kW (SoC end: ${(p.socEnd*100).toFixed(1)}%) [${p.price_buy_SEK} kr/kWh]`));
  }

  // =================== TAGS (String/Number wrappers) ===================
  await setTagString('battery_action', safeMode);                               // 'charge' | 'discharge' | 'idle'
  await setTagNumber('battery_power_W', power_W);                               // positiv W
  await setTagString('battery_reason', actionNow.reason || '');

  await setTagNumber('battery_soc_percent', Math.round((battery_soc ?? 0) * 100));
  await setTagNumber('price_now_SEK_per_kWh', Number.isFinite(priceNowState.price) ? round2(priceNowState.price) : 0);
  await setTagNumber('target_soc_end_today_percent', (targetSoC != null && Number.isFinite(targetSoC)) ? Math.round(targetSoC * 100) : 0);
  await setTagNumber('battery_soc_cap_percent', Math.round((capNowForLog ?? HARD_MAX_SOC) * 100));
  await setTagNumber('solar_reserve_active', (capNowForLog < HARD_MAX_SOC - 1e-6) ? 1 : 0);

  try { await setTagString('plan_today_json', JSON.stringify(planToday || [])); } catch (_) { await setTagString('plan_today_json', '[]'); }
  try { await setTagString('plan_tomorrow_json', JSON.stringify(planTomorrow || [])); } catch (_) { await setTagString('plan_tomorrow_json', '[]'); }

  console.log("🚦 Beslut NU:", { mode: safeMode, power_kW: actionNow.power_kW, reason: actionNow.reason }, "| power_W:", power_W);

  // Returnera en String (objekt) för Flow
  return new String(safeMode);
}

// Kör
return await main();
