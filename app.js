/* ============================================================
   LINE PULSE — app.js
   Toàn bộ logic mô phỏng & giao diện, chạy hoàn toàn phía client.
   Không cần server / backend — mở index.html là dùng được, hoặc
   deploy như một static site (Nginx, S3, GitHub Pages, v.v.)
   ============================================================ */

(function(){
"use strict";

const STORAGE_KEY = "linePulse.v1";

/* ---------------------------------------------------------
   1. STATE
   --------------------------------------------------------- */
function defaultConfig(){
  const today = new Date();
  const y = today.getFullYear(), m=String(today.getMonth()+1).padStart(2,"0"), d=String(today.getDate()).padStart(2,"0");
  return {
    capTrim: 24, capChassis: 30, capFinal: 14,
    uph: 60, takt: 60,
    lineStartDate: `${y}-${m}-${d}`,
    shiftStart: "08:00", shiftEnd: "17:00",
    breaks: [
      {start:"10:00", end:"10:15"},
      {start:"12:00", end:"13:00"},
      {start:"15:00", end:"15:15"}
    ],
    holidays: []   // ["YYYY-MM-DD", ...] — ngày không sản xuất
  };
}

const LOT_PALETTE = [
  "#F2B705","#EF8A1E","#E2564F","#D6479B","#9B5DE5",
  "#5E60CE","#5089C2","#48BFE3","#3FB37F","#7FB800",
  "#C9A227","#FF6B6B","#FFA36C","#FFD166","#06D6A0",
  "#118AB2","#EF476F","#8338EC","#3A86FF","#FB5607"
];

let state = {
  config: defaultConfig(),
  lots: [],          // {id, code, model, spec, originalQty}
  consumedMap: {},    // lotId -> số xe đã vào chuyền
  entryLog: [],        // {tick, lotId, code, model, spec, unitIndex, totalQty, entryTime, exitTime, empty}
  simTime: new Date().toISOString(),
  nextId: 1,
  currentTick: 0,
  lotColors: {},       // mã lot -> màu (gán 1 lần, giữ ổn định)
  lotColorCounter: 0
};

let playing = false;
let speed = 60;
let lastFrameTs = null;
let toastTimer = null;

/* ---------------------------------------------------------
   2. PERSISTENCE
   --------------------------------------------------------- */
function saveState(){
  try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }catch(e){ console.warn("Không lưu được localStorage", e); }
}
function loadState(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return;
    const parsed = JSON.parse(raw);
    state = Object.assign(state, parsed);
    state.config = Object.assign(defaultConfig(), parsed.config||{});
  }catch(e){ console.warn("Không đọc được dữ liệu đã lưu", e); }
}

/* ---------------------------------------------------------
   3. SCHEDULE-AWARE TIME HELPERS
   --------------------------------------------------------- */
function dateAtTime(baseDate, hhmm){
  const d = new Date(baseDate);
  const [h,m] = hhmm.split(":").map(Number);
  d.setHours(h,m,0,0);
  return d;
}
function startOfDay(date){ const d=new Date(date); d.setHours(0,0,0,0); return d; }
function addDays(date,n){ const d=new Date(date); d.setDate(d.getDate()+n); return d; }
function sameCalendarDate(a,b){ return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate(); }
function fmtYMD(date){
  const y=date.getFullYear(), m=String(date.getMonth()+1).padStart(2,"0"), d=String(date.getDate()).padStart(2,"0");
  return `${y}-${m}-${d}`;
}
function isHoliday(date, config){
  return (config.holidays||[]).includes(fmtYMD(date));
}

function getDayWindow(date, config){
  const start = dateAtTime(date, config.shiftStart);
  const end = dateAtTime(date, config.shiftEnd);
  if(isHoliday(date, config)){
    // ngày nghỉ sản xuất: không có giờ làm việc nào trong ngày này
    return {start, end:start, breaks:[]};
  }
  const breaks = (config.breaks||[])
    .map(b=>({start:dateAtTime(date,b.start), end:dateAtTime(date,b.end)}))
    .filter(b=> b.end>start && b.start<end)
    .sort((a,b)=>a.start-b.start);
  return {start,end,breaks};
}
function workSecondsInWindowUntil(window, uptoTime){
  const t0 = window.start;
  const t1 = uptoTime<window.start ? window.start : (uptoTime>window.end ? window.end : uptoTime);
  if(t1<=t0) return 0;
  let ms = t1-t0;
  for(const b of window.breaks){
    const bs = b.start<t0?t0:b.start;
    const be = b.end>t1?t1:b.end;
    if(be>bs) ms -= (be-bs);
  }
  return Math.max(0, ms/1000);
}
function elapsedWorkSeconds(anchorDate, currentDate, config){
  if(currentDate<=anchorDate) return 0;
  let total=0;
  let day = startOfDay(anchorDate);
  const lastDay = startOfDay(currentDate);
  const anchorDay = startOfDay(anchorDate);
  while(day<=lastDay){
    const window = getDayWindow(day, config);
    const segStart = (day.getTime()===anchorDay.getTime()) ? (anchorDate>window.start?anchorDate:window.start) : window.start;
    const segEnd   = (day.getTime()===lastDay.getTime())  ? (currentDate<window.end?currentDate:window.end) : window.end;
    if(segEnd>segStart){
      let ms = segEnd-segStart;
      for(const b of window.breaks){
        const bs=b.start<segStart?segStart:b.start;
        const be=b.end>segEnd?segEnd:b.end;
        if(be>bs) ms -= (be-bs);
      }
      total += Math.max(0, ms/1000);
    }
    day = addDays(day,1);
  }
  return total;
}
function timeAfterWorkSeconds(window, fromTime, seconds){
  let remaining = seconds*1000;
  let segStart = fromTime;
  for(const b of window.breaks){
    if(b.end<=segStart) continue;
    if(b.start>segStart){
      const chunkMs = b.start-segStart;
      if(remaining<=chunkMs) return new Date(segStart.getTime()+remaining);
      remaining -= chunkMs;
    }
    if(b.end>segStart) segStart = b.end;
  }
  const chunkMs = window.end-segStart;
  if(remaining<=chunkMs) return new Date(segStart.getTime()+remaining);
  return new Date(window.end);
}
function dateFromElapsedWorkSeconds(anchorDate, targetSeconds, config){
  let remaining = targetSeconds;
  let day = startOfDay(anchorDate);
  let first = true;
  for(let guard=0; guard<100000; guard++){
    const window = getDayWindow(day, config);
    let segStart = first ? (anchorDate>window.start?anchorDate:window.start) : window.start;
    first = false;
    if(segStart>=window.end){ day = addDays(day,1); continue; }
    const availSec = workSecondsInWindowUntil(window, window.end) - workSecondsInWindowUntil(window, segStart);
    if(remaining<=availSec) return timeAfterWorkSeconds(window, segStart, remaining);
    remaining -= availSec;
    day = addDays(day,1);
  }
  return new Date(anchorDate);
}
function getAnchor(config){
  return new Date(`${config.lineStartDate}T${config.shiftStart}:00`);
}
function getShiftStatus(config, now){
  if(isHoliday(now, config)) return "holiday";
  const window = getDayWindow(now, config);
  if(now<window.start || now>window.end) return "idle";
  for(const b of window.breaks){ if(now>=b.start && now<b.end) return "break"; }
  return "running";
}

