// 坐标变换 / 视图(缩放平移/网格/比例尺/fitView)
/* ---- 坐标变换 / 视图 ---- */
const worldToScreen = (wx, wy) => [wx * view.s + view.tx, wy * view.s + view.ty];
const screenToWorld = (sx, sy) => [(sx - view.tx) / view.s, (sy - view.ty) / view.s];
const snapV = v => snapOn ? Math.round(v / gridSize) * gridSize : Math.round(v * 100) / 100;

function applyView() {
  const { s, tx, ty } = view;
  $("mapImg").style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
  $("worldG").setAttribute("transform", `translate(${tx} ${ty}) scale(${s})`);
  // 蓝色坐标纸栅格: 微格/细格/米格/粗档随缩放自适应, 渐入渐出不突现
  const st = $("mapStage");
  if (!gridOn) {
    st.style.backgroundImage = "none";
  } else {
    const g = gridLayers(s);
    st.style.backgroundImage = g.bg.join(", ") || "none";
    st.style.backgroundSize = g.sz.join(", ") || "auto";
  }
  st.style.backgroundPosition = `${tx}px ${ty}px`;
  const pat = document.getElementById("wallHatch");
  if (pat) {   // 斜线密度按缩放反比缩放, 屏幕上恒为 7px 间距 / 1px 线宽
    const w = 7 / s;
    pat.setAttribute("width", w); pat.setAttribute("height", w);
    const bg = pat.firstElementChild;
    bg.setAttribute("width", w); bg.setAttribute("height", w);
    const ln = pat.lastElementChild;
    ln.setAttribute("d", `M 0 ${w} L ${w} 0`);
    ln.setAttribute("stroke-width", 1 / s);
  }
  const solid = wallThick * s < 5;   // 缩得太远墙宽低于斜线间距 → 整体退化为实线墙
  if (solid !== wallSolidMode) { wallSolidMode = solid; renderDrawings(); }
  updateScaleBar(s);
  st.classList.toggle("miniMk", s < 0.6);   // 缩小后标记隐藏序号, 只留小方块
  positionMarkers();
}

function gridFade(px) {   // 间距 8px 以下不画, 8→18px 渐入, 避免图层突现突失
  return px < 8 ? 0 : px >= 18 ? 1 : (px - 8) / 10;
}
function gridLayers(s) {
  const out = { bg: [], sz: [] };   // CSS 背景前者在上: 粗档画在最上层
  const add = (px, alpha, w) => {
    const a = alpha * gridFade(px);
    if (a <= 0.015) return;
    const c = `rgba(0,71,171,${a.toFixed(3)})`;
    const pxs = px.toFixed(2) + "px";
    out.bg.push(`linear-gradient(${c} ${w}px, transparent ${w}px)`,
                `linear-gradient(90deg, ${c} ${w}px, transparent ${w}px)`);
    out.sz.push(`${pxs} ${pxs}`, `${pxs} ${pxs}`);
  };
  const major = pxPerM * s;
  if (major < 24) {                                     // 米格过密 → 粗档按 2-5-10 阶梯顶上
    for (const k of [2, 5, 10, 20, 50, 100, 200, 500])
      if (major * k >= 24) { add(major * k, 0.5, 1.5); break; }
  }
  add(major, 0.32, 1);                                  // 米格
  if (gridMinorOn) {
    add(gridSize * s, 0.13, 1);                         // 细格 = 网格单位
    if (gridSize * s > 140) add(gridSize * s / 5, 0.06, 1);   // 微格 = 1/5 格(放大很深时)
  }
  return out;
}
function updateScaleBar(s) {   // 右下角比例尺: 屏幕上 30~160px 内取最大整数档
  const bar = $("scaleBar");
  if (!gridOn) { bar.style.display = "none"; return; }
  bar.style.display = "";
  let pick = 0.02;
  for (const m of [0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50])
    if (m * pxPerM * s <= 160) pick = m;
  bar.style.width = Math.max(14, Math.round(pick * pxPerM * s)) + "px";
  $("scaleBarTxt").textContent = pick >= 1 ? pick + " m" : Math.round(pick * 100) + " cm";
}

function fitView() {
  const W = $("mapWrap").clientWidth, H = $("mapWrap").clientHeight;
  if (!W || !H) return;
  if (mapHasImage && mapImgNatural[0]) {
    const [iw, ih] = mapImgNatural;
    view.s = Math.min(W / iw, H / ih);
    view.tx = (W - iw * view.s) / 2;
    view.ty = (H - ih * view.s) / 2;
  } else { view.s = 1; view.tx = 0; view.ty = 0; }
  applyView();
  if (view3d) m3dFit();   // 三维模式下「重置视图」同时复位立体相机
}
