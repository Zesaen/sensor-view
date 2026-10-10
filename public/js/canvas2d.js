// 2D 画布交互: 命中/拖拽/绘制/阵列/选中控件
/* ---- 鼠标: 滚轮缩放 / 左键拖动 / 放点 / 画墙 / 定原点 ---- */
const stageEl = $("mapStage");
function evtWorld(e) {
  const r = stageEl.getBoundingClientRect();
  return screenToWorld(e.clientX - r.left, e.clientY - r.top);
}
stageEl.addEventListener("wheel", e => {
  e.preventDefault();
  const r = stageEl.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const f = e.deltaY < 0 ? 1.18 : 1 / 1.18;
  const ns = Math.min(25, Math.max(0.15, view.s * f));
  view.tx = mx - (mx - view.tx) * (ns / view.s);
  view.ty = my - (my - view.ty) * (ns / view.s);
  view.s = ns;
  applyView();
}, { passive: false });

/* ---- 交互辅助: 操作反馈气泡 / 图形命中测试 ---- */
const SHAPE_LABEL = { wall: "墙体", door: "门", table: "桌", chair: "座椅",
                      stair: "楼梯", lift: "电梯", router: "路由器" };
let toastTimer = null;
function toast(msg) {          // 画布底部轻量反馈, 不打断操作
  const t = $("stageToast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1500);
}
function hitShapeAt(sxp, syp) {   // 屏幕坐标命中图形: 路由器小目标优先, 其次门、矩形件、墙
  let hitKind = null, hitObj = null, best = 9;
  for (let i = routers.length - 1; i >= 0; i--) {
    const rt = routers[i];
    const [cx, cy] = worldToScreen(rt.x, rt.y);
    if (Math.abs(sxp - cx) <= 24 && Math.abs(syp - cy) <= 24) { hitKind = "router"; hitObj = rt; break; }
  }
  if (!hitKind) doors.forEach(d => {
    const [ax, ay] = worldToScreen(d.x1, d.y1), [bx, by] = worldToScreen(d.x2, d.y2);
    const dist = distToSeg(sxp, syp, ax, ay, bx, by);
    if (dist < best) { best = dist; hitKind = "door"; hitObj = d; }
  });
  if (!hitKind) {
    const rectHit = (arr, kind) => {
      for (let i = arr.length - 1; i >= 0; i--) {
        const t = arr[i];
        const [x1, y1] = worldToScreen(Math.min(t.x1, t.x2), Math.min(t.y1, t.y2));
        const [x2, y2] = worldToScreen(Math.max(t.x1, t.x2), Math.max(t.y1, t.y2));
        if (sxp >= x1 - 3 && sxp <= x2 + 3 && syp >= y1 - 3 && syp <= y2 + 3) { hitKind = kind; hitObj = t; break; }
      }
    };
    rectHit(tables, "table");
    if (!hitKind) rectHit(chairs, "chair");
    if (!hitKind) rectHit(stairs, "stair");
    if (!hitKind) rectHit(lifts, "lift");
  }
  if (!hitKind) {
    for (let i = walls.length - 1; i >= 0; i--) {
      const rc = wallRect(walls[i]);
      const [x1, y1] = worldToScreen(rc.x, rc.y);
      const [x2, y2] = worldToScreen(rc.x + rc.w, rc.y + rc.h);
      if (sxp >= x1 - 2 && sxp <= x2 + 2 && syp >= y1 - 2 && syp <= y2 + 2) { hitKind = "wall"; hitObj = walls[i]; break; }
    }
  }
  return hitKind ? { kind: hitKind, obj: hitObj } : null;
}

stageEl.addEventListener("pointerdown", e => {
  if (e.target.closest(".mk")) return;
  if (e.button === 1) {   // 中键: 放置/绘制模式下也可平移画面
    e.preventDefault();   // 顺带屏蔽中键自动滚动等默认行为
    panState = { px: e.clientX, py: e.clientY, tx: view.tx, ty: view.ty };
    stageEl.setPointerCapture(e.pointerId);
    return;
  }
  if (e.button !== 0) return;
  const [wx, wy] = evtWorld(e);
  if (tool === "wall" || tool === "door" || tool === "table" || tool === "chair" || tool === "stair" || tool === "lift") {
    shapeDraft = { kind: tool, x1: snapV(wx), y1: snapV(wy), x2: snapV(wx), y2: snapV(wy) };
    if (tool === "door") {   // 门: 拖出门洞方向线
      const pv = $("wallPreview");
      pv.setAttribute("x1", shapeDraft.x1); pv.setAttribute("y1", shapeDraft.y1);
      pv.setAttribute("x2", shapeDraft.x2); pv.setAttribute("y2", shapeDraft.y2);
      pv.style.display = "";
    } else {                  // 墙/桌: 拖出矩形块
      const rc = $("rectPreview");
      rc.setAttribute("x", shapeDraft.x1); rc.setAttribute("y", shapeDraft.y1);
      rc.setAttribute("width", 0); rc.setAttribute("height", 0);
      rc.style.display = "";
    }
    stageEl.setPointerCapture(e.pointerId);
    return;
  }
  if (tool !== "pan") return;            // add / router / origin 在 click 中处理
  // 平移模式: 按在图形上 → 拖拽移动该图形; 按在空白处 → 平移画面
  {
    const r0 = stageEl.getBoundingClientRect();
    const hit = hitShapeAt(e.clientX - r0.left, e.clientY - r0.top);
    if (hit) {
      const [wx0, wy0] = evtWorld(e);
      const o = hit.obj;
      dragShape = { kind: hit.kind, obj: o, sx: wx0, sy: wy0, px: e.clientX, py: e.clientY,
                    moved: false, orig: o.x1 !== undefined
                      ? { x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2 } : { x: o.x, y: o.y } };
      selShape = { kind: hit.kind, obj: o };   // 按下即选中, 拖动中实时高亮
      selPointId = null;
      updateShapeCtl(); renderDrawings(); renderMarkers(); renderPtList(); renderDetail();
      stageEl.setPointerCapture(e.pointerId);
      return;
    }
  }
  panState = { px: e.clientX, py: e.clientY, tx: view.tx, ty: view.ty };
  stageEl.style.cursor = "grabbing";
  stageEl.setPointerCapture(e.pointerId);
});
stageEl.addEventListener("auxclick", e => { if (e.button === 1) e.preventDefault(); });   // 屏蔽中键粘贴/自动滚动
stageEl.addEventListener("contextmenu", e => {   // 右键: 取消阵列起点
  e.preventDefault();
  if (arrayAnchor) { arrayAnchor = null; renderArrayPreview(); }
});
stageEl.addEventListener("pointermove", e => {
  const [mwx, mwy] = evtWorld(e);
  lastMouse = { x: mwx, y: mwy };
  if (tool === "array") renderArrayPreview();
  if (panState) {
    view.tx = panState.tx + (e.clientX - panState.px);
    view.ty = panState.ty + (e.clientY - panState.py);
    applyView();
  } else if (dragShape) {               // 拖拽移动图形: 位移吸附网格, 原尺寸保持不变
    if (!dragShape.moved && Math.hypot(e.clientX - dragShape.px, e.clientY - dragShape.py) >= 4)
      dragShape.moved = true;           // 4px 内视为点击(选中), 不抖动
    if (dragShape.moved) {
      const dx = snapV(mwx - dragShape.sx), dy = snapV(mwy - dragShape.sy);
      const o = dragShape.obj, g = dragShape.orig;
      if (dragShape.kind === "router") { o.x = g.x + dx; o.y = g.y + dy; }
      else { o.x1 = g.x1 + dx; o.y1 = g.y1 + dy; o.x2 = g.x2 + dx; o.y2 = g.y2 + dy; }
      renderDrawings();
    }
  } else if (shapeDraft) {
    const [wx, wy] = evtWorld(e);
    shapeDraft.x2 = snapV(wx); shapeDraft.y2 = snapV(wy);
    if (shapeDraft.kind === "door") {
      const pv = $("wallPreview");
      pv.setAttribute("x2", shapeDraft.x2); pv.setAttribute("y2", shapeDraft.y2);
    } else {
      const rc = $("rectPreview");
      rc.setAttribute("x", Math.min(shapeDraft.x1, shapeDraft.x2));
      rc.setAttribute("y", Math.min(shapeDraft.y1, shapeDraft.y2));
      rc.setAttribute("width", Math.abs(shapeDraft.x2 - shapeDraft.x1));
      rc.setAttribute("height", Math.abs(shapeDraft.y2 - shapeDraft.y1));
    }
    const tip = $("draftTip");          // 拖拽尺寸实时提示(米)
    tip.textContent = shapeDraft.kind === "door"
      ? (Math.hypot(shapeDraft.x2 - shapeDraft.x1, shapeDraft.y2 - shapeDraft.y1) / pxPerM).toFixed(2) + " m"
      : (Math.abs(shapeDraft.x2 - shapeDraft.x1) / pxPerM).toFixed(1) + " × " +
        (Math.abs(shapeDraft.y2 - shapeDraft.y1) / pxPerM).toFixed(1) + " m";
    const rr = stageEl.getBoundingClientRect();
    tip.style.left = Math.min(e.clientX - rr.left + 16, rr.width - 70) + "px";
    tip.style.top = (e.clientY - rr.top + 20) + "px";
    tip.style.display = "block";
  } else {                              // 悬停: 平移模式下落在图形上提示可拖动
    const rr2 = stageEl.getBoundingClientRect();
    stageEl.style.cursor = tool === "pan"
      ? (hitShapeAt(e.clientX - rr2.left, e.clientY - rr2.top) ? "move" : "grab") : "";
  }
});
stageEl.addEventListener("pointerup", () => {
  if (panState) { panState = null; stageEl.style.cursor = ""; return; }
  if (dragShape) {
    const d = dragShape;
    dragShape = null;
    stageEl.style.cursor = "";
    if (d.moved) {          // 拖拽移动收尾: 记撤销 + 保存; 尾随 click 吞掉, 保持选中态
      drawnGesture = true;
      undoStack.push({ kind: "move", shapeKind: d.kind, obj: d.obj, prev: d.orig });
      toast("已移动" + SHAPE_LABEL[d.kind]);
      persist(); renderDrawings();
    }                       // 未移动(≤4px) → 视为点击, 交给后续 click 事件完成选中
    return;
  }
  if (shapeDraft) {
    const s = shapeDraft;
    shapeDraft = null;
    $("wallPreview").style.display = "none";
    $("rectPreview").style.display = "none";
    $("draftTip").style.display = "none";
    let committed = false;
    if (s.kind === "wall") {
      // 拖出实体墙块: 对角定矩形, 短边不足设定墙厚时自动补到墙厚
      if (Math.hypot(s.x2 - s.x1, s.y2 - s.y1) * view.s >= 4) {
        let x1 = Math.min(s.x1, s.x2), x2 = Math.max(s.x1, s.x2);
        let y1 = Math.min(s.y1, s.y2), y2 = Math.max(s.y1, s.y2);
        if (x2 - x1 < wallThick) { const c = (x1 + x2) / 2; x1 = c - wallThick / 2; x2 = c + wallThick / 2; }
        if (y2 - y1 < wallThick) { const c = (y1 + y2) / 2; y1 = c - wallThick / 2; y2 = c + wallThick / 2; }
        const obj = { x1, y1, x2, y2 };
        walls.push(obj); undoStack.push({ kind: "wall", obj });
        selShape = { kind: "wall", obj };
        persist(); renderDrawings(); updateShapeCtl();
        committed = true;
      }
    } else if (s.kind === "table") {
      if (Math.abs(s.x2 - s.x1) * view.s >= 4 && Math.abs(s.y2 - s.y1) * view.s >= 4) {
        const obj = { x1: Math.min(s.x1, s.x2), y1: Math.min(s.y1, s.y2),
                      x2: Math.max(s.x1, s.x2), y2: Math.max(s.y1, s.y2) };
        tables.push(obj); undoStack.push({ kind: "table", obj });
        selShape = { kind: "table", obj };
        persist(); renderDrawings(); updateShapeCtl();
        committed = true;
      }
    } else if (s.kind === "chair") {
      if (Math.abs(s.x2 - s.x1) * view.s >= 3 && Math.abs(s.y2 - s.y1) * view.s >= 3) {
        const obj = { x1: Math.min(s.x1, s.x2), y1: Math.min(s.y1, s.y2),
                      x2: Math.max(s.x1, s.x2), y2: Math.max(s.y1, s.y2), dir: 0 };
        chairs.push(obj); undoStack.push({ kind: "chair", obj });
        selShape = { kind: "chair", obj };   // 选中便于马上调朝向
        persist(); renderDrawings(); updateShapeCtl();
        committed = true;
      }
    } else if (s.kind === "stair") {
      if (Math.abs(s.x2 - s.x1) * view.s >= 4 && Math.abs(s.y2 - s.y1) * view.s >= 4) {
        const obj = { x1: Math.min(s.x1, s.x2), y1: Math.min(s.y1, s.y2),
                      x2: Math.max(s.x1, s.x2), y2: Math.max(s.y1, s.y2), dir: 0 };
        stairs.push(obj); undoStack.push({ kind: "stair", obj });
        selShape = { kind: "stair", obj };   // 选中便于马上调上行方向
        persist(); renderDrawings(); updateShapeCtl();
        committed = true;
      }
    } else if (s.kind === "lift") {
      if (Math.abs(s.x2 - s.x1) * view.s >= 4 && Math.abs(s.y2 - s.y1) * view.s >= 4) {
        const obj = { x1: Math.min(s.x1, s.x2), y1: Math.min(s.y1, s.y2),
                      x2: Math.max(s.x1, s.x2), y2: Math.max(s.y1, s.y2) };
        lifts.push(obj); undoStack.push({ kind: "lift", obj });
        selShape = { kind: "lift", obj };
        persist(); renderDrawings(); updateShapeCtl();
        committed = true;
      }
    } else if (Math.hypot(s.x2 - s.x1, s.y2 - s.y1) * view.s >= 4) {
      doors.push(s); undoStack.push({ kind: "door", obj: s });
      selShape = { kind: "door", obj: s };   // 新放的门自动选中, 便于马上调朝向
      persist(); renderDrawings(); updateShapeCtl();
      committed = true;
    }
    if (committed) { drawnGesture = true; toast("已放置" + SHAPE_LABEL[s.kind]); }   // 吞掉拖拽尾随 click + 操作反馈
  }
});
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
const shapeArr = kind => ({ wall: walls, door: doors, table: tables, chair: chairs, stair: stairs, lift: lifts, router: routers })[kind];
function updateShapeCtl() {
  const on = selShape && shapeArr(selShape.kind).includes(selShape.obj);
  $("shapeCtl").style.display = on ? "" : "none";
  if (on) {
    $("shapeInfo").textContent = selShape.kind === "wall" ? "已选中墙体" :
      selShape.kind === "door" ? "已选中门" :
      selShape.kind === "chair" ? "已选中座椅" :
      selShape.kind === "stair" ? "已选中楼梯" :
      selShape.kind === "lift" ? "已选中电梯" :
      selShape.kind === "router" ? "已选中路由器" : "已选中桌子";
    $("btnDoorFlip").style.display = selShape.kind === "door" ? "" : "none";
    $("btnDoorHinge").style.display = selShape.kind === "door" ? "" : "none";
    $("btnStairFlip").style.display = selShape.kind === "stair" ? "" : "none";
    $("btnChairRot").style.display = selShape.kind === "chair" ? "" : "none";
    const isRouter = selShape.kind === "router";
    $("routerZLab").style.display = isRouter ? "" : "none";
    $("routerZUnit").style.display = isRouter ? "" : "none";
    $("routerZIn").style.display = isRouter ? "" : "none";
    if (isRouter) $("routerZIn").value = Math.round((+selShape.obj.z || 2.5) * 10) / 10;
  }
}
$("btnDoorFlip").onclick = () => {
  const d = selShape && doors.includes(selShape.obj) ? selShape.obj : null;
  if (!d) return;
  d.flip = d.flip ? 0 : 1;
  persist(); renderDrawings();
};
$("btnDoorHinge").onclick = () => {
  const d = selShape && doors.includes(selShape.obj) ? selShape.obj : null;
  if (!d) return;
  d.hinge = d.hinge ? 0 : 1;
  persist(); renderDrawings();
};
$("btnStairFlip").onclick = () => {
  const st = selShape && stairs.includes(selShape.obj) ? selShape.obj : null;
  if (!st) return;
  st.dir = st.dir ? 0 : 1;
  persist(); renderDrawings();
};
$("btnChairRot").onclick = () => {   // 靠背侧: 上(0)→右(1)→下(2)→左(3) 循环
  const c = selShape && chairs.includes(selShape.obj) ? selShape.obj : null;
  if (!c) return;
  c.dir = ((c.dir | 0) + 1) % 4;
  persist(); renderDrawings();
};
$("routerZIn").onchange = e => {     // AP 悬挂高度(米)
  const rt = selShape && routers.includes(selShape.obj) ? selShape.obj : null;
  if (!rt) return;
  rt.z = Math.min(6, Math.max(0.1, +e.target.value || 2.5));
  e.target.value = rt.z;
  persist(); renderDrawings();
};
$("btnShapeDel").onclick = () => {
  if (!selShape) return;
  const arr = shapeArr(selShape.kind);
  const i = arr.indexOf(selShape.obj);
  if (i >= 0) arr.splice(i, 1);
  const label = SHAPE_LABEL[selShape.kind] || "图形";
  selShape = null;
  updateShapeCtl();
  persist(); renderDrawings();
  toast("已删除" + label);
};

stageEl.addEventListener("click", e => {
  if (drawnGesture) { drawnGesture = false; return; }   // 拖拽画图收尾的 click: 不触发选中/取消
  // 阵列模式点击不回避测点标记(起点/终点常落在已有测点上)
  if (e.target.closest(".mk") && tool !== "array") return;
  const r = stageEl.getBoundingClientRect();
  const sxp = e.clientX - r.left, syp = e.clientY - r.top;
  // 命中图形 → 选中 (阵列模式下两次点击都用于定点, 跳过图形选中)
  const hit = tool !== "array" ? hitShapeAt(sxp, syp) : null;
  if (hit) {
    selShape = { kind: hit.kind, obj: hit.obj };
    selPointId = null;
    renderDrawings(); renderMarkers(); renderPtList(); renderDetail(); updateShapeCtl();
    return;
  }
  if (selShape) { selShape = null; updateShapeCtl(); renderDrawings(); }
  const [wx, wy] = evtWorld(e);
  if (tool === "array") {   // 阵列: 第一次点击定起点, 第二次点击定终点并按个数均匀布点(含两端)
    const ax = snapV(wx), ay = snapV(wy);
    if (!arrayAnchor) {
      arrayAnchor = { x: ax, y: ay };
      renderArrayPreview();
    } else if (Math.hypot(ax - arrayAnchor.x, ay - arrayAnchor.y) * view.s >= 4) {
      const n = arrCount();
      const batch = [];
      for (let k = 0; k < n; k++) {
        const t = n > 1 ? k / (n - 1) : 0;
        const p = makePointAt(snapV(arrayAnchor.x + (ax - arrayAnchor.x) * t),
                              snapV(arrayAnchor.y + (ay - arrayAnchor.y) * t));
        mapPoints.push(p); batch.push(p);
      }
      undoStack.push({ kind: "point", obj: batch });   // 阵列整批记为一笔
      selPointId = mapPoints[mapPoints.length - 1].id;
      arrayAnchor = null; renderArrayPreview();
      persist(); renderMarkers(); renderPtList(); renderDetail();
    }
    return;
  }
  if (tool === "add") { addPointAt(snapV(wx), snapV(wy)); return; }
  if (tool === "router") { addRouterAt(snapV(wx), snapV(wy)); return; }
  if (tool === "origin") {
    origin = { x: snapV(wx), y: snapV(wy) };
    persist(); positionMarkers(); renderPtList(); renderDetail();
  }
});

function addRouterAt(wx, wy) {   // 悬挂式 AP: 高度沿用上一次放置/选中的高度
  const z = routers.length ? (routers[routers.length - 1].z || 2.5) : 2.5;
  const obj = { x: wx, y: wy, z };
  routers.push(obj);
  undoStack.push({ kind: "router", obj });
  selShape = { kind: "router", obj };
  persist(); renderDrawings(); updateShapeCtl();
  toast("已放置路由器");
}