/* ---------------------------------------------------------
   4. SIMULATION ENGINE
   --------------------------------------------------------- */
function capacity(config){ return config.capTrim + config.capChassis + config.capFinal; }

function computeCurrentTick(config, simTimeIso){
  const anchor = getAnchor(config);
  const now = new Date(simTimeIso);
  const elapsed = elapsedWorkSeconds(anchor, now, config);
  return Math.max(0, Math.floor(elapsed / config.takt));
}

function nextAvailableLot(lots, consumedMap){
  for(const lot of lots){
    const consumed = consumedMap[lot.id]||0;
    if(consumed < lot.originalQty) return lot;
  }
  return null;
}

// Mutates ctx.entryLog / ctx.consumedMap up to targetTick. ctx = {config, lots, consumedMap, entryLog}
function syncEntryLog(ctx, targetTick){
  const anchor = getAnchor(ctx.config);
  const cap = capacity(ctx.config);
  while(ctx.entryLog.length < targetTick){
    const tick = ctx.entryLog.length + 1;
    const lot = nextAvailableLot(ctx.lots, ctx.consumedMap);
    const entryTime = dateFromElapsedWorkSeconds(anchor, tick*ctx.config.takt, ctx.config).toISOString();
    const exitTime = dateFromElapsedWorkSeconds(anchor, (tick+cap)*ctx.config.takt, ctx.config).toISOString();
    if(lot){
      const consumed = ctx.consumedMap[lot.id]||0;
      const unitIndex = consumed+1;
      ctx.consumedMap[lot.id] = unitIndex;
      ctx.entryLog.push({tick, lotId:lot.id, code:lot.code, model:lot.model, spec:lot.spec, unitIndex, totalQty:lot.originalQty, entryTime, exitTime, empty:false});
    } else {
      ctx.entryLog.push({tick, empty:true, entryTime, exitTime});
    }
  }
}

function recompute(){
  const ctx = {config:state.config, lots:state.lots, consumedMap:state.consumedMap, entryLog:state.entryLog};
  const ct = computeCurrentTick(state.config, state.simTime);
  syncEntryLog(ctx, ct);
  state.currentTick = ct;
}

function projectEndOfDay(){
  const now = new Date(state.simTime);
  const window = getDayWindow(now, state.config);
  const anchor = getAnchor(state.config);
  const elapsedAtEnd = elapsedWorkSeconds(anchor, window.end, state.config);
  const targetTick = Math.max(state.currentTick, Math.floor(elapsedAtEnd/state.config.takt));
  const ctx = {config:state.config, lots:state.lots, consumedMap:Object.assign({}, state.consumedMap), entryLog:state.entryLog.slice()};
  syncEntryLog(ctx, targetTick);
  return ctx.entryLog;
}

function getLinePositions(){
  const cap = capacity(state.config);
  const positions = new Array(cap).fill(null);
  for(let pos=1; pos<=cap; pos++){
    const tick = state.currentTick - pos + 1;
    if(tick>=1 && tick<=state.entryLog.length) positions[pos-1] = state.entryLog[tick-1];
  }
  return positions; // index0 = Trim entry (mới nhất) ... cuối mảng = Final exit (sắp hoàn thành)
}

/* ---------------------------------------------------------
   5. DOM HELPERS
   --------------------------------------------------------- */
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
function fmtTime(iso){ const d=new Date(iso); return d.toLocaleTimeString("vi-VN",{hour:"2-digit",minute:"2-digit"}); }
function fmtDateTime(iso){ const d=new Date(iso); return d.toLocaleString("vi-VN",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}); }
function toast(msg){
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>el.classList.remove("show"), 2400);
}
function openModal(id){ $("#"+id).classList.add("open"); }
function closeModal(id){ $("#"+id).classList.remove("open"); }

