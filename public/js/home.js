// 欢迎主页: 多地图管理/缩略图/导入导出/命名对话框
/* ================= 欢迎主页: 多地图管理与预览 ================= */
let curMap = null;                 // 当前打开的地图 {id, name}
let homeMaps = [];                 // 地图 meta 列表(最近打开优先)
let recentCache = [];              // 菜单"最近打开"的缓存
const previewCache = new Map();    // id → {data, w, h} 缩略预览数据

function dlAnchor(href) {
  const a = document.createElement("a");
  a.href = href; a.download = "";
  document.body.appendChild(a); a.click(); a.remove();
}

async function refreshHome() {
  const r = await api("/api/maps");
  if (!r || !r.ok) {
    $("cardGrid").innerHTML = "";
    $("homeEmpty").style.display = "";
    $("homeEmpty").textContent = "地图服务不可用, 请刷新重试";
    return;
  }
  homeMaps = Array.isArray(r.maps) ? r.maps : [];
  recentCache = homeMaps;
  renderHome();
}
function mapInfoLine(m) {
  const parts = [`${m.points | 0} 测点`, `${m.walls | 0} 墙`];
  if (m.doors || m.tables || m.routers)
    parts.push(`门${m.doors | 0}/桌${m.tables | 0}/AP${m.routers | 0}`);
  if (m.image) parts.push("含底图");
  parts.push(m.updated || m.created || "");
  return parts.join(" · ");
}
function renderHome() {
  const grid = $("cardGrid");
  $("homeMapCount").textContent = homeMaps.length ? `${homeMaps.length} 张` : "";
  $("homeEmpty").style.display = homeMaps.length ? "none" : "";
  grid.innerHTML = "";
  homeMaps.forEach((m, i) => {
    const card = document.createElement("div");
    card.className = "mapCard";
    card.style.setProperty("--i", i);
    card.innerHTML = `
      <div class="thumb"><div class="ph">加载预览…</div></div>
      <div class="cardBar">
        <div class="cardName" title="${escH(m.name)}">${escH(m.name)}${curMap && m.id === curMap.id ? " ◎" : ""}</div>
        <div class="cardInfo">${escH(mapInfoLine(m))}</div>
        <div class="cardBtns">
          <button class="cBtn openBtn">打开</button>
          <button class="cBtn expBtn" title="下载为 .svmap.json 到本地">导出</button>
          <button class="cBtn del delBtn">删除</button>
        </div>
      </div>`;
    card.onclick = () => openMap(m.id);
    card.querySelector(".openBtn").onclick = ev => { ev.stopPropagation(); openMap(m.id); };
    card.querySelector(".expBtn").onclick = ev => { ev.stopPropagation(); dlAnchor(`/api/maps/${m.id}/export`); };
    card.querySelector(".delBtn").onclick = ev => { ev.stopPropagation(); deleteMapById(m.id); };
    grid.appendChild(card);
    fillThumb(card.querySelector(".thumb"), m);
  });
}
async function fillThumb(box, m) {
  let entry = previewCache.get(m.id);
  if (!entry) {
    const r = await api(`/api/maps/${m.id}/data`);   // 预览不刷新"最近打开"
    if (!r || !r.ok) { if (box.isConnected) box.querySelector(".ph").textContent = "预览加载失败"; return; }
    entry = { data: r.data, w: 0, h: 0 };
    if (r.data.image) {   // 底图原始尺寸参与预览取景框
      await new Promise(res => {
        const im = new Image();
        im.onload = () => { entry.w = im.naturalWidth; entry.h = im.naturalHeight; res(); };
        im.onerror = res;
        im.src = r.data.image;
      });
    }
    previewCache.set(m.id, entry);
  }
  if (box.isConnected) renderThumb(box, m, entry);
}
function renderThumb(box, m, entry) {
  const d = entry.data;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  const ext = (x, y) => {
    if (!isFinite(x) || !isFinite(y)) return;
    x1 = Math.min(x1, x); y1 = Math.min(y1, y);
    x2 = Math.max(x2, x); y2 = Math.max(y2, y);
  };
  if (entry.w) { ext(0, 0); ext(entry.w, entry.h); }
  for (const w of d.walls || []) { ext(w.x1, w.y1); ext(w.x2, w.y2); }
  for (const t of d.tables || []) { ext(t.x1, t.y1); ext(t.x2, t.y2); }
  for (const c of d.chairs || []) { ext(c.x1, c.y1); ext(c.x2, c.y2); }
  for (const s of d.stairs || []) { ext(s.x1, s.y1); ext(s.x2, s.y2); }
  for (const l of d.lifts || []) { ext(l.x1, l.y1); ext(l.x2, l.y2); }
  for (const dr of d.doors || []) { ext(dr.x1, dr.y1); ext(dr.x2, dr.y2); }
  for (const rt of d.routers || []) ext(rt.x, rt.y);
  for (const p of d.points || []) ext(p.x, p.y);
  if (!isFinite(x1)) { x1 = 0; y1 = 0; x2 = 400; y2 = 300; }
  const pad = 30;
  x1 -= pad; y1 -= pad; x2 += pad; y2 += pad;
  const k = Math.max(x2 - x1, y2 - y1) / 300;    // 线宽/标记按取景框归一化
  const INK = "#2a323c", ACC = "#0047ab";
  let h = "";
  for (const t of d.tables || [])
    h += `<rect x="${Math.min(t.x1, t.x2)}" y="${Math.min(t.y1, t.y2)}"
      width="${Math.abs(t.x2 - t.x1)}" height="${Math.abs(t.y2 - t.y1)}"
      fill="#ffffff" stroke="${INK}" stroke-width="${k}"/>`;
  for (const c of d.chairs || []) {
    const cx0 = Math.min(c.x1, c.x2), cy0 = Math.min(c.y1, c.y2);
    const cw = Math.abs(c.x2 - c.x1), ch = Math.abs(c.y2 - c.y1);
    h += `<rect x="${cx0}" y="${cy0}" width="${cw}" height="${ch}" fill="#fff" stroke="${INK}" stroke-width="${k}"/>`
      + `<line x1="${cx0}" y1="${cy0}" x2="${cx0 + cw}" y2="${cy0}" stroke="${INK}" stroke-width="${k * 2}"/>`;
  }
  for (const s of d.stairs || []) {
    const sx = Math.min(s.x1, s.x2), sy = Math.min(s.y1, s.y2);
    const sw = Math.abs(s.x2 - s.x1), sh = Math.abs(s.y2 - s.y1);
    h += `<rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" fill="#ffffff" stroke="${INK}" stroke-width="${k}"/>`;
    const horiz = sw >= sh, n = 5;
    for (let j = 1; j < n; j++) h += horiz
      ? `<line x1="${sx + sw * j / n}" y1="${sy}" x2="${sx + sw * j / n}" y2="${sy + sh}" stroke="#9aa3ad" stroke-width="${k * 0.7}"/>`
      : `<line x1="${sx}" y1="${sy + sh * j / n}" x2="${sx + sw}" y2="${sy + sh * j / n}" stroke="#9aa3ad" stroke-width="${k * 0.7}"/>`;
  }
  for (const l of d.lifts || []) {
    const lx = Math.min(l.x1, l.x2), ly = Math.min(l.y1, l.y2);
    const lw = Math.abs(l.x2 - l.x1), lh = Math.abs(l.y2 - l.y1);
    h += `<rect x="${lx}" y="${ly}" width="${lw}" height="${lh}" fill="#ffffff" stroke="${INK}" stroke-width="${k}"/>`
      + `<line x1="${lx}" y1="${ly}" x2="${lx + lw}" y2="${ly + lh}" stroke="#9aa3ad" stroke-width="${k * 0.7}"/>`
      + `<line x1="${lx + lw}" y1="${ly}" x2="${lx}" y2="${ly + lh}" stroke="#9aa3ad" stroke-width="${k * 0.7}"/>`;
  }
  for (const w of d.walls || []) {
    let rx = Math.min(w.x1, w.x2), ry = Math.min(w.y1, w.y2);
    let rw = Math.abs(w.x2 - w.x1), rh = Math.abs(w.y2 - w.y1);
    const th = Math.max(d.wallThick || 10, k * 4);
    if (rw < th / 2) { rx -= th / 2; rw = th; }
    if (rh < th / 2) { ry -= th / 2; rh = th; }
    h += `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="#3c4653"/>`;
  }
  for (const dr of d.doors || [])
    h += `<line x1="${dr.x1}" y1="${dr.y1}" x2="${dr.x2}" y2="${dr.y2}"
      stroke="#9aa3ad" stroke-width="${k * 1.4}" stroke-dasharray="${k * 4} ${k * 3}"/>`;
  for (const rt of d.routers || [])
    h += `<rect x="${rt.x - k * 3}" y="${rt.y - k * 3}" width="${k * 6}" height="${k * 6}" fill="${INK}"/>`;
  for (const p of d.points || [])
    h += `<rect x="${p.x - k * 4.5}" y="${p.y - k * 4.5}" width="${k * 9}" height="${k * 9}"
      fill="${ACC}" stroke="#fff" stroke-width="${k * 1.2}"/>`;
  if (d.origin && typeof d.origin.x === "number")
    h += `<path d="M ${d.origin.x - k * 6} ${d.origin.y} H ${d.origin.x + k * 6}
      M ${d.origin.x} ${d.origin.y - k * 6} V ${d.origin.y + k * 6}" stroke="#b91c1c" stroke-width="${k}"/>`;
  box.innerHTML =
    (entry.w ? `<img class="bg" src="/api/maps/${m.id}/image" alt="">` : "") +
    `<svg viewBox="${x1} ${y1} ${x2 - x1} ${y2 - y1}" preserveAspectRatio="xMidYMid meet">${h}</svg>`;
}

