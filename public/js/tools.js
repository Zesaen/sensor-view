// 工具模式 + 全局键盘(含漫游按键/Esc①, 必须先于 map3d/walk 加载)
/* ---- 工具模式 ---- */
const TOOL_LABEL = { pan: "平移", add: "添加坐标点", wall: "绘制墙体",
                     door: "放置门", table: "放置桌", chair: "放置座椅",
                     stair: "放置楼梯", lift: "放置电梯", router: "放置路由器",
                     origin: "设置(0,0)点", array: "阵列放点" };
const arrCount = () => Math.min(200, Math.max(2, +$("arrNIn").value | 0));
function setTool(t) {
  tool = tool === t ? "pan" : t;
  shapeDraft = null;
  // 阵列模式: 已选中测点则直接以它为起点, 否则等第一次点击
  const sp = pointById(selPointId);
  arrayAnchor = tool === "array" && sp ? { x: sp.x, y: sp.y } : null;
  renderArrayPreview();
  $("wallPreview").style.display = "none";
  $("rectPreview").style.display = "none";
  for (const [b, n] of [["btnAddPoint", "add"], ["btnWall", "wall"], ["btnDoor", "door"],
                        ["btnTable", "table"], ["btnChair", "chair"],
                        ["btnStair", "stair"], ["btnLift", "lift"],
                        ["btnRouter", "router"], ["btnOrigin", "origin"],
                        ["btnArray", "array"]])
    $(b).classList.toggle("activeTool", tool === n);
  const ts = $("toolState");
  ts.textContent = TOOL_LABEL[tool];
  ts.classList.toggle("on", tool !== "pan");
  $("mapStage").classList.toggle("adding", tool !== "pan");
  $("mapStage").classList.toggle("modeArray", tool === "array");
}
$("btnAddPoint").onclick = () => setTool("add");
$("btnArray").onclick = () => setTool("array");
$("arrNIn").onchange = e => { e.target.value = arrCount(); renderArrayPreview(); };
window.addEventListener("keydown", e => {
  if (walk.active) {                     // 漫游模式: 只认移动键/Esc, 屏蔽其余快捷键
    const k = e.key.toLowerCase();
    if (k === "escape") { e.stopImmediatePropagation(); walkExit(); return; }   // 防止穿透到三维退出
    if (["w", "arrowup"].includes(k)) { walk.keys.w = true; e.preventDefault(); }
    else if (["s", "arrowdown"].includes(k)) { walk.keys.s = true; e.preventDefault(); }
    else if (["a", "arrowleft"].includes(k)) { walk.keys.a = true; e.preventDefault(); }
    else if (["d", "arrowright"].includes(k)) { walk.keys.d = true; e.preventDefault(); }
    else if (e.key === "Shift") walk.keys.shift = true;
    return;
  }
  const tag = (e.target.tagName || "").toLowerCase();
  const typing = tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable;
  if (e.key === "Escape") {          // 关菜单 / 对话框; 取消阵列起点 / 退出绘制工具
    closeMenus();
    if (arrayAnchor) { arrayAnchor = null; renderArrayPreview(); }
    if (!typing && tool !== "pan" && !view3d) setTool("pan");
  }
  if (!typing && (e.key === "Delete" || e.key === "Backspace") && selShape) {
    e.preventDefault();              // 删除选中的图形(输入框内不拦截)
    $("btnShapeDel").onclick();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
    const k = e.key.toLowerCase();
    if (k === "o") { e.preventDefault(); goHome(); }
    else if (k === "s") { e.preventDefault(); if (curMap) exportCurMap(); }
    else if (k === "z" && !typing) { e.preventDefault(); $("btnUndoDraw").onclick(); }
  }
});
window.addEventListener("keyup", e => {  // 漫游松键
  if (!walk.active) return;
  const k = e.key.toLowerCase();
  if (["w", "arrowup"].includes(k)) walk.keys.w = false;
  else if (["s", "arrowdown"].includes(k)) walk.keys.s = false;
  else if (["a", "arrowleft"].includes(k)) walk.keys.a = false;
  else if (["d", "arrowright"].includes(k)) walk.keys.d = false;
  else if (e.key === "Shift") walk.keys.shift = false;
});
window.addEventListener("blur", () => { if (walk.active) { walk.keys = {}; } });  // 失焦清键, 防粘键
$("btnWall").onclick = () => setTool("wall");
$("btnDoor").onclick = () => setTool("door");
$("btnTable").onclick = () => setTool("table");
$("btnChair").onclick = () => setTool("chair");
$("btnStair").onclick = () => setTool("stair");
$("btnLift").onclick = () => setTool("lift");
$("btnRouter").onclick = () => setTool("router");
$("btnOrigin").onclick = () => setTool("origin");
$("btnResetView").onclick = fitView;
$("btnUndoDraw").onclick = () => {
  const last = undoStack.pop();
  if (!last) return;
  if (last.kind === "move") {   // 撤销移动: 恢复到移动前坐标
    Object.assign(last.obj, last.prev);
    toast("已撤销移动");
    persist(); renderDrawings();
    return;
  }
  if (last.kind === "point") {   // 撤销上一次放点(单个或阵列整批)
    const objs = last.obj.filter(q => mapPoints.includes(q));
    if (objs.length) {
      for (const q of objs) if (q.collecting) collectingN--;
      mapPoints = mapPoints.filter(q => !objs.includes(q));
      if (selPointId && objs.some(q => q.id === selPointId)) { selPointId = null; renderDetail(); }
      persist(); renderMarkers(); renderPtList();
    }
    return;
  }
  const arr = shapeArr(last.kind);
  const i = arr.indexOf(last.obj);
  if (i >= 0) arr.splice(i, 1);
  if (selShape && selShape.obj === last.obj) selShape = null;
  updateShapeCtl();
  persist(); renderDrawings();
  toast("已撤销" + (SHAPE_LABEL[last.kind] || ""));
};
$("btnUndoPt").onclick = () => {
  const p = mapPoints[mapPoints.length - 1];
  if (p) delPoint(p.id);   // 复用单点删除: 有已采数据时先确认
};
$("btnClearDraw").onclick = () => {
  if (!walls.length && !doors.length && !tables.length && !chairs.length && !stairs.length && !lifts.length && !routers.length) return;
  if (!confirm("清空全部墙体 / 门 / 桌 / 座椅 / 楼梯 / 电梯 / 路由器?")) return;
  walls = []; doors = []; tables = []; chairs = []; stairs = []; lifts = []; routers = []; undoStack = [];
  selShape = null; updateShapeCtl();
  persist(); renderDrawings();
};
$("btnClearPts").onclick = () => {
  if (!mapPoints.length) return;
  if (!confirm(`确定清除全部 ${mapPoints.length} 个坐标点? 不可恢复, 数据库中对应的采样数据将一并删除`)) return;
  const ids = mapPoints.map(p => p.id);
  mapPoints = []; selPointId = null; collectingN = 0;
  apiPost("/api/db/delete", JSON.stringify({ point_ids: ids }), "application/json")
    .then(() => refreshDbCard());
  persist(); renderMarkers(); renderPtList(); renderDetail();
};