function getLotColor(code){
  if(!code) return "#3a4557";
  if(!state.lotColors[code]){
    state.lotColors[code] = LOT_PALETTE[state.lotColorCounter % LOT_PALETTE.length];
    state.lotColorCounter++;
  }
  return state.lotColors[code];
}
function darken(hex, amt){
  const n = parseInt(hex.replace("#",""),16);
  const r = Math.max(0,(n>>16)-amt), g=Math.max(0,((n>>8)&0xff)-amt), b=Math.max(0,(n&0xff)-amt);
  return `rgb(${r},${g},${b})`;
}
function swatch(code){ return `<span class="swatch" style="background:${getLotColor(code)}"></span>`; }

/* ---------------------------------------------------------
   6. RENDERING
   --------------------------------------------------------- */
function renderClock(){
  const now = new Date(state.simTime);
  $("#simClockDisplay").textContent = now.toLocaleTimeString("vi-VN",{hour12:false});
  $("#simDateDisplay").textContent = now.toLocaleDateString("vi-VN",{weekday:"short", day:"2-digit", month:"2-digit", year:"numeric"});
  $("#tickDisplay").textContent = `Tick #${state.currentTick}`;
  const status = getShiftStatus(state.config, now);
  const pill = $("#shiftStatus");
  pill.className = "pill " + (status==="running"?"pill--running":status==="break"?"pill--break":status==="holiday"?"pill--holiday":"pill--idle");
  pill.textContent = status==="running" ? (playing ? "Đang chạy" : "Trong ca (đang dừng)") : status==="break" ? "Đang nghỉ" : status==="holiday" ? "Ngày nghỉ sản xuất" : "Ngoài ca";
  $("#playPauseBtn").textContent = playing ? "❚❚" : "▶";
}

function cellHtml(car, newestCar, oldestCar){
  if(!car || car.empty) return `<div class="ld-cell"></div>`;
  const color = getLotColor(car.code);
  const classes = ["ld-cell","filled"];
  if(car===newestCar) classes.push("just-entered");
  if(car===oldestCar) classes.push("about-to-exit");
  return `<div class="${classes.join(" ")}" style="background:linear-gradient(180deg, ${color}, ${darken(color,55)})">
    <div class="cell-tip">${car.code} <small>${car.model||""} ${car.spec||""} · xe ${car.unitIndex}/${car.totalQty}</small></div>
  </div>`;
}
function hArrowSvg(dir){
  const id = "arr"+Math.random().toString(36).slice(2,8);
  const d = dir==="left" ? "M95,13 L8,13" : "M8,13 L95,13";
  return `<svg viewBox="0 0 100 26" preserveAspectRatio="none">
    <defs><marker id="${id}" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#5089c2"/></marker></defs>
    <path d="${d}" fill="none" stroke="#5089c2" stroke-width="3" marker-end="url(#${id})"/>
  </svg>`;
}
function loopArrowSvg(){
  return `<svg viewBox="0 0 40 300" preserveAspectRatio="none">
    <defs><marker id="loopHead" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#5089c2"/></marker></defs>
    <path d="M35,40 C5,40 5,260 35,260" fill="none" stroke="#5089c2" stroke-width="3" marker-end="url(#loopHead)"/>
  </svg>`;
}

// Vẽ sơ đồ giống layout gốc: Trim -> Chassis 1 -> (vòng lặp) -> Chassis 2 -> Final.
// Mỗi ô xe được tô theo màu riêng của lot (không còn tô theo zone).
function renderLineDiagram(){
  const positions = getLinePositions(); // idx0 = Trim entry (mới nhất) ... cuối = Final exit (sắp xong)
  const c = state.config;
  const newestCar = positions[0];
  const oldestCar = positions[positions.length-1];

  const trimSlice = positions.slice(0, c.capTrim);
  const chassisSlice = positions.slice(c.capTrim, c.capTrim+c.capChassis);
  const finalSlice = positions.slice(c.capTrim+c.capChassis);
  const half1 = Math.ceil(c.capChassis/2);
  const chassis1Slice = chassisSlice.slice(0, half1);
  const chassis2Slice = chassisSlice.slice(half1);

  // sắp xếp trái->phải theo đúng hướng dòng chảy thực tế trong sơ đồ
  const trimDisplay = trimSlice.slice().reverse();       // trái = sắp sang Chassis 1, phải = mới vào nhất
  const chassis1Display = chassis1Slice.slice().reverse();// trái = sắp sang Chassis 2 (qua vòng lặp), phải = vừa nhận từ Trim
  const chassis2Display = chassis2Slice.slice();          // trái = vừa nhận từ Chassis 1, phải = sắp sang Final
  const finalDisplay = finalSlice.slice();                 // trái = vừa nhận từ Chassis 2, phải = sắp hoàn thành

  const countFilled = arr => arr.filter(x=>x && !x.empty).length;
  const cellsHtml = arr => arr.map(car=>cellHtml(car, newestCar, oldestCar)).join("");

  const wrap = $("#zoneTracks");
  wrap.innerHTML = `
    <div class="ld-loop">${loopArrowSvg()}</div>

    <div class="ld-box ld-box--chassis1">
      <div class="ld-feed ld-feed--top">↓ ↓</div>
      <div class="ld-box-head"><b>Chassis line: Chassis 1</b><span>${countFilled(chassis1Display)}/${chassis1Display.length} xe</span></div>
      <div class="ld-cells">${cellsHtml(chassis1Display)}</div>
    </div>

    <div class="ld-arrow ld-arrow--tc">${hArrowSvg("left")}</div>

    <div class="ld-box ld-box--trim">
      <div class="ld-feed ld-feed--top">↓ ↓ ↓ ↓</div>
      <div class="ld-box-head"><b>Trim line: Trim 1 – Trim 4</b><span>${countFilled(trimDisplay)}/${trimDisplay.length} xe</span></div>
      <div class="ld-cells">${cellsHtml(trimDisplay)}</div>
    </div>

    <div class="ld-box ld-box--chassis2">
      <div class="ld-box-head"><b>Chassis line: Chassis 2</b><span>${countFilled(chassis2Display)}/${chassis2Display.length} xe</span></div>
      <div class="ld-cells">${cellsHtml(chassis2Display)}</div>
      <div class="ld-feed ld-feed--bottom">↑ ↑</div>
    </div>

    <div class="ld-arrow ld-arrow--cf">${hArrowSvg("right")}</div>

    <div class="ld-box ld-box--final">
      <div class="ld-box-head"><b>Final line: Final 1 – Final 3</b><span>${countFilled(finalDisplay)}/${finalDisplay.length} xe</span></div>
      <div class="ld-cells">${cellsHtml(finalDisplay)}</div>
      <div class="ld-feed ld-feed--bottom">↑ ↑</div>
    </div>
  `;

  // tóm tắt các lot đang hiện diện theo từng chuyền lớn (Trim / Chassis / Final)
  const zones = [
    {name:"Trim", slice:trimSlice},
    {name:"Chassis", slice:chassisSlice},
    {name:"Final", slice:finalSlice}
  ];
  const barWrap = $("#currentLotsBar");
  barWrap.innerHTML = "";
  zones.forEach(zone=>{
    const slice = zone.slice.filter(p=>p && !p.empty);
    const map = new Map(); const seen=[];
    slice.forEach(car=>{
      if(!map.has(car.code)){ map.set(car.code,{code:car.code, model:car.model, spec:car.spec, count:0}); seen.push(car.code); }
      map.get(car.code).count++;
    });
    seen.forEach(code=>{
      const info = map.get(code);
      const chip = document.createElement("div");
      chip.className = "current-lot-chip";
      chip.innerHTML = `<span class="zone-tag">${zone.name}</span><span class="lot-code">${swatch(info.code)}${info.code}</span><span class="lot-meta">${info.model||""} ${info.spec||""} · ${info.count} xe</span>`;
      barWrap.appendChild(chip);
    });
  });
  if(!barWrap.children.length){
    barWrap.innerHTML = `<div class="empty-note">Chuyền đang trống — chưa có xe nào vào chuyền.</div>`;
  }
}

