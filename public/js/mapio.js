// 地图加载/保存(persist 节流)/样本入 SQLite/底图上传
/* ---- 加载 / 保存 (多地图: 数据由 openMap 拉取后应用) ---- */
function applyMapData(d) {
  if (!d) return;
  // 楼层: 优先读 floors; 旧版单层数据 → 合成为 1F
  const src = Array.isArray(d.floors) && d.floors.length
    ? d.floors.filter(f => f && typeof f === "object").map(f => {
        const lv = Math.round(+f.level || 0);
        return { id: typeof f.id === "string" && f.id ? f.id : "fl" + lv + "-" + Math.floor(Math.random() * 46656).toString(36),
                 level: lv, name: (typeof f.name === "string" && f.name) || floorName(lv),
                 points: Array.isArray(f.points) ? f.points : [],
                 walls: Array.isArray(f.walls) ? f.walls : [],
                 doors: Array.isArray(f.doors) ? f.doors : [],
                 tables: Array.isArray(f.tables) ? f.tables : [],
                 stairs: Array.isArray(f.stairs) ? f.stairs : [],
                 lifts: Array.isArray(f.lifts) ? f.lifts : [],
                 routers: Array.isArray(f.routers) ? f.routers : [],
                 chairs: Array.isArray(f.chairs) ? f.chairs : [] };
      })
    : [{ id: "fl0-" + Math.floor(Math.random() * 46656).toString(36), level: 0, name: "1F",
        points: Array.isArray(d.points) ? d.points : [],
        walls: Array.isArray(d.walls) ? d.walls : [],
        doors: Array.isArray(d.doors) ? d.doors : [],
        tables: Array.isArray(d.tables) ? d.tables : [],
        stairs: Array.isArray(d.stairs) ? d.stairs : [],
        lifts: Array.isArray(d.lifts) ? d.lifts : [],
        routers: Array.isArray(d.routers) ? d.routers : [],
        chairs: Array.isArray(d.chairs) ? d.chairs : [] }];
  floors = src;
  floors.sort((a, b) => a.level - b.level);
  const cur = floors.some(f => f.id === d.curFloor) ? floors.find(f => f.id === d.curFloor) : floors[0];
  loadFloorIntoEditor(cur);
  renderFloorBar();
  if (d.origin && typeof d.origin.x === "number") origin = { x: d.origin.x, y: d.origin.y };
  if (typeof d.gridSize === "number" && d.gridSize >= 5) gridSize = d.gridSize;
  $("gridSizeIn").value = gridSize;
  if (typeof d.wallThick === "number" && d.wallThick >= 1) wallThick = d.wallThick;
  if (d.thickUnit === "px" || d.thickUnit === "m") thickUnit = d.thickUnit;
  if (typeof d.pxPerM === "number" && d.pxPerM >= 1) pxPerM = d.pxPerM;
  gridOn = d.gridOn !== false;
  $("gridOnIn").checked = gridOn;
  gridMinorOn = d.gridMinorOn !== false;
  $("gridMinorIn").checked = gridMinorOn;
  syncThickInput();
  for (const p of mapPoints) {   // 手动采集: 载入后一律待按键, 清掉残留的采集中状态
    p.collecting = false; p.burst = null;
    p.roundsDone = Math.min(4, p.roundsDone | 0);
  }
  collectingN = 0;
  if (d.image) {
    mapHasImage = true;
    $("mapImg").src = d.image;
    $("mapImg").style.display = "block";
    $("mapStage").classList.remove("gridBg");
  } else {
    mapHasImage = false;
    mapImgNatural = [0, 0];
    $("mapImg").style.display = "none";
    $("mapImg").removeAttribute("src");
    $("mapStage").classList.add("gridBg");
  }
  fitViewSoon();
  setTool("pan");                  // 打开新地图回到平移模式, 避免沿用上一张图的绘制状态
  renderDrawings(); renderMarkers(); renderPtList(); renderDetail(); applyView();
  updateShapeCtl();
  migrateLegacySamples();
}
function fitViewSoon() {    // 图片尺寸在 load 事件后才可知, 异步复位取景
  if (mapHasImage) setTimeout(fitView, 60);
  else fitView();
}
async function migrateLegacySamples() {   // 旧版样本存在 map.json 里 → 一次性全量迁入 SQLite(replace 幂等)
  let n = 0;
  for (const p of mapPoints)
    if ((p.imuSamples || []).length || (p.wifiScans || []).length) n++;
  if (!n) return;
  for (const p of mapPoints) {
    if (!(p.imuSamples || []).length && !(p.wifiScans || []).length) continue;
    const r = await dbSaveSamples(p, p.imuSamples || [], p.wifiScans || [], true);
    if (r && r.ok) {
      p.imuSamples = []; p.wifiScans = [];
    } else console.warn("[db] 历史样本迁移失败, 保留在内存中", p.id, r);
  }
  persist(); renderDetail(); refreshDbCard();
  console.log("[db] 历史样本迁移完成:", n, "个测点");
}
async function dbSaveSamples(p, imu, wifi, replace) {   // 样本写入服务器 SQLite
  if (!imu.length && !wifi.length) return { ok: true, imu: 0, wifi: 0 };
  const base = replace ? 0 : (p.nWifiSaved | 0);        // replace 模式扫描号重新从 1 编
  const body = {
    point_id: p.id, replace: !!replace,
    imu: imu.map(s => ({ t: s.t, yaw: s.yaw, pitch: s.pitch, roll: s.roll, mag: s.mag, ori: s.ori })),
    wifi: wifi.map((sc, j) => ({ t: sc.t, aps: sc.aps || [], ori: sc.ori, yaw: sc.yaw,
                                  scan_no: base + j + 1 })),
  };
  const r = await apiPost("/api/db/bulk", JSON.stringify(body), "application/json");
  if (r && r.ok) {
    p.nWifiSaved = base + wifi.length;
    p.stat = null; p.statFetched = false;              // 聚合缓存失效, 下次渲染重新拉取
    refreshDbCard();
  }
  return r;
}
async function dbSaveBurst(p, burst) {                  // burst 采满 → 增量入库(只发本次)
  const r = await dbSaveSamples(p, burst.imu, burst.wifi, false);
  if (r && r.ok) {           // 已入库: 内存去掉已入库的尾部样本(失败时保留, 随下次重试)
    p.imuSamples.length -= burst.imu.length;
    p.wifiScans.length -= burst.wifi.length;
  } else console.warn("[db] 本次采集入库失败, 样本暂留内存", p.id, r);
  persistSoon();
}
async function ensureStat(p) {                          // 详情面板按需拉取该点的库内聚合
  if (!p || p.statFetched || !(p.roundsDone | 0)) return;
  p.statFetched = true;
  const d = await api("/api/db/agg?point_id=" + encodeURIComponent(p.id));
  if (d && d.ok && d.points.length) {
    p.stat = d.points[0];
    if (p.id === selPointId) renderDetail();
  }
}
async function refreshDbCard() {
  const d = await api("/api/db/stats");
  if (!d || !d.ok) return;
  $("dbCount").textContent = (d.imu + d.wifi) + " 条";
  $("dbCardInfo").textContent = `IMU ${d.imu} 条 · WiFi ${d.wifi} 条 · ${(d.db_bytes / 1024).toFixed(1)} KB`;
}
function slimPoint(p) {   // 原始样本已入 SQLite, map.json 只存测点几何/设置/扫描偏移
  const q = {};
  for (const k of ["id", "name", "x", "y", "time", "nImu", "nWifi", "roundsDone", "nWifiSaved"])
    if (p[k] !== undefined) q[k] = p[k];
  return q;
}
function persist() {
  if (!curMap) return;          // 未打开地图时不保存
  syncFloorRefs();              // 清空/应用模板等会重绑活动数组, 保存前归位到楼层对象
  apiPost(`/api/maps/${curMap.id}/data`,
    JSON.stringify({ points: mapPoints.map(slimPoint), walls, doors, tables, stairs, lifts, routers, chairs,
                     floors: floorsPayload(), curFloor: curFloorId,
                     origin, gridSize,
                     wallThick, thickUnit, pxPerM, gridOn, gridMinorOn }), "application/json");
}
let persistTimer = null;
function persistSoon() {   // 高频采样时节流保存
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; persist(); }, 800);
}

