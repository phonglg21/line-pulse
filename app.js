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
  lots: [],
  consumedMap: {},
  entryLog: [],

  // ================================
  // TIME ENGINE
  // ================================

  // "realtime" = chạy theo đồng hồ thật
  // "simulation" = chạy theo thời gian mô phỏng
  timeMode: "realtime",

  // Thời gian mô phỏng hiện tại.
  // Trong realtime mode, giá trị này chỉ là snapshot.
  simTime: new Date().toISOString(),

  // Lưu thời điểm lần cuối engine được đồng bộ.
  // Dùng để tương thích dữ liệu cũ và debug.
  lastTimeSync: new Date().toISOString(),

  nextId: 1,
currentTick: 0,

/* Tick cuối cùng đã được xác nhận là lịch sử thực tế */
actualThrough: 0,

lotColors: {},
  lotColorCounter: 0,

  // KHSX theo từng tháng
  // Không chứa LOT, chỉ chứa Working Hours / Planned Qty
  productionPlans: {}
};

let playing = false;
let speed = 60;
let lastFrameTs = null;
let toastTimer = null;

// Lưu state định kỳ trong REAL TIME, không lưu mỗi frame.
let realtimeSaveTimer = null;

// Thời điểm cuối cùng chúng ta gọi recompute/render.
let lastRealtimeRender = 0;

/* ---------------------------------------------------------
   2. PERSISTENCE
   --------------------------------------------------------- */
/* ---------------------------------------------------------
   2. PERSISTENCE — SUPABASE
   --------------------------------------------------------- */

let loadingFromSupabase = false;
let realtimeChannel = null;
let saveInProgress = false;

function normalizeState(parsed){
  if(!parsed) return;

  state = Object.assign(state, parsed);

  state.config = Object.assign(
    defaultConfig(),
    parsed.config || {}
  );

  state.lots = Array.isArray(parsed.lots) ? parsed.lots : [];
  state.consumedMap = parsed.consumedMap || {};
  state.entryLog = Array.isArray(parsed.entryLog) ? parsed.entryLog : [];
  state.lotColors = parsed.lotColors || {};
  state.lotColorCounter = Number(parsed.lotColorCounter || 0);
  state.nextId = Number(parsed.nextId || 1);
  state.currentTick = Number(parsed.currentTick || 0);

  /* Tick cuối cùng đã được xác nhận là lịch sử thực tế */
  state.actualThrough = Number(parsed.actualThrough || 0);

  if(!state.simTime){
    state.simTime = new Date().toISOString();
  }
}


/* Lưu state lên Supabase */
async function saveState(){

  console.log(
    "🔥 saveState() ĐƯỢC GỌI",
    new Date().toLocaleTimeString()
  );
  if(loadingFromSupabase) return;
  if(saveInProgress) return;

  saveInProgress = true;

  try{
    const { error } = await supabaseClient
      .from("line_state")
      .update({
        state: state,
        updated_at: new Date().toISOString()
      })
      .eq("id", "main");

    if(error){
      console.error("Supabase save error:", error);
      toast("Không thể lưu dữ liệu lên máy chủ.");
    }

  }catch(e){
    console.error("Supabase save exception:", e);
  }finally{
    saveInProgress = false;
  }
}


/* Đọc state từ Supabase */
async function loadState(){

  loadingFromSupabase = true;

  try{

    const { data, error } = await supabaseClient
      .from("line_state")
      .select("state")
      .eq("id", "main")
      .single();

    if(error){
      console.error("Supabase load error:", error);

      /* Nếu Supabase lỗi thì tạm dùng localStorage */
      try{
        const raw = localStorage.getItem(STORAGE_KEY);

        if(raw){
          normalizeState(JSON.parse(raw));
          console.warn("Đang dùng dữ liệu localStorage tạm thời.");
        }
      }catch(e){
        console.warn("Không đọc được localStorage", e);
      }

      return;
    }

    if(data && data.state){

      normalizeState(data.state);
if(
  state.timeMode !== "realtime" &&
  state.timeMode !== "simulation"
){
  state.timeMode = "realtime";
}
      /* Đồng thời cập nhật localStorage làm bản dự phòng */
      try{
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify(state)
        );
      }catch(e){}

    }

  }catch(e){
    console.error("Supabase load exception:", e);

  }finally{
    loadingFromSupabase = false;
  }
}


/* ---------------------------------------------------------
   SUPABASE REALTIME
   --------------------------------------------------------- */

function setupRealtime(){

  if(realtimeChannel){
    supabaseClient.removeChannel(realtimeChannel);
  }

  realtimeChannel = supabaseClient
    .channel("line-pulse-state")

    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "line_state",
        filter: "id=eq.main"
      },

      payload => {

        console.log(
          "LINE PULSE — nhận dữ liệu mới từ Supabase"
        );

        if(!payload.new || !payload.new.state){
          return;
        }

        loadingFromSupabase = true;

        try{

          normalizeState(payload.new.state);

          try{
            localStorage.setItem(
              STORAGE_KEY,
              JSON.stringify(state)
            );
          }catch(e){}

          recompute();
          renderAll();

        }finally{
          loadingFromSupabase = false;
        }

      }
    )

    .subscribe(status => {

      console.log(
        "Supabase Realtime status:",
        status
      );

    });
}

/* ---------------------------------------------------------
   3. KHSX + SCHEDULE-AWARE TIME ENGINE
   --------------------------------------------------------- */

function dateAtTime(baseDate, hhmm){
  const d = new Date(baseDate);
  const [h,m] = String(hhmm || "00:00").split(":").map(Number);
  d.setHours(h || 0, m || 0, 0, 0);
  return d;
}

function startOfDay(date){
  const d = new Date(date);
  d.setHours(0,0,0,0);
  return d;
}

function addDays(date,n){
  const d = new Date(date);
  d.setDate(d.getDate()+n);
  return d;
}

function sameCalendarDate(a,b){
  return a.getFullYear()===b.getFullYear() &&
         a.getMonth()===b.getMonth() &&
         a.getDate()===b.getDate();
}

function fmtYMD(date){
  const y=date.getFullYear();
  const m=String(date.getMonth()+1).padStart(2,"0");
  const d=String(date.getDate()).padStart(2,"0");
  return `${y}-${m}-${d}`;
}

function monthKey(date){
  const d=new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
}