function renderNowEntering(){
  const card = $("#nowEnteringCard");
  const last = state.entryLog[state.currentTick-1];
  if(!last || last.empty){
    card.innerHTML = `<div class="meta">Chưa có xe vào chuyền tại thời điểm này.</div>`;
    return;
  }
  const pct = Math.round((last.unitIndex/last.totalQty)*100);
  card.innerHTML = `
    <div class="code">${swatch(last.code)}${last.code}</div>
    <div class="meta">${last.model||""} ${last.spec||""}</div>
    <div class="meta">Xe thứ ${last.unitIndex} / ${last.totalQty} · vào Trim lúc ${fmtTime(last.entryTime)}</div>
    <div class="progress"><div class="progress-fill" style="width:${pct}%"></div></div>
    <div class="progress-label">${pct}% lot đã vào chuyền</div>
  `;
}

function summarizeByExitToday(entries, predicate){
  const map = new Map();
  for(const e of entries){
    if(e.empty) continue;
    if(!predicate(e)) continue;
    if(!map.has(e.code)) map.set(e.code, {code:e.code, model:e.model, spec:e.spec, count:0, lastExit:e.exitTime});
    const o = map.get(e.code);
    o.count++;
    if(new Date(e.exitTime) > new Date(o.lastExit)) o.lastExit = e.exitTime;
  }
  return Array.from(map.values());
}

function renderForecasts(){
  const now = new Date(state.simTime);
  const cap = capacity(state.config);

  const projected = projectEndOfDay();
  const forecast = summarizeByExitToday(projected, e=> sameCalendarDate(new Date(e.exitTime), now));
  const forecastEl = $("#todayForecast");
  forecastEl.innerHTML = "";
  if(!forecast.length){
    forecastEl.innerHTML = `<div class="empty-note">Chưa có lot nào dự kiến hoàn thành hôm nay.</div>`;
  } else {
    forecast.sort((a,b)=> new Date(a.lastExit)-new Date(b.lastExit));
    forecast.forEach(f=>{
      const row = document.createElement("div");
      row.className = "forecast-row";
      row.innerHTML = `<span class="lot">${swatch(f.code)}${f.code}</span><span class="time">~${fmtTime(f.lastExit)}</span><span class="qty">${f.count} xe</span>`;
      forecastEl.appendChild(row);
    });
  }

  const completed = summarizeByExitToday(state.entryLog, e=> sameCalendarDate(new Date(e.exitTime), now) && (e.tick+cap)<=state.currentTick);
  const doneEl = $("#completedTodaySummary");
  doneEl.innerHTML = "";
  if(!completed.length){
    doneEl.innerHTML = `<div class="empty-note">Chưa có xe nào hoàn thành hôm nay.</div>`;
  } else {
    completed.sort((a,b)=> new Date(a.lastExit)-new Date(b.lastExit));
    let total = 0;
    completed.forEach(f=>{
      total += f.count;
      const row = document.createElement("div");
      row.className = "forecast-row";
      row.innerHTML = `<span class="lot">${swatch(f.code)}${f.code}</span><span class="time">${fmtTime(f.lastExit)}</span><span class="qty">${f.count} xe</span>`;
      doneEl.appendChild(row);
    });
    const totalRow = document.createElement("div");
    totalRow.className = "forecast-row";
    totalRow.style.borderColor = "var(--good)";
    totalRow.innerHTML = `<span class="lot">Tổng</span><span class="time"></span><span class="qty">${total} xe</span>`;
    doneEl.appendChild(totalRow);
  }
}

