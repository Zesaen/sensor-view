// 2D 渲染: 建筑图纸画法(墙 poché/门弧/家具/AP) + 测点标记
/* ---- 渲染 ---- */
function coordText(p) {
  const rx = (p.x - origin.x) / gridSize, ry = (p.y - origin.y) / gridSize;
  return `(${rx.toFixed(1)}, ${ry.toFixed(1)})`;
}
function positionMarkers() {
  document.querySelectorAll("#mapMarkers .mk").forEach(el => {
    const p = pointById(el.dataset.id);
    if (!p) return;
    const [sx, sy] = worldToScreen(p.x, p.y);
    el.style.transform = `translate(${sx}px, ${sy}px)`;
  });
  const [ox, oy] = worldToScreen(origin.x, origin.y);
  $("originMark").style.transform = `translate(${ox}px, ${oy}px)`;
}
function wallPoly(w) {   // 沿线段按墙体厚度生成实体矩形四角
  const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len * wallThick / 2, ny = dx / len * wallThick / 2;
  return `${w.x1 + nx},${w.y1 + ny} ${w.x2 + nx},${w.y2 + ny} ${w.x2 - nx},${w.y2 - ny} ${w.x1 - nx},${w.y1 - ny}`;
}
function wallRect(w) {   // 墙块的渲染矩形(旧版直线段数据按墙厚展开)
  let x = Math.min(w.x1, w.x2), y = Math.min(w.y1, w.y2);
  let ww = Math.abs(w.x2 - w.x1), hh = Math.abs(w.y2 - w.y1);
  if (ww < 0.5) { x -= wallThick / 2; ww = wallThick; }
  if (hh < 0.5) { y -= wallThick / 2; hh = wallThick; }
  return { x, y, w: ww, h: hh };
}
function renderArrayPreview() {   // 阵列预览: 起点→鼠标 虚线 + N 个幽灵点 + 个数/间距标注
  const g = $("arrayG");
  if (tool !== "array" || !arrayAnchor || !lastMouse) { g.innerHTML = ""; return; }
  const n = arrCount();
  const ex = snapV(lastMouse.x), ey = snapV(lastMouse.y);
  const dx = ex - arrayAnchor.x, dy = ey - arrayAnchor.y;
  if (Math.hypot(dx, dy) * view.s < 4) { g.innerHTML = ""; return; }
  let h = `<line x1="${arrayAnchor.x}" y1="${arrayAnchor.y}" x2="${ex}" y2="${ey}"
    stroke="#0047ab" stroke-width="1.5" stroke-dasharray="6 4" vector-effect="non-scaling-stroke"/>`;
  for (let k = 0; k < n; k++) {
    const t = n > 1 ? k / (n - 1) : 0;
    h += `<circle cx="${arrayAnchor.x + dx * t}" cy="${arrayAnchor.y + dy * t}" r="5"
      fill="rgba(0,71,171,.16)" stroke="#0047ab" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
  }
  const stepM = (Math.hypot(dx, dy) / Math.max(1, n - 1)) / pxPerM;
  h += `<text x="${arrayAnchor.x + dx / 2}" y="${arrayAnchor.y + dy / 2 - 10 / view.s}"
    font-size="${11 / view.s}" text-anchor="middle" fill="#0047ab">${n} 点 · 间距 ${stepM.toFixed(2)} m</text>`;
  g.innerHTML = h;
}
function renderDrawings() {   // 建筑图纸画法: 桌(家具双线) → 墙(斜线poché) → AP → 门(门洞+门叶+开启弧)
  // 图纸墨色为主, 仅选中态用主题蓝; 线宽均 non-scaling(屏幕级恒定)
  const INK = "#2a323c", ACC = "#0047ab";
  let h = "";
  for (const t of tables) {   // 桌: 白底 + 外实线 + 内衬细线(家具双线画法)
    const sel = selShape && selShape.kind === "table" && selShape.obj === t;
    const x = Math.min(t.x1, t.x2), y = Math.min(t.y1, t.y2);
    const w = Math.abs(t.x2 - t.x1), hh = Math.abs(t.y2 - t.y1);
    h += `<rect x="${x}" y="${y}" width="${w}" height="${hh}"
      fill="#ffffff" stroke="${sel ? ACC : INK}" stroke-width="${sel ? 2.5 : 1.5}"
      vector-effect="non-scaling-stroke"/>`;
    const ins = Math.min(6, w / 4, hh / 4);
    if (ins > 1.5) h += `<rect x="${x + ins}" y="${y + ins}" width="${w - ins * 2}" height="${hh - ins * 2}"
      fill="none" stroke="${sel ? ACC : "#9aa3ad"}" stroke-width="0.75" vector-effect="non-scaling-stroke"/>`;
  }
  for (const c of chairs) {   // 座椅: 座面矩形 + 靠背侧粗带(建筑制图画法)
    const sel = selShape && selShape.kind === "chair" && selShape.obj === c;
    const x = Math.min(c.x1, c.x2), y = Math.min(c.y1, c.y2);
    const w = Math.abs(c.x2 - c.x1), hh = Math.abs(c.y2 - c.y1);
    const col = sel ? ACC : INK;
    h += `<rect x="${x}" y="${y}" width="${w}" height="${hh}"
      fill="#ffffff" stroke="${col}" stroke-width="${sel ? 2 : 1.2}" vector-effect="non-scaling-stroke"/>`;
    const bw = Math.max(2.5, Math.min(w, hh) * 0.22);   // 靠背厚度
    const band = c.dir === 0
      ? `<rect x="${x}" y="${y}" width="${w}" height="${bw}"/>`
      : c.dir === 1 ? `<rect x="${x + w - bw}" y="${y}" width="${bw}" height="${hh}"/>`
      : c.dir === 2 ? `<rect x="${x}" y="${y + hh - bw}" width="${w}" height="${bw}"/>`
      : `<rect x="${x}" y="${y}" width="${bw}" height="${hh}"/>`;
    h += `<g fill="${sel ? ACC : "#dfe3e8"}" stroke="${col}" stroke-width="1"
      vector-effect="non-scaling-stroke">${band}</g>`;
  }
  for (const st of stairs) {   // 楼梯: 外框 + 踏步线 + 上行方向箭头(建筑制图画法)
    const sel = selShape && selShape.kind === "stair" && selShape.obj === st;
    const x = Math.min(st.x1, st.x2), y = Math.min(st.y1, st.y2);
    const w = Math.abs(st.x2 - st.x1), hh = Math.abs(st.y2 - st.y1);
    const col = sel ? ACC : INK;
    h += `<rect x="${x}" y="${y}" width="${w}" height="${hh}"
      fill="#ffffff" stroke="${col}" stroke-width="${sel ? 2.5 : 1.5}" vector-effect="non-scaling-stroke"/>`;
    const horiz = w >= hh;                      // 长边 = 行进方向
    const len = horiz ? w : hh, wid = horiz ? hh : w;
    const run = 0.28 * pxPerM;                  // 踏面进深 28cm
    const n = Math.max(2, Math.min(40, Math.round(len / Math.max(run, 1))));
    let treads = "";
    for (let k = 1; k < n; k++) {
      const d = len * k / n;
      treads += horiz
        ? `<line x1="${x + d}" y1="${y}" x2="${x + d}" y2="${y + hh}"/>`
        : `<line x1="${x}" y1="${y + d}" x2="${x + w}" y2="${y + d}"/>`;
    }
    if (treads) h += `<g stroke="${sel ? ACC : "#9aa3ad"}" stroke-width="1"
      vector-effect="non-scaling-stroke" fill="none">${treads}</g>`;
    // 中心行进线 + 箭头指向上行端, 上行端标「上」
    const cx = x + w / 2, cy = y + hh / 2;
    const sgn = st.dir ? -1 : 1;                // dir=1 上行指向长轴负端
    const ax0 = horiz ? cx - sgn * (len / 2 - len * 0.08) : cx;
    const ay0 = horiz ? cy : cy - sgn * (len / 2 - len * 0.08);
    const ax1 = horiz ? cx + sgn * (len / 2 - len * 0.16) : cx;
    const ay1 = horiz ? cy : cy + sgn * (len / 2 - len * 0.16);
    const ah = 7 / view.s;                      // 箭头头部(屏幕级大小)
    const ux = horiz ? sgn : 0, uy = horiz ? 0 : sgn;
    h += `<line x1="${ax0}" y1="${ay0}" x2="${ax1}" y2="${ay1}" stroke="${col}" stroke-width="1.25"
      vector-effect="non-scaling-stroke"/>`
      + `<path d="M ${ax1 - ux * ah - uy * ah * 0.55} ${ay1 - uy * ah - ux * ah * 0.55}
        L ${ax1} ${ay1} L ${ax1 - ux * ah + uy * ah * 0.55} ${ay1 - uy * ah + ux * ah * 0.55}"
        fill="none" stroke="${col}" stroke-width="1.25" vector-effect="non-scaling-stroke"/>`
      + `<text x="${ax1 + ux * ah * 0.9}" y="${ay1 + uy * ah * 0.9 + 4 / view.s}"
        font-size="${12 / view.s}" font-weight="700" fill="${col}"
        text-anchor="${ux > 0 ? "start" : ux < 0 ? "end" : "middle"}">上</text>`;
  }
  for (const lf of lifts) {   // 电梯: 外框 + 对角交叉线(电梯井制图符号) + 门位刻线
    const sel = selShape && selShape.kind === "lift" && selShape.obj === lf;
    const x = Math.min(lf.x1, lf.x2), y = Math.min(lf.y1, lf.y2);
    const w = Math.abs(lf.x2 - lf.x1), hh = Math.abs(lf.y2 - lf.y1);
    const col = sel ? ACC : INK;
    h += `<rect x="${x}" y="${y}" width="${w}" height="${hh}"
      fill="#ffffff" stroke="${col}" stroke-width="${sel ? 2.5 : 1.5}" vector-effect="non-scaling-stroke"/>`
      + `<line x1="${x}" y1="${y}" x2="${x + w}" y2="${y + hh}" stroke="${sel ? ACC : "#9aa3ad"}" stroke-width="1"
        vector-effect="non-scaling-stroke"/>`
      + `<line x1="${x + w}" y1="${y}" x2="${x}" y2="${y + hh}" stroke="${sel ? ACC : "#9aa3ad"}" stroke-width="1"
        vector-effect="non-scaling-stroke"/>`
      + `<line x1="${x + w * 0.5 - Math.min(w, hh) * 0.18}" y1="${y + hh}" x2="${x + w * 0.5 + Math.min(w, hh) * 0.18}" y2="${y + hh}"
        stroke="${col}" stroke-width="2.5" vector-effect="non-scaling-stroke"/>`;
  }
  for (const w of walls) {   // 墙: 白底+斜线填充; 远距/选中时实线
    const rc = wallRect(w);
    const sel = selShape && selShape.kind === "wall" && selShape.obj === w;
    const fill = sel || wallSolidMode ? (sel ? ACC : "#3c4653") : "url(#wallHatch)";
    h += `<rect x="${rc.x}" y="${rc.y}" width="${rc.w}" height="${rc.h}"
      fill="${fill}" stroke="${sel ? ACC : INK}"
      stroke-width="${sel ? 2.5 : 1}" vector-effect="non-scaling-stroke"/>`;
  }
  for (const r of routers) {   // 路由器(AP): 方点 + 两道同心信号弧 + 悬挂高度标注
    const selR = selShape && selShape.kind === "router" && selShape.obj === r;
    const col = selR ? ACC : INK;
    h += `<rect x="${r.x - 3.5}" y="${r.y + 0.5}" width="7" height="7" fill="${col}"/>`
      + `<path d="M ${r.x - 8.5} ${r.y + 4} A 8.5 8.5 0 0 1 ${r.x + 8.5} ${r.y + 4}" fill="none"
        stroke="${col}" stroke-width="1.25" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`
      + `<path d="M ${r.x - 15} ${r.y + 4} A 15 15 0 0 1 ${r.x + 15} ${r.y + 4}" fill="none"
        stroke="${col}" stroke-width="1.25" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`
      + `<text x="${r.x}" y="${r.y - 18 / view.s}" font-size="${10 / view.s}" text-anchor="middle"
        fill="${col}" font-weight="700">${(+r.z || 2.5).toFixed(1)}m</text>`;
  }
  for (const d of doors) {   // 门: A→B 为门洞方向; flip=开门侧, hinge=门铰端(A/B)
    const flip = d.flip ? -1 : 1, hingeA = !d.hinge;
    const sel = selShape && selShape.kind === "door" && selShape.obj === d;
    const hx = hingeA ? d.x1 : d.x2, hy = hingeA ? d.y1 : d.y2;
    const ox = hingeA ? d.x2 : d.x1, oy = hingeA ? d.y2 : d.y1;
    const cx = hx - (oy - hy) * flip, cy = hy + (ox - hx) * flip;
    const r = Math.hypot(ox - hx, oy - hy);
    h += `<polygon points="${wallPoly(d)}" fill="#ffffff" stroke="${sel ? ACC : INK}"
      stroke-width="1" vector-effect="non-scaling-stroke"/>`                       // 门洞(白)
      + `<path d="M ${ox} ${oy} A ${r} ${r} 0 0 ${flip > 0 ? 1 : 0} ${cx} ${cy}" fill="none"
        stroke="${sel ? ACC : "#9aa3ad"}" stroke-width="1" vector-effect="non-scaling-stroke"/>`  // 开启弧(细)
      + `<line x1="${hx}" y1="${hy}" x2="${cx}" y2="${cy}" stroke="${sel ? ACC : INK}"
        stroke-width="2" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`;            // 门叶
  }
  $("wallG").innerHTML = h;
  map3dTouch();   // 三维视角打开时同步重建立体场景
}
function renderMarkers() {
  $("mapMarkers").innerHTML = mapPoints.map((p, i) => `
    <div class="mk${p.id === selPointId ? " sel" : ""}${p.collecting ? " collecting" : ""}" data-id="${p.id}">
      <div class="mkDot" title="${escH(p.name)} ${coordText(p)}">${i + 1}</div>
      ${p.collecting || (p.roundsDone | 0) > 0 ? `<div class="mkProg" data-id="${p.id}">${progText(p)}</div>` : ""}
    </div>`).join("");
  document.querySelectorAll("#mapMarkers .mk").forEach(el => {
    el.onclick = ev => { ev.stopPropagation(); selectPoint(el.dataset.id); };
  });
  positionMarkers();
  updateMapStat();
  map3dTouch();   // 三维视角打开时同步测点标记/选中态
}
