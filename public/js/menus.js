// 工业软件式多级主菜单 + 帮助/关于
/* ================= 工业软件式多级主菜单 ================= */
let menuOpenIdx = -1;
function recentMenuItems() {
  const list = (recentCache.length ? recentCache : homeMaps).slice(0, 8);
  if (!list.length) return [{ t: "（暂无地图, 先新建或导入）", off: true }];
  return list.map(m => ({ t: m.name + (curMap && m.id === curMap.id ? "  ✓" : ""),
                          act: () => openMap(m.id) }));
}
const MENUS = [
  { t: "文件(F)", items: () => [
    { t: "新建地图…", act: homeNewMap },
    { t: "打开地图…", k: "Ctrl+O", act: goHome },
    { t: "最近打开", sub: recentMenuItems },
    "-",
    { t: "导入地图…", act: () => $("importFile").click() },
    { t: "导出地图到本地…", k: "Ctrl+S", needMap: 1, act: exportCurMap },
    { t: "另存为副本", needMap: 1, act: duplicateCurMap },
    "-",
    { t: "重命名地图…", needMap: 1, act: renameCurMap },
    { t: "删除地图", needMap: 1, act: () => curMap && deleteMapById(curMap.id) },
  ]},
  { t: "编辑(E)", items: () => [
    { t: "撤销上一笔", k: "Ctrl+Z", needMap: 1, act: () => $("btnUndoDraw").onclick() },
    { t: "撤销上一点", needMap: 1, act: undoLastPoint },
    "-",
    { t: "删除选中图形", needMap: 1, act: () => { if (selShape) $("btnShapeDel").click(); } },
    { t: "清空全部图形", needMap: 1, act: clearAllDrawings },
    { t: "清除全部坐标点", needMap: 1, act: clearAllPoints },
    "-",
    { t: "管理采集数据库…", act: () => dbOpen("") },
  ]},
  { t: "视图(V)", items: () => [
    { t: "实时监控", on: curView === "live", act: () => showView("live") },
    { t: "地图编辑", on: curView === "map", act: enterMapView },
    "-",
    { t: "三维视角", on: view3d, needMap: 1, act: () => set3dView(!view3d) },
    { t: "楼层", needMap: 1, sub: [
      { t: "上方新建一层(复制当前布局)", needMap: 1, act: () => addFloor(1) },
      { t: "下方新建一层(复制当前布局)", needMap: 1, act: () => addFloor(-1) },
      "-",
      { t: "删除当前层", needMap: 1, act: () => delFloor(curFloorId) },
    ]},
    { t: "重置视图(缩放/平移)", needMap: 1, act: () => fitView() },
    { t: "显示", sub: [
      { t: "背景栅格", chk: "gridOnIn" },
      { t: "细网格线", chk: "gridMinorIn" },
      { t: "网格吸附", chk: "snapOn" },
    ]},
  ]},
  { t: "绘图(D)", items: () => [
    { t: "添加坐标点", tool: "add", needMap: 1, act: () => $("btnAddPoint").click() },
    { t: "阵列放点", tool: "array", needMap: 1, act: () => $("btnArray").click() },
    "-",
    { t: "绘制墙体", tool: "wall", needMap: 1, act: () => $("btnWall").click() },
    { t: "放置门", tool: "door", needMap: 1, act: () => $("btnDoor").click() },
    { t: "放置桌", tool: "table", needMap: 1, act: () => $("btnTable").click() },
    { t: "放置座椅", tool: "chair", needMap: 1, act: () => $("btnChair").click() },
    { t: "放置楼梯", tool: "stair", needMap: 1, act: () => $("btnStair").click() },
    { t: "放置电梯", tool: "lift", needMap: 1, act: () => $("btnLift").click() },
    { t: "放置路由器", tool: "router", needMap: 1, act: () => $("btnRouter").click() },
    "-",
    { t: "设置(0,0)原点", tool: "origin", needMap: 1, act: () => $("btnOrigin").click() },
    "-",
    { t: "模板", needMap: 1, sub: tplMenuItems },
    { t: "存当前为模板…", needMap: 1, act: tplSave },
    "-",
    { t: "上传地图图片…", needMap: 1, act: () => $("mapFile").click() },
    { t: "恢复网格底图", needMap: 1, off: !mapHasImage, act: () => restoreGridBg() },
  ]},
  { t: "数据(A)", items: () => [
    { t: "开始采集", act: () => $("btnStart").click() },
    { t: "停止采集", act: () => $("btnStop").click() },
    "-",
    { t: "管理采集数据库…", act: () => dbOpen("") },
    { t: "导出", sub: [
      { t: "汇总 CSV (每测点一行)", needMap: 1, act: () => $("btnExportCsv").click() },
      { t: "逐条 CSV (全部采样)", needMap: 1, act: () => $("btnExportRaw").click() },
      { t: "数据库全部 CSV", act: () => $("btnDbExportAll").click() },
    ]},
    { t: "清空数据库…", act: () => $("btnDbClear").click() },
  ]},
  { t: "帮助(H)", items: () => [
    { t: "操作说明", act: showHelpDlg },
    "-",
    { t: "关于 sensor-view", act: showAboutDlg },
  ]},
];
function buildMenuItem(it) {
  if (it === "-") { const s = document.createElement("div"); s.className = "ddSep"; return s; }
  const el = document.createElement("div");
  el.className = "ddItem";
  const disabled = it.off || (it.needMap && !curMap);
  if (disabled) el.classList.add("off");
  const chk = document.createElement("span");
  chk.className = "mchk";
  if (it.chk) chk.textContent = $(it.chk).checked ? "✓" : "";
  else if (it.tool) chk.textContent = tool === it.tool ? "●" : "";
  else if (it.on) chk.textContent = "●";
  const lbl = document.createElement("span");
  lbl.className = "mlbl";
  lbl.textContent = it.t;
  if (disabled) lbl.title = "请先打开地图";
  el.append(chk, lbl);
  if (it.k) { const a = document.createElement("span"); a.className = "macc"; a.textContent = it.k; el.appendChild(a); }
  if (it.sub) {
    let items = typeof it.sub === "function" ? it.sub() : it.sub;
    const sub = document.createElement("div");
    sub.className = "sub";
    for (const s of items) sub.appendChild(buildMenuItem(s));
    const arr = document.createElement("span");
    arr.className = "marr"; arr.textContent = "▸";
    el.append(arr, sub);
  }
  if (!disabled) el.addEventListener("click", ev => {
    ev.stopPropagation();
    closeMenus();
    if (it.chk) {           // 勾选型菜单项: 翻转对应输入并触发既有 change 逻辑
      const c = $(it.chk);
      c.checked = !c.checked;
      c.dispatchEvent(new Event("change"));
      return;
    }
    if (it.act) it.act();
  });
  return el;
}
function openMenuIdx(i) {
  closeMenus();
  const wrap = $("mbar").children[i];
  const dd = wrap.querySelector(".dd");
  dd.innerHTML = "";
  for (const it of MENUS[i].items()) dd.appendChild(buildMenuItem(it));
  wrap.classList.add("open");
  menuOpenIdx = i;
  if (i === 0)                     // 打开"文件"时静默刷新最近列表
    api("/api/maps").then(r => { if (r && r.ok) recentCache = r.maps || []; });
}
function closeMenus() {
  document.querySelectorAll("#mbar .mtop.open").forEach(w => w.classList.remove("open"));
  menuOpenIdx = -1;
}
let lastHoverSwitch = 0;          // hover 刚把菜单切到本项时, 随后的 click 不再 toggle(避免开→关)
(function buildMenuBar() {
  MENUS.forEach((m, i) => {
    const wrap = document.createElement("div");
    wrap.className = "mtop";
    const btn = document.createElement("button");
    btn.textContent = m.t;
    btn.addEventListener("click", ev => {
      ev.stopPropagation();
      if (menuOpenIdx === i && performance.now() - lastHoverSwitch < 350) return;
      menuOpenIdx === i ? closeMenus() : openMenuIdx(i);
    });
    btn.addEventListener("mouseenter", () => {
      if (menuOpenIdx >= 0 && menuOpenIdx !== i) {
        openMenuIdx(i);
        lastHoverSwitch = performance.now();
      }
    });
    const dd = document.createElement("div");
    dd.className = "dd";
    wrap.append(btn, dd);
    $("mbar").appendChild(wrap);
  });
})();
document.addEventListener("click", ev => {
  if (!(ev.target instanceof Element) || !ev.target.closest("#mbar")) closeMenus();
});