let dragState = null;

function renderQueueTable(){
  const tbody = $("#queueTbody");
  tbody.innerHTML = "";
  const remaining = state.lots.filter(l => (l.originalQty-(state.consumedMap[l.id]||0)) > 0);
  if(!remaining.length){
    tbody.innerHTML = `<tr><td colspan="8" style="font-family:var(--font-sans); color:var(--text-dim); text-align:center; padding:22px;">Hàng đợi trống — nhập lot từ Excel/CSV hoặc thêm thủ công.</td></tr>`;
    return;
  }
  remaining.forEach((lot, idx)=>{
    const consumed = state.consumedMap[lot.id]||0;
    const remQty = lot.originalQty - consumed;
    const tr = document.createElement("tr");
    tr.draggable = true;
    tr.dataset.id = lot.id;
    tr.innerHTML = `
      <td class="col-drag"><span class="drag-handle">☰</span></td>
      <td>${idx+1}</td>
      <td>${swatch(lot.code)}${lot.code}</td>
      <td>${lot.model||""}</td>
      <td>${lot.spec||""}</td>
      <td><input type="number" class="qty-input" min="0" value="${remQty}" data-id="${lot.id}"></td>
      <td>${consumed}</td>
      <td><button class="row-btn" data-del="${lot.id}" title="Xoá phần còn lại">✕</button></td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll(".qty-input").forEach(inp=>{
    inp.addEventListener("change", ()=>{
      const id = Number(inp.dataset.id);
      const lot = state.lots.find(l=>l.id===id);
      if(!lot) return;
      const consumed = state.consumedMap[id]||0;
      const newRem = Math.max(0, parseInt(inp.value,10)||0);
      lot.originalQty = consumed + newRem;
      toast(`Đã cập nhật số lượng còn lại của lot ${lot.code}`);
      renderAll(); saveState();
    });
  });
  tbody.querySelectorAll("[data-del]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const id = Number(btn.dataset.del);
      const lot = state.lots.find(l=>l.id===id);
      if(!lot) return;
      const consumed = state.consumedMap[id]||0;
      if(consumed===0){
        state.lots = state.lots.filter(l=>l.id!==id);
      } else {
        lot.originalQty = consumed;
      }
      toast(`Đã xoá phần còn lại của lot ${lot.code}`);
      renderAll(); saveState();
    });
  });

  tbody.querySelectorAll("tr[draggable]").forEach(row=>{
    row.addEventListener("dragstart", e=>{
      dragState = Number(row.dataset.id);
      row.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    });
    row.addEventListener("dragend", ()=>{ row.classList.remove("dragging"); dragState=null; });
    row.addEventListener("dragover", e=>{
      e.preventDefault();
      if(dragState===null) return;
      const targetId = Number(row.dataset.id);
      if(targetId===dragState) return;
      const rect = row.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height/2;
      reorderLots(dragState, targetId, before);
      renderQueueTable();
      saveState();
    });
  });
}

function reorderLots(draggedId, targetId, before){
  const arr = state.lots;
  const di = arr.findIndex(l=>l.id===draggedId);
  if(di<0) return;
  const [item] = arr.splice(di,1);
  let ti = arr.findIndex(l=>l.id===targetId);
  if(ti<0) ti = arr.length;
  arr.splice(before?ti:ti+1, 0, item);
}

function renderLogTable(){
  const tbody = $("#logTbody");
  tbody.innerHTML = "";
  const cap = capacity(state.config);
  const recent = state.entryLog.slice(-60).reverse();
  if(!recent.length){
    tbody.innerHTML = `<tr><td colspan="8" style="font-family:var(--font-sans); color:var(--text-dim); text-align:center; padding:18px;">Chưa có dữ liệu.</td></tr>`;
    return;
  }
  recent.forEach(e=>{
    const tr = document.createElement("tr");
    let statusHtml;
    if(e.empty){
      statusHtml = `<span class="status-tag status-tag--wait">Trống</span>`;
    } else if((e.tick+cap)<=state.currentTick){
      statusHtml = `<span class="status-tag status-tag--done">Hoàn thành</span>`;
    } else {
      statusHtml = `<span class="status-tag status-tag--live">Đang chạy</span>`;
    }
    tr.innerHTML = `
      <td>${e.tick}</td>
      <td>${fmtDateTime(e.entryTime)}</td>
      <td>${fmtDateTime(e.exitTime)}</td>
      <td>${e.empty?"—":(swatch(e.code)+e.code)}</td>
      <td>${e.empty?"—":(e.model||"")}</td>
      <td>${e.empty?"—":(e.spec||"")}</td>
      <td>${e.empty?"—":`${e.unitIndex}/${e.totalQty}`}</td>
      <td>${statusHtml}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderAll(){
  renderClock();
  renderLineDiagram();
  renderNowEntering();
  renderForecasts();
  renderQueueTable();
  renderLogTable();
}

/* ---------------------------------------------------------
   7. TIME CONTROL
   --------------------------------------------------------- */
function setSimTime(date){
  state.simTime = date.toISOString();
  recompute();
  renderAll();
}
function jump(seconds){
  setSimTime(new Date(new Date(state.simTime).getTime() + seconds*1000));
  saveState();
}
function tickLoop(ts){
  if(lastFrameTs===null) lastFrameTs = ts;
  const deltaReal = (ts-lastFrameTs)/1000;
  lastFrameTs = ts;
  if(playing){
    setSimTime(new Date(new Date(state.simTime).getTime() + deltaReal*speed*1000));
  }
  requestAnimationFrame(tickLoop);
}
let saveThrottle = null;
function throttledSave(){
  if(saveThrottle) return;
  saveThrottle = setTimeout(()=>{ saveState(); saveThrottle=null; }, 1500);
}

/* ---------------------------------------------------------
   8. SETTINGS MODAL
   --------------------------------------------------------- */
let holidayDraft = [];

function openSettings(){
  const c = state.config;
  $("#capTrim").value = c.capTrim;
  $("#capChassis").value = c.capChassis;
  $("#capFinal").value = c.capFinal;
  $("#uphInput").value = c.uph;
  $("#taktInput").value = c.takt;
  $("#lineStartDate").value = c.lineStartDate;
  $("#shiftStart").value = c.shiftStart;
  $("#shiftEnd").value = c.shiftEnd;
  renderBreaksList(c.breaks);
  holidayDraft = (c.holidays||[]).slice();
  renderHolidaysList();
  openModal("settingsModal");
}
function renderHolidaysList(){
  const wrap = $("#holidaysList");
  holidayDraft.sort();
  if(!holidayDraft.length){
    wrap.innerHTML = `<div class="empty-note">Chưa có ngày nghỉ nào — mặc định mọi ngày đều sản xuất theo giờ ca ở trên.</div>`;
    return;
  }
  wrap.innerHTML = holidayDraft.map(d=>{
    const [y,m,day] = d.split("-");
    return `<span class="holiday-chip">${day}/${m}/${y}<button class="row-btn" data-hol-del="${d}">✕</button></span>`;
  }).join("");
  wrap.querySelectorAll("[data-hol-del]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      holidayDraft = holidayDraft.filter(d=>d!==btn.dataset.holDel);
      renderHolidaysList();
    });
  });
}
function renderBreaksList(breaks){
  const wrap = $("#breaksList");
  wrap.innerHTML = "";
  breaks.forEach((b,i)=>{
    const row = document.createElement("div");
    row.className = "break-row";
    row.innerHTML = `
      <input type="time" class="brk-start" value="${b.start}">
      <span style="color:var(--text-dim)">→</span>
      <input type="time" class="brk-end" value="${b.end}">
      <button class="row-btn" data-brk-del="${i}">✕</button>
    `;
    wrap.appendChild(row);
  });
  wrap.querySelectorAll("[data-brk-del]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      breaks.splice(Number(btn.dataset.brkDel),1);
      renderBreaksList(breaks);
    });
  });
}
function collectBreaksFromForm(){
  return $$("#breaksList .break-row").map(row=>({
    start: row.querySelector(".brk-start").value,
    end: row.querySelector(".brk-end").value
  }));
}

