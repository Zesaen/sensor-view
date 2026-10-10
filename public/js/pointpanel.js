// 测点列表 / 详情面板 / 均值统计
function updateMapStat() {
  $("mapStat").textContent = mapPoints.length + " 个坐标点";
  $("ptCount").textContent = mapPoints.length;
}
function renderPtList() {
  const box = $("ptList");
  if (!mapPoints.length) { box.innerHTML = '<div class="empty">暂无坐标点</div>'; return; }
  box.innerHTML = mapPoints.map((p, i) => `
    <div class="ptItem${p.id === selPointId ? " sel" : ""}" data-id="${p.id}">
      <span class="ptNo">${i + 1}</span>
      <span class="ptName">${escH(p.name)}</span>
      <span class="ptXY">${coordText(p)}</span>
      <button class="ptDel" title="删除该测点">×</button>
    </div>`).join("");
  box.querySelectorAll(".ptItem").forEach(el => {
    el.onclick = () => selectPoint(el.dataset.id);
    el.querySelector(".ptDel").onclick = ev => { ev.stopPropagation(); delPoint(el.dataset.id); };
  });
}
function selectPoint(id) {
  selPointId = id;
  selShape = null; updateShapeCtl();
  renderMarkers(); renderPtList(); renderDetail(); renderDrawings();
}
function delPoint(id) {   // 删除单个测点; 数据库中该点采样一并删除
  const i = mapPoints.findIndex(q => q.id === id);
  if (i < 0) return;
  const p = mapPoints[i];
  const hasData = (p.imuSamples || []).length || (p.wifiScans || []).length || (p.roundsDone | 0);
  if (hasData && !confirm(`删除测点「${p.name}」及其数据库中的采样数据?`)) return;
  if (p.collecting) collectingN--;
  mapPoints.splice(i, 1);
  apiPost("/api/db/delete", JSON.stringify({ point_id: id }), "application/json")
    .then(() => refreshDbCard());
  if (selPointId === id) { selPointId = null; renderDetail(); }
  persist(); renderMarkers(); renderPtList();
}

/* ---- 统计(均值) ---- */
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
function circMeanDeg(a) {
  let sx = 0, sy = 0;
  for (const v of a) { sx += Math.sin(v * Math.PI / 180); sy += Math.cos(v * Math.PI / 180); }
  return (Math.atan2(sx, sy) * 180 / Math.PI + 360) % 360;
}
function imuAvg(p) {
  if (p.stat && p.stat.n_imu)          // SQLite 聚合为准, 库中记录被增删改后均值随之更新
    return { yaw: p.stat.yaw, pitch: p.stat.pitch, roll: p.stat.roll,
             mx: p.stat.mx, my: p.stat.my, mz: p.stat.mz };
  const s = p.imuSamples || [];
  if (!s.length) return null;
  return {
    yaw: circMeanDeg(s.map(x => x.yaw)),
    pitch: mean(s.map(x => x.pitch)), roll: mean(s.map(x => x.roll)),
    mx: mean(s.map(x => x.mag[0])), my: mean(s.map(x => x.mag[1])), mz: mean(s.map(x => x.mag[2])),
  };
}
function wifiAvg(p) {
  if (p.stat && p.stat.aps && p.stat.aps.length)
    return p.stat.aps.map(a => ({ name: a.name, rssi: a.rssi }));
  const m = new Map();
  for (const sc of p.wifiScans || [])
    for (const a of (sc.aps || [])) {
      if (!m.has(a.name)) m.set(a.name, []);
      m.get(a.name).push(+a.rssi);
    }
  return [...m.entries()].map(([name, rs]) => ({ name, rssi: Math.round(mean(rs)) }));
}
function ptImuCount(p) { return (p.stat && p.stat.n_imu || 0) + (p.imuSamples || []).length; }
function ptScanCount(p) { return (p.stat && p.stat.n_scans || 0) + (p.wifiScans || []).length; }

