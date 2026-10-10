// API 封装 + 后台采集控制(开始/停止/下载/清空)
/* ================= 数据采集控制 ================= */
async function api(url) {
  try { const r = await fetch(url); return await r.json(); } catch { return null; }
}

async function refreshCollect() {
  const s = await api("/api/status");
  if (!s || !s.recording) return;
  // 累计条数与速率以服务器为准(清空后自动归零)
  stats.imuCount = s.counts.imu; stats.rssiCount = s.counts.rssi;
  stats.imuRate = s.rates.imu; stats.rssiRate = s.rates.rssi;
  const on = s.recording.imu.active || s.recording.rssi.active;
  const st = $("colState");
  st.textContent = on ? "采集中…" : "未采集";
  st.style.color = on ? "var(--green)" : "";
  $("btnStart").disabled = on;
  $("btnStop").disabled = !on;
  const parts = [];
  for (const [k, label] of [["imu", "IMU"], ["rssi", "WiFi"]]) {
    const r = s.recording[k];
    let seg = `${label} ${s.history[k]} 条`;
    if (r.active) seg += `（本次 ${r.taken}${r.limit ? "/" + r.limit : ""}）`;
    parts.push(seg);
  }
  $("colInfo").textContent = "后台已存: " + parts.join(" · ");
}

$("btnStart").onclick = async () => {
  const srcs = [$("srcImu").checked ? "imu" : null, $("srcWifi").checked ? "wifi" : null].filter(Boolean);
  if (!srcs.length) { alert("请至少选择一个数据源"); return; }
  const limit = Math.max(0, parseInt($("colLimit").value, 10) || 0);
  const src = srcs.length === 2 ? "all" : srcs[0];
  await api(`/api/collect?action=start&src=${src}&limit=${limit}`);
  refreshCollect();
};
$("btnStop").onclick = async () => {
  await api("/api/collect?action=stop&src=all");
  refreshCollect();
};
$("btnClear").onclick = async () => {
  if (!confirm("确定清空后台已采集的全部数据？此操作不可恢复。")) return;
  await api("/api/clear");
  apHistory.clear();   // 顺带清掉页面上的历史曲线缓冲
  refreshCollect();
};
function download(src) {
  const a = document.createElement("a");
  a.href = `/api/download?src=${src}&fmt=${$("dlFmt").value}`;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
$("btnDlImu").onclick = () => download("imu");
$("btnDlWifi").onclick = () => download("wifi");