function escapeHtml(value){
  return String(value ?? "")
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    .replace(/'/g,"&#039;");
}


/* =========================================================
   KHSX
   ========================================================= */

function hasProductionPlanForMonth(date){
  return !!(
    state.productionPlans &&
    state.productionPlans[monthKey(date)]
  );
}

function getPlanDay(date){

  const key = fmtYMD(date);
  const month = monthKey(date);

  const plan =
    state.productionPlans &&
    state.productionPlans[month];

  if(!plan){
    return null;
  }

  /*
    Có ngày trong KHSX:
    trả đúng Working Hours.
    
    0 giờ = ngày nghỉ thật sự.
  */
  if(
    Object.prototype.hasOwnProperty.call(
      plan.days || {},
      key
    )
  ){
    return plan.days[key];
  }

  /*
    Không có dữ liệu ngày:
    không tự biến thành ngày nghỉ.
  */
  return null;
}

function plannedHours(date){

  const day = getPlanDay(date);

  if(!day) return null;

  return Math.max(
    0,
    Number(day.workingHours) || 0
  );
}


/* =========================================================
   BREAKS
   ========================================================= */

function getBaseBreaks(date, config){

  const start =
    dateAtTime(date, config.shiftStart);

  const end =
    dateAtTime(date, config.shiftEnd);

  return (config.breaks || [])
    .map(b => ({
      start: dateAtTime(date,b.start),
      end: dateAtTime(date,b.end)
    }))
    .filter(b =>
      b.end > start &&
      b.start < end
    )
    .sort((a,b)=>a.start-b.start);
}


/* =========================================================
   WORKING HOURS CỦA TỪNG NGÀY
   ========================================================= */

function getDayProductionWindow(date, config){

  const start =
    dateAtTime(date, config.shiftStart);

  /*
    Nếu tháng này đã có KHSX:
    KHSX là nguồn dữ liệu chính.
  */

  const hours = plannedHours(date);

  if(hours !== null){

    if(hours <= 0){

      return {
        start,
        end:start,
        breaks:[],
        workSeconds:0,
        planned:true
      };

    }

    return {

      start,

      end:null,

      breaks:getBaseBreaks(
        date,
        config
      ),

      // Working Hours là giờ sản xuất NET
      workSeconds:hours * 3600,

      planned:true
    };
  }


  /*
    Nếu tháng chưa có KHSX:
    giữ cơ chế cũ để app không chết.
  */

  const end =
    dateAtTime(date, config.shiftEnd);

  let ms =
    Math.max(0,end-start);

  for(const b of getBaseBreaks(date,config)){

    const bs =
      b.start < start
        ? start
        : b.start;

    const be =
      b.end > end
        ? end
        : b.end;

    if(be > bs){
      ms -= be-bs;
    }
  }

  return {

    start,
    end,

    breaks:getBaseBreaks(
      date,
      config
    ),

    workSeconds:
      Math.max(0,ms/1000),

    planned:false
  };
}


/* =========================================================
   TÍNH SỐ GIÂY SẢN XUẤT ĐÃ TRÔI QUA
   ========================================================= */

function workSecondsUntilFromWindow(
  window,
  uptoTime
){

  if(
    window.workSeconds <= 0 ||
    uptoTime <= window.start
  ){
    return 0;
  }

  const target =
    new Date(uptoTime);

  let remaining =
    Math.min(
      window.workSeconds,
      Math.max(
        0,
        (target-window.start)/1000
      )
    );


  /*
    Trừ thời gian nghỉ.
    OT sau shiftEnd không có break.
  */

  for(const b of window.breaks){

    if(target <= b.start)
      break;

    const bs =
      b.start > window.start
        ? b.start
        : window.start;

    const be =
      b.end < target
        ? b.end
        : target;

    if(be > bs){

      remaining -=
        (be-bs)/1000;
    }
  }

  return Math.max(
    0,
    Math.min(
      window.workSeconds,
      remaining
    )
  );
}


/* =========================================================
   CỘNG THÊM X GIÂY SẢN XUẤT
   ========================================================= */

function addProductionSeconds(
  date,
  seconds,
  config
){

  const window =
    getDayProductionWindow(
      date,
      config
    );

  if(
    window.workSeconds <= 0 ||
    seconds <= 0
  ){
    return new Date(window.start);
  }

  let remaining =
    Math.min(
      seconds,
      window.workSeconds
    );

  let cursor =
    new Date(window.start);


  for(const b of window.breaks){

    if(b.end <= cursor)
      continue;

    if(b.start > cursor){

      const chunk =
        (b.start-cursor)/1000;

      if(remaining <= chunk){

        return new Date(
          cursor.getTime() +
          remaining*1000
        );
      }

      remaining -= chunk;
    }

    if(b.end > cursor){

      cursor =
        new Date(b.end);
    }
  }

  return new Date(
    cursor.getTime() +
    remaining*1000
  );
}


/* =========================================================
   THỜI ĐIỂM KẾT THÚC NGÀY SẢN XUẤT
   ========================================================= */

function dayEndTime(date,config){

  const window =
    getDayProductionWindow(
      date,
      config
    );

  if(window.workSeconds <= 0)
    return window.start;

  return addProductionSeconds(
    date,
    window.workSeconds,
    config
  );
}


/* =========================================================
   TỔNG GIỜ SẢN XUẤT TỪ MỐC ĐẦU
   ========================================================= */

function elapsedWorkSeconds(
  anchorDate,
  currentDate,
  config
){

  if(currentDate <= anchorDate)
    return 0;

  let total=0;

  let day =
    startOfDay(anchorDate);

  const lastDay =
    startOfDay(currentDate);

  const anchorDay =
    startOfDay(anchorDate);


  while(day <= lastDay){

    const window =
      getDayProductionWindow(
        day,
        config
      );

    const segStart =
      day.getTime() === anchorDay.getTime()
        ? new Date(
            Math.max(
              anchorDate.getTime(),
              window.start.getTime()
            )
          )
        : window.start;


    if(window.workSeconds > 0){

      const segEnd =
        day.getTime() === lastDay.getTime()
          ? currentDate
          : dayEndTime(day,config);

      if(segEnd > segStart){

        const before =
          workSecondsUntilFromWindow(
            window,
            segStart
          );

        const after =
          workSecondsUntilFromWindow(
            window,
            segEnd
          );

        total +=
          Math.max(
            0,
            after-before
          );
      }
    }

    day =
      addDays(day,1);
  }

  return total;
}


/* =========================================================
   ĐỔI SỐ GIÂY SẢN XUẤT -> DATETIME
   ========================================================= */

function dateFromElapsedWorkSeconds(
  anchorDate,
  targetSeconds,
  config
){

  let remaining =
    Math.max(
      0,
      targetSeconds
    );

  let day =
    startOfDay(anchorDate);

  let first=true;


  for(
    let guard=0;
    guard<100000;
    guard++
  ){

    const window =
      getDayProductionWindow(
        day,
        config
      );

    const segStart =
      first
        ? new Date(
            Math.max(
              anchorDate.getTime(),
              window.start.getTime()
            )
          )
        : window.start;

    first=false;


    if(window.workSeconds <= 0){

      day =
        addDays(day,1);

      continue;
    }


    const already =
      workSecondsUntilFromWindow(
        window,
        segStart
      );

    const available =
      Math.max(
        0,
        window.workSeconds -
        already
      );


    if(remaining <= available){

      return addProductionSeconds(
        day,
        already + remaining,
        config
      );
    }


    remaining -= available;

    day =
      addDays(day,1);
  }

  return new Date(anchorDate);
}


/* =========================================================
   ANCHOR
   ========================================================= */

function getAnchor(config){

  return new Date(
    `${config.lineStartDate}T${config.shiftStart}:00`
  );
}


/* =========================================================
   TRẠNG THÁI CA
   ========================================================= */

function getShiftStatus(config,now){

  const window =
    getDayProductionWindow(
      now,
      config
    );

  if(window.workSeconds <= 0)
    return "holiday";

  const end =
    dayEndTime(now,config);

  if(
    now < window.start ||
    now > end
  ){
    return "idle";
  }

  for(const b of window.breaks){

    if(
      now >= b.start &&
      now < b.end
    ){
      return "break";
    }
  }

  return "running";
}


/* =========================================================
   SIMULATION ENGINE
   ========================================================= */

function capacity(config){

  return (
    config.capTrim +
    config.capChassis +
    config.capFinal
  );
}

function computeCurrentTick(
  config,
  simTimeIso
){

  const now =
    new Date(simTimeIso);

  if(
    isNaN(now.getTime())
  ){
    return 0;
  }

  const anchor =
    getAnchor(config);

  /*
    Trước thời điểm bắt đầu chuyền
    thì chưa có tick nào.
  */
  if(now <= anchor){
    return 0;
  }

  /*
    elapsedWorkSeconds() là Time Engine
    chính thức.

    Hàm này đã đi qua:
      getDayProductionWindow()
        ↓
      plannedHours()
        ↓
      KHSX từng ngày

    nên Working Hours của KHSX là
    nguồn thời gian sản xuất chính.
  */
  const elapsed =
    elapsedWorkSeconds(
      anchor,
      now,
      config
    );

  return Math.max(
    0,
    Math.floor(
      elapsed /
      Number(config.takt || 1)
    )
  );
}


function nextAvailableLot(
  lots,
  consumedMap
){

  for(const lot of lots){

    const consumed =
      consumedMap[lot.id] || 0;

    if(
      consumed <
      lot.originalQty
    ){
      return lot;
    }
  }

  return null;
}


function syncEntryLog(
  ctx,
  targetTick
){

  const anchor =
    getAnchor(
      ctx.config
    );

  const cap =
    capacity(
      ctx.config
    );


  /*
    KHÔNG BAO GIỜ XÓA entryLog.

    Nếu targetTick nhỏ hơn số entry hiện tại
    thì đó chỉ là tua ngược thời gian.
  */

  while(
    ctx.entryLog.length <
    targetTick
  ){

    const tick =
      ctx.entryLog.length + 1;

    const lot =
      nextAvailableLot(
        ctx.lots,
        ctx.consumedMap
      );


    /*
      Entry mới:
      thời gian được tính từ KHSX hiện tại.
    */

    const entryTime =
      dateFromElapsedWorkSeconds(
        anchor,
        tick *
        ctx.config.takt,
        ctx.config
      ).toISOString();


    const exitTime =
      dateFromElapsedWorkSeconds(
        anchor,
        (tick + cap) *
        ctx.config.takt,
        ctx.config
      ).toISOString();


    if(lot){

      const consumed =
        ctx.consumedMap[lot.id] || 0;

      const unitIndex =
        consumed + 1;

      ctx.consumedMap[lot.id] =
        unitIndex;


      ctx.entryLog.push({

        tick,

        lotId:
          lot.id,

        code:
          lot.code,

        model:
          lot.model,

        spec:
          lot.spec,

        unitIndex,

        totalQty:
          lot.originalQty,

        entryTime,

        exitTime,

        empty:false

      });

    }else{

      ctx.entryLog.push({

        tick,

        empty:true,

        entryTime,

        exitTime

      });

    }

  }
}

   function lockActualHistory(){

  /*
    Chỉ REAL TIME mới được xác nhận
    lịch sử thực tế.
  */

  if(!isRealtimeMode()){
    return;
  }


  if(
    !Array.isArray(state.entryLog)
  ){
    state.entryLog = [];
  }


  const now =
    new Date();


  let actualTick = 0;


  for(const entry of state.entryLog){

    if(
      !entry ||
      !entry.entryTime
    ){
      continue;
    }


    const t =
      new Date(entry.entryTime);


    if(
      !isNaN(t.getTime()) &&
      t <= now
    ){

      actualTick =
        Math.max(
          actualTick,
          Number(entry.tick) || 0
        );

    }

  }


  /*
    Nếu trước đó entryLog có chứa
    dữ liệu mô phỏng tương lai,
    loại phần tương lai đó khỏi
    lịch sử thực tế.
  */

  if(
    state.entryLog.length >
    actualTick
  ){

    state.entryLog =
      state.entryLog.slice(
        0,
        actualTick
      );

  }


  /*
    Đây là mốc lịch sử thực tế cuối cùng.
  */

  state.actualThrough =
    actualTick;


  /*
    Đồng bộ lại consumedMap từ
    lịch sử thực tế.
  */

  state.consumedMap =
    rebuildConsumedMapFromLog(
      state.entryLog
    );

}

/* =========================================================
   VIEW DATA
   ========================================================= */

let simulationViewLog = [];
let simulationViewConsumedMap = {};


function getActiveEntryLog(){

  if(state.timeMode === "simulation"){
    return simulationViewLog;
  }

  return state.entryLog;
}


function getActiveConsumedMap(){

  if(state.timeMode === "simulation"){
    return simulationViewConsumedMap;
  }

  return state.consumedMap;
}


function rebuildConsumedMapFromLog(log){

  const map = {};

  for(const e of log){

    if(!e || e.empty){
      continue;
    }

    map[e.lotId] =
      (map[e.lotId] || 0) + 1;
  }

  return map;
}


/* =========================================================
   RECOMPUTE
   ========================================================= */

function recompute(){

  const ct =
    computeCurrentTick(
      state.config,
      state.simTime
    );


  /* -------------------------------------------------------
     REAL TIME
     ------------------------------------------------------- */

  if(isRealtimeMode()){

    const ctx = {

      config:state.config,

      lots:state.lots,

      consumedMap:
        state.consumedMap,

      entryLog:
        state.entryLog

    };


    /*
      REAL TIME được phép ghi thêm
      lịch sử thực tế.
    */

    syncEntryLog(
      ctx,
      ct
    );


    state.currentTick = ct;


    /*
      Xác nhận và khóa lịch sử thực tế.
    */

    lockActualHistory();


    simulationViewLog = [];
    simulationViewConsumedMap = {};

    return;
  }


  /* -------------------------------------------------------
     SIMULATION
     ------------------------------------------------------- */

  /*
    TUYỆT ĐỐI KHÔNG ghi vào state.entryLog.

    Chỉ lấy lịch sử thực tế làm nền,
    sau đó tạo một bản mô phỏng tạm thời.
  */

  const actualCount =
    Math.min(
      Number(state.actualThrough || 0),
      state.entryLog.length
    );


  /*
    Nếu actualThrough chưa có dữ liệu
    thì coi toàn bộ entryLog hiện tại
    là lịch sử đã có.
  */

  const safeActualCount =
    actualCount > 0
      ? actualCount
      : state.entryLog.length;


  const baseCount =
    Math.min(
      ct,
      safeActualCount
    );


  const simulatedLog =
    state.entryLog.slice(
      0,
      baseCount
    );


  const simulatedConsumedMap =
    rebuildConsumedMapFromLog(
      simulatedLog
    );


  const ctx = {

    config:state.config,

    lots:state.lots,

    consumedMap:
      simulatedConsumedMap,

    entryLog:
      simulatedLog

  };


  /*
    Nếu đang mô phỏng tới tương lai,
    chỉ tạo thêm dữ liệu trong bản sao.
  */

  syncEntryLog(
    ctx,
    ct
  );


  simulationViewLog =
    ctx.entryLog;

  simulationViewConsumedMap =
    ctx.consumedMap;


  state.currentTick = ct;

}
   function projectEndOfDay(){

  const now =
    new Date(state.simTime);

  const end =
    dayEndTime(
      now,
      state.config
    );

  const anchor =
    getAnchor(state.config);

  const elapsed =
    elapsedWorkSeconds(
      anchor,
      end,
      state.config
    );

  const targetTick =
    Math.max(
      state.currentTick,
      Math.floor(
        elapsed /
        state.config.takt
      )
    );


  /*
    Forecast không được sửa
    lịch sử thực tế.

    Lấy bản VIEW hiện tại làm nền.
  */

  const activeLog =
    getActiveEntryLog();

  const activeConsumedMap =
    getActiveConsumedMap();


  const ctx = {

    config:
      state.config,

    lots:
      state.lots,

    consumedMap:
      Object.assign(
        {},
        activeConsumedMap
      ),

    entryLog:
      activeLog.slice()

  };


  syncEntryLog(
    ctx,
    targetTick
  );


  return ctx.entryLog;
}
/* =========================================================
   KHSX IMPORT
   ========================================================= */

let planImportCtx = {
  workbook:null,
  parsedDays:[],
  planMonth:"",
  sheetName:""
};


function monthNumberFromText(text){

  const map = {
    january:1,
    february:2,
    march:3,
    april:4,
    may:5,
    june:6,
    july:7,
    august:8,
    september:9,
    october:10,
    november:11,
    december:12
  };

  const s =
    String(text || "").toLowerCase();

  for(const [name,num]
      of Object.entries(map)){

    if(
      new RegExp(
        `\\b${name}\\b`,
        "i"
      ).test(s)
    ){
      return num;
    }
  }

  return null;
}


function detectPlanMonth(
  rows,
  sheetName
){

  const title =
    rows
      .slice(0,8)
      .flat()
      .join(" ");

  const yearMatch =
    title.match(
      /\b(20\d{2})\b/
    );

  const year =
    yearMatch
      ? Number(yearMatch[1])
      : new Date().getFullYear();

  const month =
    monthNumberFromText(title) ||
    monthNumberFromText(sheetName);

  if(!month){

    throw new Error(
      "Không xác định được tháng trong file KHSX."
    );
  }

  return (
    `${year}-${String(month).padStart(2,"0")}`
  );
}


function findDayRow(rows){

  for(
    let r=0;
    r<Math.min(rows.length,20);
    r++
  ){

    const cols =
      (rows[r] || [])
        .map((v,c)=>({v,c}))
        .filter(x =>
          Number.isInteger(
            Number(
              String(x.v).trim()
            )
          ) &&
          Number(x.v)>=1 &&
          Number(x.v)<=31
        );

    if(cols.length >= 5){

      return {

        row:r,

        cols:
          cols.map(x=>x.c)

      };
    }
  }

  throw new Error(
    "Không tìm thấy dòng ngày."
  );
}


function findWorkingHoursRow(rows){

  for(
    let r=0;
    r<Math.min(rows.length,20);
    r++
  ){

    const text =
      (rows[r] || [])
        .map(v =>
          String(v ?? "")
            .replace(/\n/g," ")
            .trim()
        )
        .join(" ");

    if(
      /working\s*(hours?|hous?)/i
        .test(text)
    ){

      return r;
    }
  }

  throw new Error(
    "Không tìm thấy dòng Working Hours."
  );
}


function parseProductionPlanSheet(
  sheetName
){

  const ws =
    planImportCtx
      .workbook
      .Sheets[sheetName];

  const rows =
    XLSX.utils.sheet_to_json(
      ws,
      {
        header:1,
        raw:false,
        defval:""
      }
    );


  const dayInfo =
    findDayRow(rows);

  const hoursRow =
    findWorkingHoursRow(rows);

  const planMonth =
    detectPlanMonth(
      rows,
      sheetName
    );


  const [
    year,
    month
  ] =
    planMonth
      .split("-")
      .map(Number);


  const lastDay =
    new Date(
      year,
      month,
      0
    ).getDate();


  const days=[];


  for(
    const c
    of dayInfo.cols
  ){

    const day =
      Number(
        String(
          rows[dayInfo.row][c]
        ).trim()
      );

    if(
      day < 1 ||
      day > lastDay
    ){
      continue;
    }


    const raw =
      rows[hoursRow]?.[c];


    const hours =
      raw === "" ||
      raw == null
        ? 0
        : Number(
            String(raw)
              .replace(",",".")
          );


    if(
      !Number.isFinite(hours) ||
      hours < 0
    ){
      continue;
    }


    const workDate =
      `${planMonth}-${String(day).padStart(2,"0")}`;


    days.push({

      work_date:
        workDate,

      working_hours:
        hours,

      planned_qty:
        Math.round(
          hours *
          Number(state.config.uph || 0)
        )
    });
  }


  if(!days.length){

    throw new Error(
      "Không tìm thấy ngày/Working Hours hợp lệ."
    );
  }


  planImportCtx.parsedDays =
    days.sort(
      (a,b)=>
        a.work_date.localeCompare(
          b.work_date
        )
    );

  planImportCtx.planMonth =
    planMonth;

  planImportCtx.sheetName =
    sheetName;


  return planImportCtx.parsedDays;
}


function renderPlanPreview(){

  const table =
    $("#planPreviewTable");

  if(!table) return;


  table.innerHTML = `

    <thead>
      <tr>
        <th>Ngày</th>
        <th>Working Hours</th>
        <th>UPH</th>
        <th>Kế hoạch</th>
      </tr>
    </thead>

    <tbody>

      ${
        planImportCtx.parsedDays
          .map(d=>`

            <tr>
              <td>${escapeHtml(d.work_date)}</td>
              <td>${d.working_hours}</td>
              <td>${state.config.uph}</td>
              <td>${d.planned_qty}</td>
            </tr>

          `)
          .join("")
      }

    </tbody>
  `;
}


function resetPlanImportUI(){

  planImportCtx = {
    workbook:null,
    parsedDays:[],
    planMonth:"",
    sheetName:""
  };


  if($("#planFileInput"))
    $("#planFileInput").value="";

  if($("#planImportStep2"))
    $("#planImportStep2")
      .style.display="none";

  if($("#planImportConfirmBtn"))
    $("#planImportConfirmBtn")
      .style.display="none";

  if($("#planImportInfo"))
    $("#planImportInfo")
      .textContent="Chưa chọn file.";

  if($("#planPreviewTable"))
    $("#planPreviewTable")
      .innerHTML="";
}


function handleProductionPlanFile(file){

  const reader =
    new FileReader();


  reader.onload = e => {

    try{

      const wb =
        XLSX.read(
          new Uint8Array(
            e.target.result
          ),
          {type:"array"}
        );


      planImportCtx.workbook =
        wb;


      const select =
        $("#planSheetSelect");


      select.innerHTML =
        wb.SheetNames
          .map(
            n =>
              `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`
          )
          .join("");


      parseProductionPlanSheet(
        wb.SheetNames[0]
      );


      $("#planUphDisplay").value =
        state.config.uph;


      $("#planImportInfo")
        .textContent =
          `KHSX tháng ${planImportCtx.planMonth} · ` +
          `${planImportCtx.parsedDays.length} ngày · ` +
          `Working Hours × UPH`;


      renderPlanPreview();


      $("#planImportStep2")
        .style.display="block";


      $("#planImportConfirmBtn")
        .style.display="inline-block";


    }catch(err){

      console.error(
        "KHSX parse error:",
        err
      );

      toast(
        err.message ||
        "Không đọc được file KHSX."
      );
    }
  };


  reader.readAsArrayBuffer(file);
}


/* =========================================================
   SUPABASE KHSX
   ========================================================= */

function daysToPlanMap(days){

  const map={};

  for(const d of days || []){

    map[d.work_date] = {

      workingHours:
        Number(
          d.working_hours
        ) || 0,

      plannedQty:
        Number(
          d.planned_qty
        ) || 0
    };
  }

  return map;
}


async function fetchLatestPlanMonth(
  month
){

  const monthDate =
    `${month}-01`;


  const {
    data,
    error
  } =
    await supabaseClient
      .from("production_plans")
      .select(
        "id,plan_month,version,status,created_at,updated_at"
      )
      .eq(
        "plan_month",
        monthDate
      )
      .order(
        "version",
        {ascending:false}
      )
      .limit(1);


  if(error)
    throw error;


  if(!data?.length)
    return null;


  const plan =
    data[0];


  const {
    data:days,
    error:e2
  } =
    await supabaseClient
      .from("production_plan_days")
      .select(
        "work_date,working_hours,planned_qty"
      )
      .eq(
        "plan_id",
        plan.id
      )
      .order(
        "work_date",
        {ascending:true}
      );


  if(e2)
    throw e2;


  return {

    ...plan,

    days:
      daysToPlanMap(
        days || []
      )
  };
}


async function loadPlanMonth(
  month
){

  try{

    const plan =
      await fetchLatestPlanMonth(
        month
      );


    if(plan){

      state.productionPlans[month] = {

        id:plan.id,

        version:plan.version,

        status:plan.status,

        plan_month:
          plan.plan_month,

        days:
          plan.days
      };

    }

    return plan;

  }catch(e){

    console.error(
      "KHSX load error:",
      e
    );

    return null;
  }
}


async function loadPlansAround(date){

  const d =
    new Date(date);


  const current =
    monthKey(d);


  const next =
    monthKey(
      new Date(
        d.getFullYear(),
        d.getMonth()+1,
        1
      )
    );


  await Promise.all([

    loadPlanMonth(current),

    loadPlanMonth(next)

  ]);


  try{

    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(state)
    );

  }catch(e){}
}