function renderDetail() {
  const box = $("ptDetail");
  const p = pointById(selPointId);
  $("btnResetPt").disabled = !p;
  $("btnDelPt").disabled = !p;
  $("btnRawData").disabled = !p;
  if (!p) {
    box.innerHTML = '<div class="empty">点击地图上的圆点查看该点传感器数据</div>';
    $("ptTime").textContent = "";
    return;
  }
  ensureStat(p);
  $("ptTime").textContent = p.time || "";
  const ia = imuAvg(p), wa = wifiAvg(p);
  const done = Math.min(4, p.roundsDone | 0);
  const chips = [];
  for (let k = 0; k < 4; k++) {
    const isDone = k < done;
    chips.push(`<span class="oriChip${isDone ? " done" : (k === done && !p.collecting ? " next" : "")}"
      data-k="${k}">${k * 90}°${isDone ? " ✓" : ""}</span>`);
  }
  const f1 = v => (typeof v === "number" && isFinite(v) ? v.toFixed(1) : "--");
  const b = ia ? Math.hypot(ia.mx, ia.my, ia.mz).toFixed(2) : "--";
  const apRows = (wa && wa.length)
    ? wa.map(a => {
        const c = rssiColor(a.rssi);
        return `<tr><td class="name" title="${escH(a.name)}">${escH(a.name)} ×${ptScanCount(p)}</td>
          <td class="rssi" style="color:${c}">${a.rssi} dBm</td></tr>`;
      }).join("")
    : '<tr><td colspan="2" class="empty">无 AP 数据</td></tr>';
  box.innerHTML = `
    <div class="ptHead">
      <input id="ptName" class="txt grow" value="${escH(p.name)}" maxlength="30" title="修改名称后自动保存">
      <span class="ptCoord">${coordText(p)}</span>
    </div>
    <div class="frmRow"><span class="frmLab">每次采集 IMU 条数</span>
      <input id="ptNImu" class="txt" type="number" min="0" step="1" value="${p.nImu | 0}"></div>
    <div class="frmRow"><span class="frmLab">每次采集 WiFi 扫描次数</span>
      <input id="ptNWifi" class="txt" type="number" min="0" step="1" value="${p.nWifi | 0}"></div>
    <div class="ptProg" id="ptProg">${p.collecting
      ? "采集中 " + progText(p)
      : `已采 ${done}/4 次 · IMU ${ptImuCount(p)} 条 · WiFi ${ptScanCount(p)} 次扫描`}</div>
    <div class="oriChips">${chips.join("")}</div>
    <button class="btn primary" id="btnCap" style="width:100%"
      ${p.collecting || done >= 4 ? "disabled" : ""}>${p.collecting
        ? "采集中 " + progText(p)
        : done >= 4 ? "已完成 4/4 次采集"
        : `采集（第 ${done + 1}/4 次 · 朝向 ${done * 90}°）`}</button>
    <div class="ptGrid">
      <div class="stat"><div class="k">Yaw 均值</div><div class="v">${f1(ia && ia.yaw)}°</div></div>
      <div class="stat"><div class="k">Pitch 均值</div><div class="v">${f1(ia && ia.pitch)}°</div></div>
      <div class="stat"><div class="k">Roll 均值</div><div class="v">${f1(ia && ia.roll)}°</div></div>
      <div class="stat"><div class="k">|B| 均值</div><div class="v">${b} µT</div></div>
    </div>
    <table class="ptAp"><tbody>${apRows}</tbody></table>`;
  $("ptName").onchange = e => {
    const v = e.target.value.trim();
    if (v) { p.name = v; persist(); renderPtList(); renderMarkers(); }
    else e.target.value = p.name;
  };
  $("ptNImu").onchange = e => {
    p.nImu = Math.max(0, +e.target.value | 0);   // 只改设置, 不触发采集
    persist(); renderMarkers();
  };
  $("ptNWifi").onchange = e => {
    p.nWifi = Math.max(0, +e.target.value | 0);
    persist(); renderMarkers();
  };
  const capBtn = $("btnCap");
  if (capBtn && !capBtn.disabled) capBtn.onclick = () => captureRound(p);
  const nextChip = box.querySelector(".oriChip.next");   // 点下一个朝向槽位 = 按采集
  if (nextChip) nextChip.onclick = () => captureRound(p);
}

$("btnResetPt").onclick = () => {
  const p = pointById(selPointId);
  if (!p) return;
  if (!confirm("清空该点已采数据(含数据库中的采样), 从第 1 次(朝向 0°)重新采集?")) return;
  p.imuSamples = []; p.wifiScans = [];
  p.roundsDone = 0; p.burst = null; p.nWifiSaved = 0;
  p.stat = null; p.statFetched = false;
  setCollecting(p, false);
  apiPost("/api/db/delete", JSON.stringify({ point_id: p.id }), "application/json")
    .then(() => refreshDbCard());
  persist(); renderDetail(); renderMarkers();
};

$("btnDelPt").onclick = () => delPoint(selPointId);
$("btnRawData").onclick = () => {         // 打开数据库管理窗并定位到该测点
  const p = pointById(selPointId);
  if (p) dbOpen(p.id);
};

/* ---- 网格 / 吸附设置 ---- */
$("gridSizeIn").onchange = e => {
  gridSize = Math.min(500, Math.max(10, +e.target.value || 50));
  e.target.value = gridSize;
  persist(); applyView(); renderMarkers(); renderPtList(); renderDetail();
};
$("gridOnIn").onchange = e => { gridOn = e.target.checked; applyView(); persist(); };
$("gridMinorIn").onchange = e => { gridMinorOn = e.target.checked; applyView(); persist(); };
$("snapOn").onchange = e => { snapOn = e.target.checked; };