/* ---------------------------------------------------------
   9. IMPORT (EXCEL / CSV)
   --------------------------------------------------------- */
let importCtx = { workbook:null, rawRows:[] };

function parseSheet(sheetName){
  const ws = importCtx.workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, {header:1, raw:false, defval:""});
  importCtx.rawRows = rows;
}

function colLabel(n){ // 0-indexed -> A, B, ... 
  let s=""; n++;
  while(n>0){ const r=(n-1)%26; s=String.fromCharCode(65+r)+s; n=Math.floor((n-1)/26); }
  return s;
}

function renderPreviewTable(){
  const table = $("#previewTable");
  const rows = importCtx.rawRows.slice(0, 16);
  const maxCols = rows.reduce((m,r)=>Math.max(m,r.length),0);
  let html = "<thead><tr><th></th>";
  for(let c=0;c<maxCols;c++) html += `<th>${colLabel(c)}</th>`;
  html += "</tr></thead><tbody>";
  rows.forEach((r,ri)=>{
    html += `<tr><th>${ri+1}</th>`;
    for(let c=0;c<maxCols;c++){ html += `<td>${(r[c]??"")}</td>`; }
    html += "</tr>";
  });
  html += "</tbody>";
  table.innerHTML = html;
}

function buildMappingGrid(){
  const orientation = $("#orientationSelect").value;
  const grid = $("#mappingGrid");
  const rows = importCtx.rawRows;
  const maxCols = rows.reduce((m,r)=>Math.max(m,r.length),0);

  function sampleForRow(ri){ return (rows[ri]||[]).slice(0,4).join(" | ").slice(0,28) || "(trống)"; }
  function sampleForCol(ci){ return rows.slice(0,4).map(r=>r[ci]??"").join(" | ").slice(0,28) || "(trống)"; }

  if(orientation==="rows"){
    const rowOptions = rows.map((r,i)=>`<option value="${i}">Dòng ${i+1}: ${sampleForRow(i).replace(/</g,"&lt;")}</option>`).join("");
    const colOptions = Array.from({length:maxCols}).map((_,c)=>`<option value="${c}">Cột ${colLabel(c)}: ${sampleForCol(c).replace(/</g,"&lt;")}</option>`).join("");
    grid.innerHTML = `
      <div class="form-field"><label>Dòng bắt đầu dữ liệu</label><select id="mapStartRow">${rowOptions}</select></div>
      <div class="form-field"><label>Cột Mã lot</label><select id="mapColCode">${colOptions}</select></div>
      <div class="form-field"><label>Cột Model</label><select id="mapColModel">${colOptions}</select></div>
      <div class="form-field"><label>Cột Spec</label><select id="mapColSpec">${colOptions}</select></div>
      <div class="form-field"><label>Cột Số lượng</label><select id="mapColQty">${colOptions}</select></div>
    `;
  } else {
    const colOptions = Array.from({length:maxCols}).map((_,c)=>`<option value="${c}">Cột ${colLabel(c)}: ${sampleForCol(c).replace(/</g,"&lt;")}</option>`).join("");
    const rowOptions = rows.map((r,i)=>`<option value="${i}">Dòng ${i+1}: ${sampleForRow(i).replace(/</g,"&lt;")}</option>`).join("");
    grid.innerHTML = `
      <div class="form-field"><label>Cột bắt đầu dữ liệu</label><select id="mapStartCol">${colOptions}</select></div>
      <div class="form-field"><label>Dòng Mã lot</label><select id="mapRowCode">${rowOptions}</select></div>
      <div class="form-field"><label>Dòng Model</label><select id="mapRowModel">${rowOptions}</select></div>
      <div class="form-field"><label>Dòng Spec</label><select id="mapRowSpec">${rowOptions}</select></div>
      <div class="form-field"><label>Dòng Số lượng</label><select id="mapRowQty">${rowOptions}</select></div>
    `;
  }
}

