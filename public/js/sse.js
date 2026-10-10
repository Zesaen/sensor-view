// SSE 数据接入 + 实时仪表(IMU/RSSI 徽标/AP 表/曲线)
/* ================= SSE 数据接入 ================= */
const tgt = { yaw: 0, pitch: 0, roll: 0, mag: [0, 0, 0] };   // 目标姿态(来自最新 IMU)
const cur = { yaw: 0, pitch: 0, roll: 0 };                   // 显示用平滑姿态
let lastImuTs = 0, lastRssiTs = 0, bootMs = null;
const stats = { imuCount: 0, rssiCount: 0, imuRate: 0, rssiRate: 0 };
const apHistory = new Map();      // name -> [{t(ms), rssi}]
const apPalette = ["#0047ab", "#b3123e", "#0f766f", "#7c3aed", "#b45309", "#0e7490", "#a21caf"];
const apColor = new Map();

function colorFor(name) {
  if (!apColor.has(name)) apColor.set(name, apPalette[apColor.size % apPalette.length]);
  return apColor.get(name);
}


function onImu(d) {
  if (typeof d.yaw === "number") tgt.yaw = d.yaw;
  if (typeof d.pitch === "number") tgt.pitch = d.pitch;
  if (typeof d.roll === "number") tgt.roll = d.roll;
  if (Array.isArray(d.mag) && d.mag.length === 3) tgt.mag = d.mag;
  lastImuTs = Date.now();
  $("attOverlay").textContent = `yaw ${fmt1(d.yaw)}° · pitch ${fmt1(d.pitch)}° · roll ${fmt1(d.roll)}°`;
  $("vYaw").textContent = fmt1(d.yaw);
  $("vPitch").textContent = fmt1(d.pitch);
  $("vRoll").textContent = fmt1(d.roll);
  $("bYaw").style.width = ((d.yaw + 180) / 360 * 100).toFixed(1) + "%";
  $("bPitch").style.width = ((d.pitch + 90) / 180 * 100).toFixed(1) + "%";
  $("bRoll").style.width = ((d.roll + 90) / 180 * 100).toFixed(1) + "%";
  const [mx, my, mz] = tgt.mag;
  const mag = Math.hypot(mx, my, mz);
  $("vMx").textContent = fmt1(mx); $("vMy").textContent = fmt1(my); $("vMz").textContent = fmt1(mz);
  $("vMag").textContent = fmt1(mag);
  // 磁场水平分量的罗盘方位(机体系: x前 y右; 实测校验 mx≈1,my≈31 → 272°, 与 yaw -89° 吻合)
  const heading = (Math.atan2(-my, mx) * 180 / Math.PI + 360) % 360;
  $("magDir").textContent = "磁场罗盘方位 " + heading.toFixed(0) + "°";
  if (collectingN) tapCollect("imu", { t: Date.now(), yaw: d.yaw, pitch: d.pitch, roll: d.roll, mag: tgt.mag.slice() });
}

function onRssi(d) {
  lastRssiTs = Date.now();
  if (typeof d.timestamp_ms === "number") bootMs = d.timestamp_ms;
  const aps = (d.aps || []).slice().sort((a, b) => (a.rank || 99) - (b.rank || 99));
  const now = Date.now();
  for (const ap of aps) {
    if (!apHistory.has(ap.name)) apHistory.set(ap.name, []);
    const h = apHistory.get(ap.name);
    h.push({ t: now, rssi: ap.rssi });
    if (h.length > 130) h.shift();
  }
  renderApTable(aps);
  renderChart(aps);
  if (collectingN) tapCollect("wifi", { t: Date.now(), aps: aps.map(a => ({ name: a.name, rssi: a.rssi })) });
}

function rssiColor(r) {
  if (r >= -55) return "#0a7d33";
  if (r >= -70) return "#7d6f00";
  if (r >= -80) return "#a24c00";
  return "#c01414";
}