function showHelpDlg() {
  msgDlg("操作说明", `
    <p><b>主页</b>: 新建 / 导入 / 打开地图; 点击最近地图卡片进入编辑。</p>
    <p><b>地图编辑</b>: 左键/中键拖动平移, 滚轮缩放; 墙/桌/座椅/楼梯/电梯对角拖拽, 门拖方向线, 圆点/路由器/(0,0)点击放置; 座椅选中后可「旋转朝向」, 楼梯选中后可「调转上楼方向」, 路由器(AP)选中后可设「安装高度」(悬挂式); 阵列放点: 点起点→点终点按个数均布; 点击图形选中编辑, 点击测点查看数据。</p>
    <p><b>三维视角</b>: 菜单「视图 → 三维视角」进入; 右上角「返回二维编辑」或 Esc 退出; 左键拖动旋转, 右键/双指平移, 滚轮缩放。墙体/桌/座椅/楼梯/电梯/门/路由器/测点按真实比例(1 格 = 1 米)立体呈现, 楼梯沿上行方向逐级升高一整层, 电梯为井道框架, AP 按设定高度悬挂。</p>
    <p><b>多楼层</b>: 地图画布上方楼层条 — 「＋上层 / ＋下层」以当前层布局为模板新建上/下楼(测点不复制), 点击层标签(1F/B1/2F…)切换编辑层, × 删除该层。楼梯在 3D 中总升高一整层(3 m), 逐层对齐即可贯通上下楼; 三维视角里整栋楼按层堆叠, 当前编辑层实体高亮, 其余层半透明。</p>
    <p><b>采集</b>: 选中测点后按「采集」, 每按一次采一个朝向, 按 0°→90°→180°→270° 共 4 次; 样本实时写入服务器 SQLite。</p>
    <p><b>菜单</b>: 顶部为工业软件式多级菜单(文件/编辑/视图/绘图/数据/帮助); Esc 关闭菜单或取消阵列起点; Ctrl+O 回主页, Ctrl+S 导出当前地图到本地。</p>`);
}
function showAboutDlg() {
  msgDlg("关于", `
    <p><b>sensor-view</b> · 传感器实时监控与地图采集系统</p>
    <p>IMU 姿态/磁力计 · WiFi RSSI 实时流(SSE) · 多地图管理与本地导入导出(.svmap.json) · SQLite 采样数据库。</p>`);
}
