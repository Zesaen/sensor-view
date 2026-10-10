// 绘图模板(服务器端存取)
/* ---- 绘图模板(墙/门/桌组合, 存服务器) ---- */
let templates = [];
async function loadTemplates() {
  const t = await api("/api/map/templates");
  templates = Array.isArray(t) ? t : [];
  renderTplSel();
}
function renderTplSel() {
  $("tplCount").textContent = templates.length + " 个";
  $("tplSel").innerHTML = templates.length
    ? templates.map((t, i) =>
        `<option value="${i}">${escH(t.name)}（墙${(t.walls || []).length}/门${(t.doors || []).length}/桌${(t.tables || []).length}/椅${(t.chairs || []).length}/梯${((t.stairs || []).length + (t.lifts || []).length)}/路由${(t.routers || []).length}）</option>`).join("")
    : '<option value="">暂无模板</option>';
}
$("btnTplSave").onclick = async () => {
  if (!walls.length && !doors.length && !tables.length && !chairs.length && !stairs.length && !lifts.length && !routers.length) { alert("当前没有墙/门/桌/座椅/楼梯/电梯可保存"); return; }
  const name = prompt("模板名称:", "布局1");
  if (!name || !name.trim()) return;
  const res = await apiPost("/api/map/templates", JSON.stringify({
    action: "save", name: name.trim().slice(0, 40), walls, doors, tables, chairs, stairs, lifts, routers,
  }), "application/json");
  if (res && res.ok) loadTemplates();
  else alert("模板保存失败");
};
$("btnTplApply").onclick = () => {
  const t = templates[+$("tplSel").value];
  if (!t) { alert("请先选择模板"); return; }
  if (!confirm(`用模板「${t.name}」替换当前全部墙/门/桌/楼梯/电梯?`)) return;
  walls = JSON.parse(JSON.stringify(t.walls || []));
  doors = JSON.parse(JSON.stringify(t.doors || []));
  tables = JSON.parse(JSON.stringify(t.tables || []));
  chairs = JSON.parse(JSON.stringify(t.chairs || []));
  stairs = JSON.parse(JSON.stringify(t.stairs || []));
  lifts = JSON.parse(JSON.stringify(t.lifts || []));
  routers = JSON.parse(JSON.stringify(t.routers || []));
  undoStack = [];
  selShape = null; updateShapeCtl();
  persist(); renderDrawings();
};
$("btnTplDel").onclick = async () => {
  const t = templates[+$("tplSel").value];
  if (!t) { alert("请先选择模板"); return; }
  if (!confirm(`删除模板「${t.name}」?`)) return;
  const res = await apiPost("/api/map/templates",
    JSON.stringify({ action: "del", name: t.name }), "application/json");
  if (res && res.ok) loadTemplates();
};