let lastAps = [];   // 最近一次 AP 列表, 供 1s 定时器重绘曲线
function renderApTable(aps) {
  lastAps = aps;
  const tb = $("apBody");
  if (!aps.length) { tb.innerHTML = '<tr><td class="empty" colspan="4">无 AP</td></tr>'; return; }
  tb.innerHTML = aps.map(ap => {
    const pct = Math.max(2, Math.min(100, (ap.rssi + 100) / 70 * 100));
    const c = rssiColor(ap.rssi);
    return `<tr>
      <td class="rank">${ap.rank}</td>
      <td class="name" title="${ap.name}">${ap.name}</td>
      <td><div class="sigbar"><i style="width:${pct}%;background:${c}"></i></div></td>
      <td class="rssi" style="color:${c}">${ap.rssi} dBm</td>
    </tr>`;
  }).join("");
}

function renderChart(aps) {
  const cv = $("rssiChart");
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight || 130;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  // 取当前排名前 3 的 AP
  const top = aps.slice(0, 3).map(a => a.name);
  const legend = $("chartLegend");
  legend.innerHTML = top.map((n, i) =>
    `<div class="lg"><span class="sw" style="background:${colorFor(n)}"></span><span>${n}</span></div>`).join("");

  const RMIN = -100, RMAX = -30, PADL = 34, PADR = 6, PADT = 8, PADB = 16;
  const yOf = r => PADT + (H - PADT - PADB) * (1 - (r - RMIN) / (RMAX - RMIN));

  ctx.strokeStyle = "#d3d9e0"; ctx.fillStyle = "#3c4653"; ctx.font = "10px Consolas";
  ctx.textAlign = "right";
  for (let r = RMAX; r >= RMIN; r -= 20) {
    const y = yOf(r);
    ctx.beginPath(); ctx.moveTo(PADL, y); ctx.lineTo(W - PADR, y); ctx.stroke();
    ctx.fillText(r, PADL - 4, y + 3);
  }

  const now = Date.now(), SPAN = 240000;   // 4 分钟窗口
  for (let i = 0; i < top.length; i++) {
    const h = apHistory.get(top[i]) || [];
    if (h.length < 2) continue;
    ctx.strokeStyle = colorFor(top[i]); ctx.lineWidth = 1.6; ctx.beginPath();
    let started = false;
    for (const p of h) {
      const age = now - p.t;
      if (age > SPAN) continue;
      const px = PADL + (W - PADL - PADR) * (1 - age / SPAN);
      const py = yOf(Math.max(RMIN, Math.min(RMAX, p.rssi)));
      started ? ctx.lineTo(px, py) : (ctx.moveTo(px, py), started = true);
    }
    ctx.stroke();
  }
  ctx.textAlign = "left"; ctx.fillStyle = "#3c4653";
  ctx.fillText("-4min", PADL, H - 4); ctx.textAlign = "right"; ctx.fillText("now", W - PADR, H - 4);
}

/* SSE 连接 */
let sseOk = false;
function setSse(ok, txt) {
  sseOk = ok;
  $("dotSse").className = "dot " + (ok ? "ok" : "bad");
  $("sseBadge").textContent = txt;
}
const es = new EventSource("/events");
es.onopen = () => setSse(true, "已连接");
es.onerror = () => setSse(false, "重连中…");
es.addEventListener("snapshot", e => {
  const s = JSON.parse(e.data);
  if (s.imu) onImu(s.imu);
  if (s.rssi) onRssi(s.rssi);
  if (s.stats) {
    lastImuTs = s.stats.last_ts.imu * 1000 || lastImuTs;
    lastRssiTs = s.stats.last_ts.rssi * 1000 || lastRssiTs;
  }
});
es.addEventListener("imu", e => onImu(JSON.parse(e.data)));
es.addEventListener("rssi", e => onRssi(JSON.parse(e.data)));