/* ---- 地图: 打开/新建/导入/导出/复制/重命名/删除 ---- */
async function openMap(id) {
  const r = await api(`/api/maps/${id}/data?open=1`);
  if (!r || !r.ok) { alert("地图加载失败, 请重试"); return; }
  curMap = { id, name: r.name };
  applyMapData(r.data);
  $("mapName").textContent = r.name;
  document.title = `${r.name} · 传感器监控`;
  showView("map");
}
function homeNewMap() {
  openNameDlg("新建地图", "地图名称", "", async name => {
    const r = await apiPost("/api/maps", JSON.stringify({ name }), "application/json");
    if (r && r.ok) { previewCache.delete(r.id); openMap(r.id); }
    else alert("新建地图失败");
  });
}
$("btnHomeNew").onclick = homeNewMap;
$("importFile").addEventListener("change", async e => {
  const f = e.target.files[0];
  if (!f) return;
  if (f.size > 24 * 1024 * 1024) { alert("文件超过 24MB"); e.target.value = ""; return; }
  const buf = await f.arrayBuffer();
  const r = await apiPost("/api/maps/import", buf, "application/json");
  if (r && r.ok) { previewCache.delete(r.id); openMap(r.id); }
  else alert("导入失败: " + ((r && r.error) || "文件格式不正确"));
  e.target.value = "";
});
function exportCurMap() { if (curMap) dlAnchor(`/api/maps/${curMap.id}/export`); }
async function duplicateCurMap() {
  if (!curMap) return;
  const r = await apiPost(`/api/maps/${curMap.id}/meta`,
    JSON.stringify({ action: "duplicate" }), "application/json");
  if (r && r.ok) openMap(r.id);
  else alert("另存为副本失败");
}
function renameCurMap() {
  if (!curMap) return;
  openNameDlg("重命名地图", "地图名称", curMap.name, async name => {
    const r = await apiPost(`/api/maps/${curMap.id}/meta`,
      JSON.stringify({ action: "rename", name }), "application/json");
    if (r && r.ok) {
      curMap.name = name;
      $("mapName").textContent = name;
      document.title = `${name} · 传感器监控`;
      previewCache.delete(curMap.id);
      refreshHome();
    } else alert("重命名失败");
  });
}
async function deleteMapById(id) {
  const m = homeMaps.find(q => q.id === id);
  if (!confirm(`删除地图「${m ? m.name : id}」? 地图图形、测点及数据库中对应采样将一并删除, 不可恢复`)) return;
  const r = await apiPost(`/api/maps/${id}/meta`, JSON.stringify({ action: "delete" }), "application/json");
  if (r && r.ok) {
    previewCache.delete(id);
    if (curMap && curMap.id === id) {
      curMap = null;
      $("mapName").textContent = "未打开";
      document.title = "传感器实时监控 · 姿态 / 磁力计 / RSSI";
    }
    refreshDbCard();
    refreshHome();
  } else alert("删除失败");
}

