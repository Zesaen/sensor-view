// 编辑器全局状态 + 多楼层核心(活动数组与楼层对象同引用) + 视图切换
/* ================= 视图切换 + 传感器地图 ================= */
const escH = s => String(s).replace(/[&<>"']/g,
  c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let mapPoints = [];      // {id,name,x,y(世界px),time,nImu,nWifi,imuSamples,wifiScans,collecting}
let walls = [];          // {x1,y1,x2,y2} 世界px
let doors = [];          // {x1,y1,x2,y2} 门宽方向 A→B, 门叶/弧线画在拖动方向左侧
let tables = [];         // {x1,y1,x2,y2} 矩形两角(已归一化)
let stairs = [];         // {x1,y1,x2,y2,dir} 楼梯矩形(已归一化); dir=1 上行指向长轴负端
let lifts = [];          // {x1,y1,x2,y2} 电梯井矩形(已归一化)
let routers = [];        // {x,y,z} 路由器/AP 位置(世界px), z=安装高度(米, 悬挂式不落地)
let chairs = [];         // {x1,y1,x2,y2,dir} 座椅(已归一化); dir 0-3 = 靠背在 上/右/下/左 边
let undoStack = [];      // {kind:'wall'|'door'|'table'|'stair'|'lift'|'router', obj} 供撤销

/* ---- 多楼层: 以上方 walls/doors/... 为「当前层」的活动数组(与楼层对象同引用), 切层即换引用 ---- */
let floors = [];         // [{id, level(int, 0=1F, -1=B1), name, points, walls, doors, tables, stairs, lifts, routers}]
let curFloorId = null;
const FLOOR_H = 3.0;     // 层高(米): 墙 2.8 + 板 0.2, 楼梯总升高 = 一层
const floorName = lv => lv > 0 ? (lv + 1) + "F" : lv === 0 ? "1F" : "B" + (-lv);
const floorById = id => floors.find(f => f.id === id);
const curFloor = () => floorById(curFloorId);
function syncFloorRefs() {   // 活动数组重绑(清空/应用模板等)后与楼层对象保持同引用
  const f = curFloor();
  if (!f) return;
  f.points = mapPoints; f.walls = walls; f.doors = doors; f.tables = tables;
  f.stairs = stairs; f.lifts = lifts; f.routers = routers; f.chairs = chairs;
}
function floorsPayload() {   // 持久化用: 当前层取活动数组, 其余层取各自数据
  return floors.map(f => f.id === curFloorId
    ? { id: f.id, level: f.level, name: f.name,
        points: mapPoints.map(slimPoint), walls, doors, tables, stairs, lifts, routers, chairs }
    : { id: f.id, level: f.level, name: f.name,
        points: (f.points || []).map(slimPoint),
        walls: f.walls || [], doors: f.doors || [], tables: f.tables || [],
        stairs: f.stairs || [], lifts: f.lifts || [], routers: f.routers || [], chairs: f.chairs || [] });
}
function loadFloorIntoEditor(f) {   // 切层: 活动数组指向目标楼层的数据
  mapPoints = f.points = Array.isArray(f.points) ? f.points : [];
  walls = f.walls = Array.isArray(f.walls) ? f.walls : [];
  doors = f.doors = Array.isArray(f.doors) ? f.doors : [];
  tables = f.tables = Array.isArray(f.tables) ? f.tables : [];
  stairs = f.stairs = Array.isArray(f.stairs) ? f.stairs : [];
  lifts = f.lifts = Array.isArray(f.lifts) ? f.lifts : [];
  routers = f.routers = Array.isArray(f.routers) ? f.routers : [];
  chairs = f.chairs = Array.isArray(f.chairs) ? f.chairs : [];
  curFloorId = f.id;
  undoStack = []; selPointId = null; selShape = null; arrayAnchor = null; shapeDraft = null;
}
let origin = { x: 0, y: 0 };
let gridSize = 50;       // 每格对应的世界像素
let snapOn = true;
let gridOn = true;       // 是否显示栅格
let gridMinorOn = true;  // 是否显示网格细线(粗线=每1米独立保留)
let wallThick = 10;      // 墙体厚度(世界px)
let thickUnit = "m";     // 厚度输入单位: m 最小 0.1m / px 最小 1px
let pxPerM = 50;         // 比例: 1 米 = ? 世界px
let view = { s: 1, tx: 0, ty: 0 };   // 屏幕 = 世界 * s + t
let wallSolidMode = null; // 远距缩放时墙体退化为实线(斜线间距大于墙宽)
let tool = "pan";        // pan | add | wall | origin
let selPointId = null;
let selShape = null;     // 选中的图形 {kind:'wall'|'door'|'table'|'router', obj}
let arrayAnchor = null;  // 阵列起点(世界px), 阵列模式下第一次点击或选中的测点
let lastMouse = null;    // 最近一次鼠标位置(世界px), 供阵列预览
let mapHasImage = false;
let collectingN = 0;     // 正在采样的测点数(>0 时才在数据流上分发, 保证实时性能)
let shapeDraft = null;   // {kind:'wall'|'door'|'table'|'stair'|'lift', x1,y1,x2,y2}
let drawnGesture = false;  // 刚完成一笔绘制的标志: 其尾随 click 只用于收尾, 不参与选中/放点
let panState = null;
let dragShape = null;    // 平移模式下按住的图形 {kind, obj, orig, sx, sy, px, py, moved}
let mapImgNatural = [0, 0];

const pointById = id => mapPoints.find(q => q.id === id);
async function apiPost(url, body, ctype) {
  try {
    const r = await fetch(url, { method: "POST", body,
      headers: ctype ? { "Content-Type": ctype } : {} });
    return await r.json();
  } catch { return null; }
}

let curView = "home";
function showView(v) {
  curView = v;
  $("viewHome").style.display = v === "home" ? "" : "none";
  $("viewLive").style.display = v === "live" ? "" : "none";
  $("viewMap").style.display = v === "map" ? "" : "none";
  for (const [id, name] of [["tabHome", "home"], ["tabLive", "live"], ["tabMap", "map"]])
    $(id).classList.toggle("active", v === name);
  if (v === "map") applyView();
}
function goHome() { showView("home"); refreshHome(); }
function enterMapView() {          // 没打开地图时回主页挑选
  if (!curMap) { goHome(); return; }
  showView("map");
}
$("tabHome").onclick = goHome;
$("tabLive").onclick = () => showView("live");
$("tabMap").onclick = enterMapView;
$("btnHomeLive").onclick = () => showView("live");
