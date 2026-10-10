// 沉浸漫游: 第三人称小人(碰撞/贴地/楼梯), 必须最后加载
/* ================= 沉浸漫游: 第三人称小人在建筑中行走 ================= */
const walk = {
  active: false, pos: new THREE.Vector3(), vy: 0, yaw: Math.PI, pitch: 0.22,
  keys: {}, speed: 0, phase: 0, charYaw: null, char: null, savedCam: null,
  ray: new THREE.Raycaster(),
};
function walkFloorAt(level) {   // 指定楼层的活数据(当前层取编辑器活动数组)
  if (floors.length) {
    const f = floors.find(q => q.level === level);
    if (!f) return null;
    return f.id === curFloorId ? liveFloorData() : f;
  }
  return level === 0 ? liveFloorData() : null;
}
function walkBlocked(x, z, level) {   // 圆形身体(半径0.26m)对墙/桌/椅的碰撞; 门洞放行
  const fd = walkFloorAt(level);
  if (!fd) return false;
  const r = 0.26;
  const rectM = (a) => {
    const [x1, z1] = m3(Math.min(a.x1, a.x2), Math.min(a.y1, a.y2));
    const [x2, z2] = m3(Math.max(a.x1, a.x2), Math.max(a.y1, a.y2));
    return [x1, z1, x2, z2];
  };
  const hit = (rc) => {
    const cx = Math.max(rc[0], Math.min(x, rc[2])), cz = Math.max(rc[1], Math.min(z, rc[3]));
    return (x - cx) ** 2 + (z - cz) ** 2 < r * r;
  };
  for (const w of fd.walls || []) {
    let wx = Math.min(w.x1, w.x2), wy = Math.min(w.y1, w.y2);
    let ww = Math.abs(w.x2 - w.x1), hh = Math.abs(w.y2 - w.y1);
    if (ww < 0.5) { wx -= wallThick / 2; ww = wallThick; }
    if (hh < 0.5) { wy -= wallThick / 2; hh = wallThick; }
    const rc = rectM({ x1: wx, y1: wy, x2: wx + ww, y2: wy + hh });
    if (!hit(rc)) continue;
    const horiz = ww >= hh;                       // 门洞放行: 身体沿墙长轴落在门跨内
    let pass = false;
    for (const d of fd.doors || []) {
      const [a1, b1] = m3(d.x1, d.y1), [a2, b2] = m3(d.x2, d.y2);
      if (horiz) {
        if ((b1 + b2) / 2 < rc[1] - 0.5 || (b1 + b2) / 2 > rc[3] + 0.5) continue;
        if (x >= Math.min(a1, a2) - 0.1 && x <= Math.max(a1, a2) + 0.1) { pass = true; break; }
      } else {
        if ((a1 + a2) / 2 < rc[0] - 0.5 || (a1 + a2) / 2 > rc[2] + 0.5) continue;
        if (z >= Math.min(b1, b2) - 0.1 && z <= Math.max(b1, b2) + 0.1) { pass = true; break; }
      }
    }
    if (!pass) return true;
  }
  for (const t of fd.tables || []) if (hit(rectM(t))) return true;
  for (const c of fd.chairs || []) if (hit(rectM(c))) return true;
  return false;
}
function walkGround(x, z) {   // 站立面高度: 各层楼板 + 楼梯坡道, 取脚下(含0.5m踏步容差)最高面
  let best = -Infinity;
  for (const f0 of floors.length ? floors : [{ id: curFloorId, level: 0 }]) {
    const fd = f0.id === curFloorId ? liveFloorData() : f0;
    const y0 = f0.level * FLOOR_H;
    const fe = floorExtentM(fd);
    if (fe && x >= fe.x1 - 0.3 && x <= fe.x2 + 0.3 && z >= fe.z1 - 0.3 && z <= fe.z2 + 0.3)
      if (y0 <= walk.pos.y + 0.5) best = Math.max(best, y0);
    for (const st of fd.stairs || []) {
      const [x1, z1] = m3(Math.min(st.x1, st.x2), Math.min(st.y1, st.y2));
      const [x2, z2] = m3(Math.max(st.x1, st.x2), Math.max(st.y1, st.y2));
      if (x < x1 - 0.1 || x > x2 + 0.1 || z < z1 - 0.1 || z > z2 + 0.1) continue;
      const horiz = Math.abs(st.x2 - st.x1) >= Math.abs(st.y2 - st.y1);
      const len = horiz ? x2 - x1 : z2 - z1;
      if (len <= 0.01) continue;
      const t = horiz ? (x - x1) / len : (z - z1) / len;
      const prog = st.dir ? t : 1 - t;            // 与 3D 踏步排布一致: dir=0 低端在长轴正端
      const h = y0 + Math.max(0, Math.min(1, prog)) * FLOOR_H;
      if (h <= walk.pos.y + 0.5) best = Math.max(best, h);
    }
  }
  if (best === -Infinity) best = (floors.length ? floors[0].level : 0) * FLOOR_H;
  return best;
}
function buildWalkChar() {   // 简洁小人: 蓝衣/肤色头/深色裤, 四肢摆动
  const matBody = new THREE.MeshStandardMaterial({ color: 0x0047ab, roughness: 0.6 });
  const matHead = new THREE.MeshStandardMaterial({ color: 0xf0c8a0, roughness: 0.7 });
  const matDark = new THREE.MeshStandardMaterial({ color: 0x23272e, roughness: 0.8 });
  const box = (mat, w, h, d, x, y, z, parent) => {
    const m = new THREE.Mesh(m3d.unitBox, mat);
    m.scale.set(w, h, d); m.position.set(x, y, z); m.castShadow = true;
    parent.add(m); return m;
  };
  const mkLimb = (x, y, w, h, d, mat) => {       // 摆动肢体: 网格挂在转轴下方
    const piv = new THREE.Group(); piv.position.set(x, y, 0);
    const m = new THREE.Mesh(m3d.unitBox, mat);
    m.scale.set(w, h, d); m.position.y = -h / 2; m.castShadow = true;
    piv.add(m); return piv;
  };
  const g = new THREE.Group();
  const legL = mkLimb(-0.10, 0.74, 0.13, 0.74, 0.15, matDark);
  const legR = mkLimb(0.10, 0.74, 0.13, 0.74, 0.15, matDark);
  const armL = mkLimb(-0.24, 1.24, 0.09, 0.50, 0.11, matBody);
  const armR = mkLimb(0.24, 1.24, 0.09, 0.50, 0.11, matBody);
  g.add(legL, legR, armL, armR);
  box(matBody, 0.36, 0.52, 0.24, 0, 1.00, 0, g);        // 躯干
  box(matHead, 0.27, 0.27, 0.27, 0, 1.42, 0, g);        // 头
  box(matDark, 0.28, 0.05, 0.14, 0, 1.57, 0.10, g);     // 帽檐(朝向指示)
  return { group: g, legL, legR, armL, armR };
}
function walkEnter() {
  if (!view3d || !m3d.ready || !curMap) return;
  const L = floors.length ? curFloor().level : 0;
  const fd = liveFloorData();                     // 出生点: 本层范围中心起螺旋找空位
  const fe = floorExtentM(fd) || { cx: 0, cz: 0, d: 8 };
  let sx = fe.cx, sz = fe.cz;
  outer: for (let rad = 0; rad < Math.max(fe.d, 4); rad += 0.6) {
    const steps = rad ? 16 : 1;
    for (let a = 0; a < steps; a++) {
      const ang = a / steps * Math.PI * 2;
      const x = fe.cx + Math.cos(ang) * rad, z = fe.cz + Math.sin(ang) * rad;
      if (!walkBlocked(x, z, L)) { sx = x; sz = z; break outer; }
    }
  }
  walk.pos.set(sx, L * FLOOR_H, sz);
  walk.vy = 0; walk.pitch = 0.22;
  walk.phase = 0; walk.keys = {}; walk.charYaw = null; walk.speed = 0;
  let bestYaw = 0, bestOpen = -1;                // 朝向: 取四方向中前方最开阔者
  for (const ya of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const fx = -Math.sin(ya), fz = -Math.cos(ya);
    let open = 0;
    for (const dd of [0.6, 1.2, 2.0, 3.0]) {
      if (walkBlocked(sx + fx * dd, sz + fz * dd, L)) break;
      open = dd;
    }
    if (open > bestOpen) { bestOpen = open; bestYaw = ya; }
  }
  walk.yaw = bestYaw;
  if (!walk.char) walk.char = buildWalkChar();
  m3d.scene.add(walk.char.group);
  walk.savedCam = { p: m3d.camera.position.clone(), t: m3d.controls.target.clone() };
  m3d.controls.enabled = false;
  walk.active = true;
  $("btnWalk").style.display = "none";
  $("map3dLegend").style.display = "none";
  $("walkHint").style.display = "";
  const cv = m3d.renderer.domElement;             // 指针锁定(部分环境不支持则退化为按住左键拖动)
  try { const p = cv.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
}
function walkExit() {
  if (!walk.active) return;
  walk.active = false;
  walk.keys = {};
  if (walk.char && walk.char.group.parent) m3d.scene.remove(walk.char.group);
  if (walk.savedCam) {
    m3d.camera.position.copy(walk.savedCam.p);
    m3d.controls.target.copy(walk.savedCam.t);
  }
  m3d.controls.enabled = true;
  m3d.controls.update();
  $("btnWalk").style.display = "";
  $("map3dLegend").style.display = "";
  $("walkHint").style.display = "none";
  if (document.pointerLockElement) try { document.exitPointerLock(); } catch (e) {}
}
$("btnWalk").onclick = () => walk.active ? walkExit() : walkEnter();
document.addEventListener("pointerlockchange", () => {   // Esc 释放指针锁定 → 退出漫游
  if (walk.active && m3d.ready && document.pointerLockElement !== m3d.renderer.domElement) walkExit();
});
function walkStep(dt) {
  const k = walk.keys;
  const mx = (k.d ? 1 : 0) - (k.a ? 1 : 0), mz = (k.w ? 1 : 0) - (k.s ? 1 : 0);
  const spd = k.shift ? 3.4 : 1.7;
  const fx = -Math.sin(walk.yaw), fz = -Math.cos(walk.yaw);   // 朝向
  const rx = -fz, rz = fx;                                    // 右向
  let dx = fx * mz + rx * mx, dz = fz * mz + rz * mx;
  const dl = Math.hypot(dx, dz);
  const moving = dl > 0.01;
  if (moving) {
    dx /= dl; dz /= dl;
    const L = Math.round(walk.pos.y / FLOOR_H);
    const nx = walk.pos.x + dx * spd * dt, nz = walk.pos.z + dz * spd * dt;
    if (!walkBlocked(nx, walk.pos.z, L)) walk.pos.x = nx;      // 分轴滑动
    if (!walkBlocked(walk.pos.x, nz, L)) walk.pos.z = nz;
  }
  walk.speed += ((moving ? spd : 0) - walk.speed) * Math.min(1, dt * 10);
  walk.phase += walk.speed * dt * 3.4;
  const gd = walkGround(walk.pos.x, walk.pos.z);
  if (walk.pos.y > gd + 0.02) {               // 离地: 小落差贴地, 大落差重力下落
    if (walk.pos.y - gd > 0.45) {
      walk.vy -= 12 * dt; walk.pos.y += walk.vy * dt;
      if (walk.pos.y < gd) { walk.pos.y = gd; walk.vy = 0; }
    } else { walk.pos.y = gd; walk.vy = 0; }
  } else { walk.pos.y = gd; walk.vy = 0; }
  const C = walk.char;                         // 小人姿态与朝向
  C.group.position.copy(walk.pos);
  if (moving) {
    const face = Math.atan2(dx, dz);
    if (walk.charYaw === null) walk.charYaw = face;
    let dYaw = face - walk.charYaw;
    while (dYaw > Math.PI) dYaw -= Math.PI * 2;
    while (dYaw < -Math.PI) dYaw += Math.PI * 2;
    walk.charYaw += dYaw * Math.min(1, dt * 12);
    C.group.rotation.y = walk.charYaw;
  }
  const amp = Math.min(1, walk.speed / 1.7) * 0.55;
  const sw = Math.sin(walk.phase) * amp;
  C.legL.rotation.x = sw; C.legR.rotation.x = -sw;
  C.armL.rotation.x = -sw * 0.8; C.armR.rotation.x = sw * 0.8;
  const tgt = new THREE.Vector3(walk.pos.x, walk.pos.y + 1.35, walk.pos.z);
  const dist = 3.1, cp = Math.cos(walk.pitch), sp = Math.sin(walk.pitch);
  const des = new THREE.Vector3(tgt.x + Math.sin(walk.yaw) * cp * dist,
                                tgt.y + sp * dist,
                                tgt.z + Math.cos(walk.yaw) * cp * dist);
  if (des.y > walk.pos.y + 2.45) des.y = walk.pos.y + 2.45;    // 保持在顶棚(2.8m)之下
  const dirv = des.clone().sub(tgt);
  const dd = dirv.length();
  if (dd > 0.01) {                             // 相机防穿墙: 目标点→相机方向射线检测
    dirv.normalize();
    const L = Math.round(walk.pos.y / FLOOR_H);
    const walls = m3d.wallMeshes.filter(m => m.userData.level === L);
    if (walls.length) {
      walk.ray.set(tgt, dirv); walk.ray.far = dd;
      const hits = walk.ray.intersectObjects(walls, false);
      if (hits.length && hits[0].distance < dd)
        des.copy(tgt).addScaledVector(dirv, Math.max(0.5, hits[0].distance - 0.18));
    }
  }
  m3d.camera.position.lerp(des, 1 - Math.pow(0.001, dt));
  m3d.camera.lookAt(tgt);
}