function handleFile(file){
  const reader = new FileReader();
  reader.onload = evt=>{
    try{
      const data = new Uint8Array(evt.target.result);
      const wb = XLSX.read(data, {type:"array"});
      importCtx.workbook = wb;
      const sheetSelect = $("#sheetSelect");
      sheetSelect.innerHTML = wb.SheetNames.map(n=>`<option value="${n}">${n}</option>`).join("");
      parseSheet(wb.SheetNames[0]);
      renderPreviewTable();
      buildMappingGrid();
      $("#importStep2").style.display = "block";
      $("#importConfirmBtn").style.display = "inline-block";
    }catch(err){
      console.error(err);
      toast("Không đọc được file. Kiểm tra định dạng .xlsx/.csv.");
    }
  };
  reader.readAsArrayBuffer(file);
}

function confirmImport(){
  const orientation = $("#orientationSelect").value;
  const rows = importCtx.rawRows;
  const newLots = [];

  if(orientation==="rows"){
    const startRow = Number($("#mapStartRow").value);
    const cCode = Number($("#mapColCode").value);
    const cModel = Number($("#mapColModel").value);
    const cSpec = Number($("#mapColSpec").value);
    const cQty = Number($("#mapColQty").value);
    for(let r=startRow; r<rows.length; r++){
      const row = rows[r]||[];
      const code = (row[cCode]??"").toString().trim();
      const qty = parseInt(row[cQty],10)||0;
      if(!code || qty<=0) continue;
      newLots.push({id:state.nextId++, code, model:(row[cModel]??"").toString().trim(), spec:(row[cSpec]??"").toString().trim(), originalQty:qty});
    }
  } else {
    const startCol = Number($("#mapStartCol").value);
    const rCode = Number($("#mapRowCode").value);
    const rModel = Number($("#mapRowModel").value);
    const rSpec = Number($("#mapRowSpec").value);
    const rQty = Number($("#mapRowQty").value);
    const maxCols = rows.reduce((m,r)=>Math.max(m,r.length),0);
    for(let c=startCol; c<maxCols; c++){
      const code = ((rows[rCode]||[])[c]??"").toString().trim();
      const qty = parseInt((rows[rQty]||[])[c],10)||0;
      if(!code || qty<=0) continue;
      newLots.push({id:state.nextId++, code, model:((rows[rModel]||[])[c]??"").toString().trim(), spec:((rows[rSpec]||[])[c]??"").toString().trim(), originalQty:qty});
    }
  }

  if(!newLots.length){
    toast("Không tìm thấy lot hợp lệ theo mapping đã chọn.");
    return;
  }

  const pos = $("#insertPosSelect").value;
  if(pos==="start") state.lots.unshift(...newLots);
  else state.lots.push(...newLots);

  toast(`Đã nhập ${newLots.length} lot vào hàng đợi.`);
  closeModal("importModal");
  resetImportUI();
  renderAll(); saveState();
}

function resetImportUI(){
  $("#importStep2").style.display = "none";
  $("#importConfirmBtn").style.display = "none";
  $("#fileInput").value = "";
  importCtx = {workbook:null, rawRows:[]};
}

function downloadTemplate(){
  const sample = [
    ["STT","Mã lot","Model","Spec","Số lượng"],
    [1,"1103","NX4-S1 PE","1.6 Turbo",30],
    [2,"219","KU-S2","1.5 T Special",30],
    [3,"1104","NX4-S1 PE","1.6 Turbo",30],
    [4,"283","Ai3-S6 FL","1.2 AT",30]
  ];
  const ws = XLSX.utils.aoa_to_sheet(sample);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Lots");
  XLSX.writeFile(wb, "mau_thu_tu_lot.xlsx");
}

/* ---------------------------------------------------------
   10. INIT & EVENT WIRING
   --------------------------------------------------------- */
