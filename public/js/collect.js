// 测点采样: 按键采集/四向采样/进度徽标
/* ---- 测点采样(按数量存储) ---- */
function setCollecting(p, on) {
  if (!p.imuSamples) p.imuSamples = [];
  if (!p.wifiScans) p.wifiScans = [];
  if (on && !p.collecting) { p.collecting = true; collectingN++; }
  else if (!on && p.collecting) { p.collecting = false; collectingN--; }
}
function makePointAt(wx, wy) {   // 新建测点对象(不入数组, 供单个/阵列共用)
  return {
    id: Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36),
    name: "P" + nextPointNo(), x: wx, y: wy, time: nowStr(),
    nImu: Math.max(0, +$("defImuN").value | 0),
    nWifi: Math.max(0, +$("defWifiN").value | 0),
    roundsDone: 0, imuSamples: [], wifiScans: [], collecting: false,
  };
}
function addPointAt(wx, wy) {
  // 手动采集: 放点后不自动采样, 4 次采集全部由详情面板「采集」按键触发
  const p = makePointAt(wx, wy);
  mapPoints.push(p);
  undoStack.push({ kind: "point", obj: [p] });
  selPointId = p.id;
  persist(); renderMarkers(); renderPtList(); renderDetail();
}
function tapCollect(kind, payload) {   // 采集期内由 onImu / onRssi 调用, 只分发给正在按键采集的测点
  let dirty = false, finished = null;
  for (const p of mapPoints) {
    if (!p.collecting || !p.burst) continue;
    if (kind === "imu" && p.burst.needImu > 0) {
      const s = Object.assign({}, payload, { ori: p.burst.ori });
      p.imuSamples.push(s); p.burst.imu.push(s);       // burst 数组用于采满后增量入库
      p.burst.needImu--; dirty = true;
    } else if (kind === "wifi" && p.burst.needWifi > 0) {
      const sc = Object.assign({}, payload, { yaw: tgt.yaw, ori: p.burst.ori });
      p.wifiScans.push(sc); p.burst.wifi.push(sc);
      p.burst.needWifi--; dirty = true;
    } else continue;
    if (p.burst.needImu <= 0 && p.burst.needWifi <= 0) {   // 本朝向采满 → 本次采集结束
      const done = p.burst;
      p.burst = null;
      p.roundsDone = Math.min(4, (p.roundsDone | 0) + 1);
      setCollecting(p, false);
      p.time = nowStr();
      finished = { p, burst: done };
      if (p.id === selPointId) renderDetail();
    }
  }
  if (dirty) { updateCollectBadges(); persistSoon(); }
  if (finished) {          // 刷新标记上的 k/4 进度徽标 + 样本入库
    renderMarkers();
    dbSaveBurst(finished.p, finished.burst);
  }
}
/* 手动按键采集: 每按一次采一个朝向槽(0°→90°→180°→270°), 按设置条数采满自动结束本次 */
function captureRound(p) {
  if (p.collecting) return;                        // 本次还没采满, 不叠加
  if ((p.roundsDone | 0) >= 4) { alert("该点 4 次采集已完成, 如需重采请先「重置采样」"); return; }
  const nImu = Math.max(0, p.nImu | 0), nWifi = Math.max(0, p.nWifi | 0);
  if (!nImu && !nWifi) { alert("每次采集的 IMU 条数与 WiFi 次数均为 0, 请先在下方设置"); return; }
  if (nWifi && !lastAps.length) { alert("尚未收到 WiFi 扫描数据, 请确认设备已推送 RSSI"); return; }
  p.burst = { ori: (p.roundsDone % 4) * 90, needImu: nImu, needWifi: nWifi, imu: [], wifi: [] };
  setCollecting(p, true);
  persist(); renderDetail(); renderMarkers();
}
function progText(p) {
  return p.burst
    ? `${p.burst.ori}° IMU ${(p.nImu | 0) - p.burst.needImu}/${p.nImu | 0} · WiFi ${(p.nWifi | 0) - p.burst.needWifi}/${p.nWifi | 0}`
    : `${Math.min(4, p.roundsDone | 0)}/4 次`;
}
function updateCollectBadges() {   // 只改文字, 不重建 DOM, 避免高频重绘
  for (const p of mapPoints) {
    if (!p.collecting) continue;
    const el = document.querySelector(`.mkProg[data-id="${p.id}"]`);
    if (el) el.textContent = progText(p);
    if (p.id === selPointId) {
      const s = $("ptProg");
      if (s) s.textContent = "采集中 " + progText(p);
      const b = $("btnCap");
      if (b && b.disabled) b.textContent = "采集中 " + progText(p);
    }
  }
}
function nextPointNo() {
  let mx = 0;
  for (const p of mapPoints) {
    const m = /^P(\d+)$/.exec(p.name || "");
    if (m) mx = Math.max(mx, +m[1]);
  }
  return mx + 1;
}
function nowStr() { return new Date().toLocaleString("zh-CN", { hour12: false }); }
function fmtT(ts) { return new Date(ts).toLocaleString("zh-CN", { hour12: false }); }