async function ensurePlanForDate(
  date
){

  const month =
    monthKey(date);


  if(
    !state.productionPlans[month]
  ){

    await loadPlanMonth(month);
  }
}


/* =========================================================
   LƯU KHSX
   ========================================================= */

async function saveProductionPlan(){

  if(
    !planImportCtx.planMonth ||
    !planImportCtx.parsedDays.length
  ){

    toast(
      "Chưa có dữ liệu KHSX hợp lệ."
    );

    return;
  }


  const month =
    planImportCtx.planMonth;

  const today =
    new Date();

  const currentMonth =
    monthKey(today);

  const todayYmd =
    fmtYMD(today);


  try{

    $("#planImportConfirmBtn")
      .disabled=true;


    const previous =
      await fetchLatestPlanMonth(
        month
      );


    const previousMap =
      previous?.days || {};


    const incoming =
      daysToPlanMap(
        planImportCtx.parsedDays
      );


    const merged={};


    /*
      THÁNG HIỆN TẠI:

      Trước hôm nay:
        GIỮ KHSX CŨ

      Từ hôm nay:
        DÙNG KHSX MỚI
    */

if(month === currentMonth){

  /*
    NGÀY ĐÃ QUA:
    - Nếu đã có KHSX cũ -> giữ KHSX cũ
    - Nếu chưa có KHSX cũ -> lấy KHSX từ file mới

    TỪ HÔM NAY TRỞ ĐI:
    - luôn dùng KHSX mới
  */

  for(const [date, day] of Object.entries(incoming)){

    if(date < todayYmd){

      if(previousMap[date]){
        merged[date] = previousMap[date];
      }else{
        merged[date] = day;
      }

    }else{

      merged[date] = day;

    }

  }

  /*
    Bổ sung các ngày quá khứ chỉ có trong KHSX cũ
    nhưng file mới không chứa.
  */
  for(const [date, day] of Object.entries(previousMap)){

    if(
      date < todayYmd &&
      !merged[date]
    ){
      merged[date] = day;
    }

  }

}else{

  /*
    THÁNG TƯƠNG LAI:
    thay toàn bộ tháng
  */

  Object.assign(
    merged,
    incoming
  );
}

      /*
        THÁNG TƯƠNG LAI:
        thay toàn bộ tháng
      */

      Object.assign(
        merged,
        incoming
      );
    }


    const version =
      previous
        ? Number(previous.version)+1
        : 1;


    /*
      Archive version cũ
    */

    if(previous){

      const {
        error
      } =
        await supabaseClient
          .from("production_plans")
          .update({
            status:"archived",
            updated_at:
              new Date().toISOString()
          })
          .eq(
            "id",
            previous.id
          );

      if(error)
        throw error;
    }


    const status =
      month === currentMonth
        ? "current"
        : "planned";


    /*
      Tạo version mới
    */

    const {
      data:plan,
      error:e1
    } =
      await supabaseClient
        .from("production_plans")
        .insert({

          plan_month:
            `${month}-01`,

          version,

          status
        })
        .select()
        .single();


    if(e1)
      throw e1;


    /*
      Lưu từng ngày
    */

    const rows =
      Object.entries(
        merged
      )
      .map(
        ([work_date,day])=>({

          plan_id:
            plan.id,

          work_date,

          working_hours:
            day.workingHours,

          planned_qty:
            Math.round(
              day.plannedQty
            )
        })
      );


    if(rows.length){

      const {
        error:e2
      } =
        await supabaseClient
          .from(
            "production_plan_days"
          )
          .insert(rows);

      if(e2)
        throw e2;
    }


    /*
      Cập nhật cache local
    */

    state.productionPlans[month] = {

      id:plan.id,

      version:plan.version,

      status:plan.status,

      plan_month:
        plan.plan_month,

      days:
        daysToPlanMap(rows)
    };


    /*
      Nếu thay KHSX tháng hiện tại,
      mọi dữ liệu mô phỏng tương lai
      phải được tính lại.
    */

/*
  KHSX mới chỉ thay đổi cách tính
  thời gian từ thời điểm hiện tại trở đi.

  KHÔNG được sửa hoặc cắt entryLog
  vì entryLog là lịch sử thực tế.
*/

if(month === currentMonth){

  /*
    Không làm gì với state.entryLog.
    recompute() sẽ tự tạo lại phần
    mô phỏng tương lai nếu cần.
  */

}


    try{

      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(state)
      );

    }catch(e){}


    recompute();
    renderAll();
    saveState();


    closeModal(
      "planImportModal"
    );

    resetPlanImportUI();


    toast(
      `Đã áp dụng KHSX tháng ${month} — Version ${version}.`
    );


  }catch(e){

    console.error(
      "KHSX save error:",
      e
    );

    toast(
      e.message ||
      "Không thể lưu KHSX."
    );

  }finally{

    $("#planImportConfirmBtn")
      .disabled=false;
  }
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
  const log = getActiveEntryLog();
  const last = log[state.currentTick - 1];
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

  const activeLog =
  getActiveEntryLog();