/* ---- 名称/消息对话框 ---- */
let nameDlgCb = null;
function openNameDlg(title, label, value, cb) {
  $("nameDlgTitle").textContent = title;
  $("nameDlgLabel").textContent = label;
  const inp = $("nameDlgInput");
  inp.value = value || "";
  nameDlgCb = cb;
  $("nameOverlay").classList.add("show");
  setTimeout(() => { inp.focus(); inp.select(); }, 30);
}
function closeNameDlg() { $("nameOverlay").classList.remove("show"); nameDlgCb = null; }
$("nameDlgOk").onclick = () => {
  const v = $("nameDlgInput").value.trim().slice(0, 40);
  if (!v) { alert("名称不能为空"); return; }
  const cb = nameDlgCb;
  closeNameDlg();
  if (cb) cb(v);
};
$("nameDlgCancel").onclick = closeNameDlg;
$("nameDlgInput").addEventListener("keydown", e => {
  if (e.key === "Enter") $("nameDlgOk").click();
  if (e.key === "Escape") closeNameDlg();
});
function msgDlg(title, html) {
  $("msgDlgTitle").textContent = title;
  $("msgDlgBody").innerHTML = html;
  $("msgOverlay").classList.add("show");
}
$("msgDlgOk").onclick = () => $("msgOverlay").classList.remove("show");
[$("nameOverlay"), $("msgOverlay")].forEach(ov =>
  ov.addEventListener("click", ev => { if (ev.target === ov) ov.classList.remove("show"); }));
