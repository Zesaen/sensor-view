// CSV 导出
/* ---- 导出 CSV ---- */
function downloadCsv(lines, prefix) {
  const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const aEl = document.createElement("a");
  aEl.href = URL.createObjectURL(blob);
  aEl.download = prefix + new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "") + ".csv";
  document.body.appendChild(aEl);
  aEl.click();
  aEl.remove();
}
const csvEsc = v => { v = v == null ? "" : String(v);
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
const f1 = v => (typeof v === "number" && isFinite(v) ? v.toFixed(1) : "");
const f2 = v => (typeof v === "number" && isFinite(v) ? v.toFixed(2) : "");

$("btnExportCsv").onclick = async () => {   // 汇总: 每测点一行, 均值取自 SQLite 聚合
  if (!mapPoints.length) { alert("暂无坐标点, 请先在地图上添加"); return; }
  const agg = await api("/api/db/agg");     // 刷新各点聚合缓存(库被编辑后导出即为最新)
  if (agg && agg.ok)
    for (const s of agg.points) { const p = pointById(s.point_id); if (p) { p.stat = s; p.statFetched = true; } }
  if (agg && agg.ok) renderDetail();
  const apNames = [];
  for (const p of mapPoints)
    for (const a of wifiAvg(p))
      if (!apNames.includes(a.name)) apNames.push(a.name);
  const head = ["编号", "名称", "相对X(格)", "相对Y(格)", "图上坐标(px)", "记录时间", "采集次数",
                "IMU样本数", "WiFi扫描数", "Yaw(°)", "Pitch(°)", "Roll(°)",
                "MagX(µT)", "MagY(µT)", "MagZ(µT)", "|B|(µT)",
                ...apNames.map(n => n + " 平均RSSI(dBm)")];
  const lines = [head.map(csvEsc).join(",")];
  mapPoints.forEach((p, i) => {
    const ia = imuAvg(p), wap = wifiAvg(p);
    const b = ia ? Math.hypot(ia.mx, ia.my, ia.mz).toFixed(2) : "";
    const rx = (p.x - origin.x) / gridSize, ry = (p.y - origin.y) / gridSize;
    lines.push([
      i + 1, p.name, rx.toFixed(1), ry.toFixed(1),
      `${Math.round(p.x)},${Math.round(p.y)}`, p.time || "",
      Math.min(4, p.roundsDone | 0),
      ptImuCount(p), ptScanCount(p),
      f1(ia && ia.yaw), f1(ia && ia.pitch), f1(ia && ia.roll),
      f2(ia && ia.mx), f2(ia && ia.my), f2(ia && ia.mz), b,
      ...apNames.map(n => { const a = wap.find(q => q.name === n); return a ? a.rssi : ""; }),
    ].map(csvEsc).join(","));
  });
  downloadCsv(lines, "map_summary_");
};

$("btnExportRaw").onclick = () => {   // 逐条: 服务器从 SQLite 导出(姿态+WiFi 两段 CSV)
  const aEl = document.createElement("a");
  aEl.href = "/api/db/export?kind=all&fmt=csv";
  aEl.download = "";
  document.body.appendChild(aEl);
  aEl.click();
  aEl.remove();
};