const completed =
  summarizeByExitToday(
    activeLog,
    e =>
      sameCalendarDate(
        new Date(e.exitTime),
        now
      ) &&
      (e.tick + cap) <=
      state.currentTick
  );
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

  const consumedMap =
    getActiveConsumedMap();

  const remaining =
    state.lots.filter(
      l =>
        (
          l.originalQty -
          (consumedMap[l.id] || 0)
        ) > 0
    );
  if(!remaining.length){
    tbody.innerHTML = `<tr><td colspan="8" style="font-family:var(--font-sans); color:var(--text-dim); text-align:center; padding:22px;">Hàng đợi trống — nhập lot từ Excel/CSV hoặc thêm thủ công.</td></tr>`;
    return;
  }
  remaining.forEach((lot, idx)=>{
    const consumed = consumedMap[lot.id]||0;
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
      const consumed = consumedMap[id]||0;
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
      const consumed = consumedMap[id]||0;
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
  const recent =
  getActiveEntryLog()
    .slice(-60)
    .reverse();
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
   7. TIME ENGINE
   --------------------------------------------------------- */

/*
  LINE PULSE TIME ENGINE

  Có 2 chế độ:

  1. REALTIME
     - Mặc định.
     - Đồng hồ = thời gian thực của thiết bị.
     - Đóng web bao lâu không quan trọng.
     - Mở lại lúc nào => lấy đúng thời gian lúc đó.
     - Không phụ thuộc requestAnimationFrame khi web bị đóng.

  2. SIMULATION
     - Dùng state.simTime.
     - Có Play / Pause.
     - Có tốc độ x1 / x10 / x60 / x300 / x1800.
     - Có tua ±1p / ±15p / ±1h.
     - Có thể nhập thời gian thủ công.
*/


function isRealtimeMode(){
  return state.timeMode === "realtime";
}


/* =========================================================
   SET THỜI GIAN
   ========================================================= */

function setSimTime(date, options = {}){

  if(!(date instanceof Date) || isNaN(date.getTime())){
    console.warn("setSimTime: thời gian không hợp lệ", date);
    return;
  }

  state.simTime = date.toISOString();
  state.lastTimeSync = new Date().toISOString();

  recompute();
  renderAll();

  if(options.save !== false){
    throttledTimeSave();
  }
}


/* =========================================================
   CHUYỂN REAL TIME
   ========================================================= */

function switchToRealtime(){

  state.timeMode = "realtime";

  // Ngay khi chuyển sang REAL TIME,
  // lấy đồng hồ thật ngay lập tức.
  const now = new Date();

  state.simTime = now.toISOString();
  state.lastTimeSync = now.toISOString();

  // REAL TIME luôn chạy.
  playing = true;
  lastFrameTs = null;

  recompute();
  renderAll();

  saveState();

  toast("Đã chuyển sang thời gian thực.");
}


/* =========================================================
   CHUYỂN SIMULATION
   ========================================================= */

function switchToSimulation(){

  /*
    Khi chuyển từ REAL TIME sang SIMULATION:

    - Không thay đổi entryLog
    - Không reset currentTick
    - Không thay đổi lịch sử sản xuất
    - Chỉ chuyển chế độ thời gian

    simTime hiện tại được giữ nguyên làm điểm bắt đầu.
  */

  state.timeMode = "simulation";

  playing = true;
  lastFrameTs = null;

  recompute();
  renderAll();

  updateTimeModeUI();

  saveState();

  toast("Đã chuyển sang thời gian mô phỏng.");
}


/* =========================================================
   TUA THỜI GIAN
   ========================================================= */

async function jump(seconds){

  /*
    Tua thời gian chỉ có ý nghĩa trong SIMULATION.

    Nếu đang REAL TIME thì không cho tua,
    vì REAL TIME phải luôn bám đồng hồ thật.
  */

  if(isRealtimeMode()){
    toast("REAL TIME đang chạy theo đồng hồ thực.");
    return;
  }

  const current = new Date(state.simTime);

  const next = new Date(
    current.getTime() + Number(seconds) * 1000
  );
  await ensurePlanForDate(next);
  setSimTime(next);

  // Lưu ngay sau thao tác tua.
  saveState();
}


/* =========================================================
   RESET SIMULATION
   ========================================================= */

function resetSimulationTime(){

  /*
    RESET chỉ reset thời gian mô phỏng.

    KHÔNG xóa lịch sử thực tế.
  */

  simulationViewLog = [];
  simulationViewConsumedMap = {};

  if(isRealtimeMode()){

    // REAL TIME: lấy thời gian thực hiện tại.
    state.simTime =
      new Date().toISOString();

  }else{

    // SIMULATION: đưa về đầu ca.
    state.simTime =
      getAnchor(
        state.config
      ).toISOString();

  }

  state.currentTick = 0;

  recompute();
  renderAll();

  saveState();
}


/* =========================================================
   CLOCK ENGINE
   ========================================================= */

function tickLoop(ts){

  if(lastFrameTs === null){
    lastFrameTs = ts;
  }

  const deltaReal =
    Math.max(0, (ts - lastFrameTs) / 1000);

  lastFrameTs = ts;


  /* -------------------------------------------------------
     REAL TIME
     ------------------------------------------------------- */

  if(isRealtimeMode()){

    /*
      Không cộng deltaReal.

      Không dùng:
        simTime += deltaReal

      Vì khi tab bị đóng / máy tắt,
      requestAnimationFrame không chạy.

      Thay vào đó:
        simTime = Date.now()

      Vì vậy mở lại web sau 2 tiếng
      => thời gian tự nhảy đúng 2 tiếng.
    */

    const now = new Date();

    state.simTime = now.toISOString();
    state.lastTimeSync = state.simTime;

    /*
      Không cần recompute 60 lần/giây.
      1 lần/giây là đủ cho đồng hồ và logic line.
    */

    if(
      now.getTime() - lastRealtimeRender >= 1000
    ){

      lastRealtimeRender = now.getTime();

      recompute();
      renderAll();

      throttledTimeSave();
    }

  }


  /* -------------------------------------------------------
     SIMULATION
     ------------------------------------------------------- */

  else if(playing){

    const current =
      new Date(state.simTime);

    const next =
      new Date(
        current.getTime()
        + deltaReal * speed * 1000
      );

    state.simTime = next.toISOString();
    state.lastTimeSync = new Date().toISOString();

    recompute();
    renderAll();

    /*
      Không save mỗi frame.
      Chỉ lưu định kỳ.
    */
    throttledTimeSave();
  }


  requestAnimationFrame(tickLoop);
}


/* =========================================================
   SAVE TIME THROTTLE
   ========================================================= */

function throttledTimeSave(){

  if(realtimeSaveTimer){
    return;
  }

  /*
    REAL TIME:
      Không cần ghi database mỗi giây.

    SIMULATION:
      Cũng không cần ghi mỗi frame.

    10 giây là đủ để tránh spam Supabase.
  */

  realtimeSaveTimer = setTimeout(async ()=>{

    realtimeSaveTimer = null;

    try{
      await saveState();
    }catch(e){
      console.warn(
        "Không thể lưu time state:",
        e
      );
    }

  }, 10000);
}


/* =========================================================
   TIME MODE UI
   ========================================================= */

function ensureTimeModeUI(){

  // Nếu đã tồn tại thì không tạo lại.
  if($("#timeModeSelect")){
    return;
  }

  const timebar =
    document.querySelector(".timebar");

  if(!timebar){
    console.warn(
      "Không tìm thấy .timebar"
    );
    return;
  }

  const group =
    document.createElement("div");

  group.className = "timebar-group";

  group.innerHTML = `
    <label class="timebar-label">
      Chế độ
    </label>

    <select id="timeModeSelect">
      <option value="realtime">
        🟢 Thời gian thực
      </option>

      <option value="simulation">
        🔵 Mô phỏng
      </option>
    </select>
  `;

  /*
    Chèn vào đầu timebar.
  */

  timebar.insertBefore(
    group,
    timebar.firstChild
  );


  $("#timeModeSelect").value =
    state.timeMode;


  $("#timeModeSelect").addEventListener(
    "change",
    e=>{

      const mode = e.target.value;

      if(mode === "realtime"){
        switchToRealtime();
      }else{
        switchToSimulation();
      }

    }
  );
}


/* =========================================================
   CẬP NHẬT UI
   ========================================================= */

function updateTimeModeUI(){

  const select =
    $("#timeModeSelect");

  if(select){
    select.value =
      state.timeMode;
  }


  const playBtn =
    $("#playPauseBtn");

  const speedSelect =
    $("#speedSelect");

  const setTimeInput =
    $("#setTimeInput");

  const applyTimeBtn =
    $("#applyTimeBtn");

  const jumpButtons =
    $$("[data-jump]");


  if(isRealtimeMode()){

    /*
      REAL TIME:
      - Không cần Play/Pause.
      - Không cần speed.
      - Không cho chỉnh thời gian thủ công.
      - Không cho tua.
    */

    if(playBtn){

      playBtn.textContent = "●";

      playBtn.title =
        "Đang chạy theo thời gian thực";

      playBtn.disabled = true;
    }

    if(speedSelect){
      speedSelect.disabled = true;
    }

    if(setTimeInput){
      setTimeInput.disabled = true;
    }

    if(applyTimeBtn){
      applyTimeBtn.disabled = true;
    }

    jumpButtons.forEach(btn=>{
      btn.disabled = true;
    });

  }

  else{

    /*
      SIMULATION:
      Khôi phục toàn bộ điều khiển.
    */

    if(playBtn){

      playBtn.disabled = false;

      playBtn.textContent =
        playing ? "⏸" : "▶";

      playBtn.title =
        "Chạy / Dừng mô phỏng";
    }

    if(speedSelect){
      speedSelect.disabled = false;
    }

    if(setTimeInput){
      setTimeInput.disabled = false;
    }

    if(applyTimeBtn){
      applyTimeBtn.disabled = false;
    }

    jumpButtons.forEach(btn=>{
      btn.disabled = false;
    });
  }
}


/* =========================================================
   THROTTLED SAVE CŨ
   ========================================================= */

let saveThrottle = null;

function throttledSave(){

  if(saveThrottle){
    return;
  }

  saveThrottle = setTimeout(
    ()=>{
      saveState();
      saveThrottle = null;
    },
    1500
  );
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
async function init(){

  await loadState();

  // Tải KHSX tháng hiện tại và tháng kế tiếp
  await loadPlansAround(new Date());

  /*
    ================================================
    TIME MODE
    ================================================
  */

  // Nếu state cũ chưa có timeMode
  if(
    state.timeMode !== "realtime" &&
    state.timeMode !== "simulation"
  ){
    state.timeMode = "realtime";
  }

  /*
    REAL TIME:
    Khi mở web luôn lấy thời gian thực hiện tại.
    Không sử dụng simTime cũ để làm đồng hồ.
  */

  if(state.timeMode === "realtime"){

    state.simTime = new Date().toISOString();
    state.lastTimeSync = state.simTime;

    playing = true;

  }else{

    // Simulation giữ simTime đã lưu
    playing = false;
  }

  recompute();
  renderAll();

  setupRealtime();

  /*
    Tạo bộ chọn:
    REAL TIME / SIMULATION
  */

  ensureTimeModeUI();
  updateTimeModeUI();

  /*
    clock loop
  */

  requestAnimationFrame(tickLoop);


  /*
    ================================================
    PLAY / PAUSE
    ================================================
  */

  $("#playPauseBtn").addEventListener("click", ()=>{

    // REAL TIME luôn chạy, không pause
    if(state.timeMode === "realtime"){
      return;
    }

    playing = !playing;

    lastFrameTs = null;

    updateTimeModeUI();
    renderClock();
  });


  /*
    ================================================
    SPEED
    ================================================
  */

  $("#speedSelect").addEventListener("change", e=>{
    speed = Number(e.target.value);
  });


  /*
    ================================================
    JUMPS
    ================================================
  */

  $$("[data-jump]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      jump(Number(btn.dataset.jump));
    });
  });


  /*
    ================================================
    SET TIME
    ================================================
  */

  $("#setTimeInput").value =
    new Date(state.simTime)
      .toISOString()
      .slice(0,19);

  $("#applyTimeBtn").addEventListener("click", async ()=>{

    // Không cho chỉnh giờ trong REAL TIME
    if(state.timeMode === "realtime"){
      toast("Hãy chuyển sang SIMULATION để chỉnh thời gian.");
      return;
    }

    const val = $("#setTimeInput").value;

    if(!val) return;

    const nextDate = new Date(val);

    await ensurePlanForDate(nextDate);

    setSimTime(nextDate);

    saveState();

    toast("Đã cập nhật thời gian mô phỏng.");
  });


  /*
    ================================================
    RESET SIMULATION
    ================================================
  */

 $("#resetSimBtn").addEventListener("click", ()=>{

  if(!confirm(
    "Reset thời gian mô phỏng về đầu ca? Lịch sử sản xuất thực tế sẽ được giữ nguyên."
  )) return;


  /*
    Chỉ reset VIEW của Simulation.
    Không đụng vào entryLog thực tế.
  */

  simulationViewLog = [];
  simulationViewConsumedMap = {};


  if(state.timeMode === "realtime"){

    state.simTime =
      new Date().toISOString();

  }else{

    state.simTime =
      getAnchor(
        state.config
      ).toISOString();

  }


  state.currentTick = 0;


  recompute();
  renderAll();

  saveState();


  toast(
    "Đã reset thời gian mô phỏng."
  );

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
// =====================================================
// KHSX IMPORT
// =====================================================

if($("#btnImportPlan")){

  $("#btnImportPlan").addEventListener(
    "click",
    ()=>{
      resetPlanImportUI();
      openModal("planImportModal");
    }
  );
}


if($("#planFileInput")){

  $("#planFileInput").addEventListener(
    "change",
    e=>{
      if(e.target.files[0]){
        handleProductionPlanFile(
          e.target.files[0]
        );
      }
    }
  );
}


if($("#planSheetSelect")){

  $("#planSheetSelect").addEventListener(
    "change",
    e=>{

      try{

        parseProductionPlanSheet(
          e.target.value
        );

        renderPlanPreview();

        $("#planImportInfo")
          .textContent =
          `KHSX tháng ${planImportCtx.planMonth} · ` +
          `${planImportCtx.parsedDays.length} ngày · ` +
          `Working Hours × UPH`;

      }catch(err){

        toast(
          err.message ||
          "Không đọc được sheet KHSX."
        );
      }
    }
  );
}


if($("#planImportConfirmBtn")){

  $("#planImportConfirmBtn")
    .addEventListener(
      "click",
      saveProductionPlan
    );
}
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


}

document.addEventListener("DOMContentLoaded", init);
})();