$("mapImg").addEventListener("load", () => {
  mapImgNatural = [$("mapImg").naturalWidth, $("mapImg").naturalHeight];
  fitView();
});

$("mapFile").addEventListener("change", async e => {
  const f = e.target.files[0];
  if (!f) return;
  if (!curMap) { alert("请先打开或新建地图"); e.target.value = ""; return; }
  if (f.size > 10 * 1024 * 1024) { alert("图片不能超过 10MB"); e.target.value = ""; return; }
  const buf = await f.arrayBuffer();
  const res = await apiPost(`/api/maps/${curMap.id}/image?name=` + encodeURIComponent(f.name), buf);
  if (res && res.ok) {
    mapHasImage = true;
    previewCache.delete(curMap.id);
    $("mapImg").src = `/api/maps/${curMap.id}/image?t=` + Date.now();
    $("mapImg").style.display = "block";
    $("mapStage").classList.remove("gridBg");
  } else alert("地图图片上传失败");
  e.target.value = "";
});

async function restoreGridBg() {   // 「绘图」菜单: 去掉图片底图, 恢复网格底图
  if (!curMap) return;
  mapHasImage = false;
  mapImgNatural = [0, 0];
  $("mapImg").style.display = "none";
  $("mapImg").removeAttribute("src");
  $("mapStage").classList.add("gridBg");
  fitView();
  previewCache.delete(curMap.id);
  await apiPost(`/api/maps/${curMap.id}/image?name=clear`, new ArrayBuffer(0));   // 空请求体 = 删除底图
};
