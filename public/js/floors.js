// 楼层条 / 切层 / 增删层
/* ---- 楼层操作 ---- */
function renderFloorBar() {
  const bar = $("floorChips");
  bar.innerHTML = floors.map(f => {
    const on = f.id === curFloorId;
    return `<span class="fChip${on ? " on" : ""}" data-id="${f.id}"
      title="切换到 ${escH(f.name)} (level ${f.level}) 编辑">${escH(f.name)}${floors.length > 1 ? `<i class="fx" data-id="${f.id}" title="删除该层(含其测点采样)">×</i>` : ""}</span>`;
  }).join("");
  bar.querySelectorAll(".fChip").forEach(el => {
    el.onclick = ev => {
      const fx = ev.target.closest(".fx");
      if (fx) { delFloor(fx.dataset.id); return; }
      if (el.dataset.id !== curFloorId) switchFloor(el.dataset.id);
    };
  });
}
function switchFloor(id) {
  const f = floorById(id);
  if (!f || id === curFloorId) return;
  syncFloorRefs();                      // 先把当前层活动数组归宿到楼层对象
  loadFloorIntoEditor(f);
  for (const p of mapPoints) { p.collecting = false; p.burst = null; p.roundsDone = Math.min(4, p.roundsDone | 0); }
  collectingN = 0;
  updateShapeCtl();
  persist(); renderFloorBar(); renderDrawings(); renderMarkers(); renderPtList(); renderDetail();
}
function addFloor(dir) {                // dir=+1 在上方新建, -1 在下方新建; 复制当前层布局作起点(测点不复制)
  const cur = curFloor();
  if (!cur) return;
  const lv = cur.level + dir;
  const exist = floors.find(f => f.level === lv);
  if (exist) { switchFloor(exist.id); return; }   // 已有该层 → 直接跳过去
  syncFloorRefs();
  const f = {
    id: "fl" + Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36),
    level: lv, name: floorName(lv), points: [],
    walls: JSON.parse(JSON.stringify(cur.walls || [])),
    doors: JSON.parse(JSON.stringify(cur.doors || [])),
    tables: JSON.parse(JSON.stringify(cur.tables || [])),
    stairs: JSON.parse(JSON.stringify(cur.stairs || [])),
    lifts: JSON.parse(JSON.stringify(cur.lifts || [])),
    routers: JSON.parse(JSON.stringify(cur.routers || [])),
    chairs: JSON.parse(JSON.stringify(cur.chairs || [])),
  };
  floors.push(f);
  floors.sort((a, b) => a.level - b.level);
  loadFloorIntoEditor(f);
  m3d.fittedFor = null;                 // 楼层数变了, 3D 重新取景
  persist(); renderFloorBar(); renderDrawings(); renderMarkers(); renderPtList(); renderDetail();
  msgDlg("楼层", `已新建 ${f.name}(以 ${cur.name} 布局为模板), 当前正在编辑 ${f.name}。<br>楼梯在本层沿上行方向升高一整层, 三维视角中可看到各层堆叠。`);
}
function delFloor(id) {
  if (floors.length <= 1) { alert("至少保留一层"); return; }
  const f = floorById(id);
  if (!f) return;
  const nPts = (f.points || []).length;
  if (!confirm(`删除楼层 ${f.name}?${nPts ? ` 其 ${nPts} 个测点及数据库采样将一并删除` : ""}`)) return;
  if (nPts) apiPost("/api/db/delete",
    JSON.stringify({ point_ids: f.points.map(p => p.id) }), "application/json").then(() => refreshDbCard());
  const idx = floors.indexOf(f);
  floors.splice(idx, 1);
  if (id === curFloorId) loadFloorIntoEditor(floors[Math.min(idx, floors.length - 1)]);
  m3d.fittedFor = null;
  persist(); renderFloorBar(); renderDrawings(); renderMarkers(); renderPtList(); renderDetail();
}
$("btnFloorUp").onclick = () => addFloor(1);
$("btnFloorDown").onclick = () => addFloor(-1);