function init(){
  loadState();
  recompute();
  renderAll();

  // clock loop
  requestAnimationFrame(tickLoop);

  // play/pause
  $("#playPauseBtn").addEventListener("click", ()=>{
    playing = !playing;
    lastFrameTs = null;
    renderClock();
  });
  $("#speedSelect").addEventListener("change", e=>{ speed = Number(e.target.value); });

  // jumps
  $$("[data-jump]").forEach(btn=>{
    btn.addEventListener("click", ()=>{ jump(Number(btn.dataset.jump)); });
  });

  // set time
  $("#setTimeInput").value = new Date(state.simTime).toISOString().slice(0,19);
  $("#applyTimeBtn").addEventListener("click", ()=>{
    const val = $("#setTimeInput").value;
    if(!val) return;
    setSimTime(new Date(val));
    saveState();
    toast("Đã cập nhật thời gian mô phỏng.");
  });

  // reset sim
  $("#resetSimBtn").addEventListener("click", ()=>{
    if(!confirm("Reset mô phỏng: xoá toàn bộ lịch sử xe đã vào chuyền và đưa giờ về đầu ca. Danh sách lot trong hàng đợi vẫn giữ nguyên. Tiếp tục?")) return;
    state.entryLog = [];
    state.consumedMap = {};
    state.simTime = getAnchor(state.config).toISOString();
    recompute();
    renderAll(); saveState();
    toast("Đã reset mô phỏng.");
  });

  // settings modal
  $("#btnSettings").addEventListener("click", openSettings);
  $("#addBreakBtn").addEventListener("click", ()=>{
    const breaks = collectBreaksFromForm();
    breaks.push({start:"00:00", end:"00:00"});
    renderBreaksList(breaks);
  });
  $("#addHolidayBtn").addEventListener("click", ()=>{
    const val = $("#newHolidayDate").value;
    if(!val) return;
    if(!holidayDraft.includes(val)) holidayDraft.push(val);
    $("#newHolidayDate").value = "";
    renderHolidaysList();
  });
  // keep UPH <-> takt linked live
  $("#uphInput").addEventListener("input", ()=>{
    const uph = parseFloat($("#uphInput").value);
    if(uph>0) $("#taktInput").value = (3600/uph).toFixed(1);
  });
  $("#taktInput").addEventListener("input", ()=>{
    const takt = parseFloat($("#taktInput").value);
    if(takt>0) $("#uphInput").value = (3600/takt).toFixed(1);
  });
  $("#saveSettingsBtn").addEventListener("click", ()=>{
    const hasHistory = state.entryLog.length>0;
    if(hasHistory && !confirm("Chuyền đã có lịch sử sản xuất. Đổi cấu hình có thể làm lệch dữ liệu đã ghi nhận trước đó. Vẫn lưu?")) return;
    state.config.capTrim = Math.max(1, parseInt($("#capTrim").value,10)||state.config.capTrim);
    state.config.capChassis = Math.max(1, parseInt($("#capChassis").value,10)||state.config.capChassis);
    state.config.capFinal = Math.max(1, parseInt($("#capFinal").value,10)||state.config.capFinal);
    state.config.uph = parseFloat($("#uphInput").value)||state.config.uph;
    state.config.takt = parseFloat($("#taktInput").value)||state.config.takt;
    state.config.lineStartDate = $("#lineStartDate").value || state.config.lineStartDate;
    state.config.shiftStart = $("#shiftStart").value || state.config.shiftStart;
    state.config.shiftEnd = $("#shiftEnd").value || state.config.shiftEnd;
    state.config.breaks = collectBreaksFromForm().filter(b=>b.start && b.end);
    state.config.holidays = holidayDraft.slice();
    recompute();
    renderAll(); saveState();
    closeModal("settingsModal");
    toast("Đã lưu cấu hình.");
  });

  // import modal
  $("#btnImport").addEventListener("click", ()=>{ resetImportUI(); openModal("importModal"); });
  $("#fileInput").addEventListener("change", e=>{ if(e.target.files[0]) handleFile(e.target.files[0]); });
  $("#downloadTemplateBtn").addEventListener("click", downloadTemplate);
  $("#orientationSelect").addEventListener("change", ()=>{ if(importCtx.rawRows.length) buildMappingGrid(); });
  $("#sheetSelect").addEventListener("change", e=>{ parseSheet(e.target.value); renderPreviewTable(); buildMappingGrid(); });
  $("#importConfirmBtn").addEventListener("click", confirmImport);

  // add-lot modal
  $("#btnAddLot").addEventListener("click", ()=>{
    $("#newLotCode").value=""; $("#newLotModel").value=""; $("#newLotSpec").value=""; $("#newLotQty").value=30;
    openModal("addLotModal");
  });
  $("#confirmAddLotBtn").addEventListener("click", ()=>{
    const code = $("#newLotCode").value.trim();
    const qty = Math.max(1, parseInt($("#newLotQty").value,10)||0);
    if(!code){ toast("Vui lòng nhập mã lot."); return; }
    const lot = {id:state.nextId++, code, model:$("#newLotModel").value.trim(), spec:$("#newLotSpec").value.trim(), originalQty:qty};
    if($("#newLotPos").value==="start") state.lots.unshift(lot); else state.lots.push(lot);
    closeModal("addLotModal");
    renderAll(); saveState();
    toast(`Đã thêm lot ${code} (${qty} xe).`);
  });

  $("#btnClearQueue").addEventListener("click", ()=>{
    const remaining = state.lots.filter(l=>(l.originalQty-(state.consumedMap[l.id]||0))>0);
    if(!remaining.length){ toast("Hàng đợi đã trống."); return; }
    if(!confirm(`Xoá toàn bộ ${remaining.length} lot chưa vào chuyền khỏi hàng đợi?`)) return;
    remaining.forEach(lot=>{
      const consumed = state.consumedMap[lot.id]||0;
      if(consumed===0) state.lots = state.lots.filter(l=>l.id!==lot.id);
      else lot.originalQty = consumed;
    });
    renderAll(); saveState();
    toast("Đã xoá hàng đợi.");
  });

  // generic modal close
  $$(".modal-close").forEach(btn=>{
    btn.addEventListener("click", ()=>closeModal(btn.dataset.close));
  });
  $$(".modal-overlay").forEach(ov=>{
    ov.addEventListener("click", e=>{ if(e.target===ov) ov.classList.remove("open"); });
  });

  // periodic autosave while playing
  setInterval(()=>{ if(playing) saveState(); }, 4000);
}

document.addEventListener("DOMContentLoaded", init);
})();
