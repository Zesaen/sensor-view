// 地图三维视角 m3d*(PBR 材质/三灯/多楼层/Esc③ window 级, 须后于 tools.js)
/* ================= 地图三维视角 ================= */
/* 坐标约定: 2D 世界px (x右/y下) → 3D 米制 (x东, z南, y上);
   原点(0,0)为坐标系中心, 北 = -Z, 1 单位 = 1 m */
let view3d = false;
const m3d = { ready: false };          // 惰性初始化: 首次进入三维视角才建 WebGL 上下文
const M_WALL_H = 2.8, M_TABLE_H = 0.75, M_DOOR_H = 2.05, M_STEP_RUN = 0.28;
const m3 = (wx, wy) => [(wx - origin.x) / pxPerM, (wy - origin.y) / pxPerM];   // px → m
function mapLabel(text, color, size = 0.6) {   // 自适应宽度的文字标签(白底墨字, 不被遮挡)
  const cv = document.createElement("canvas");
  const font = "bold 64px 'Cascadia Code', Consolas, monospace";
  const c0 = cv.getContext("2d"); c0.font = font;
  const tw = Math.max(64, Math.ceil(c0.measureText(text).width) + 28);
  cv.width = tw; cv.height = 96;
  const c = cv.getContext("2d");
  c.font = font; c.textAlign = "center"; c.textBaseline = "middle";
  c.fillStyle = "rgba(255,255,255,.92)"; c.fillRect(3, 13, tw - 6, 70);
  c.strokeStyle = "rgba(42,50,60,.45)"; c.lineWidth = 3; c.strokeRect(3, 13, tw - 6, 70);
  c.fillStyle = color; c.fillText(text, tw / 2, 50);
  const tex = new THREE.CanvasTexture(cv);
  tex.encoding = THREE.sRGBEncoding;      // 配合渲染器 sRGB 输出, 避免标签发灰
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sp.material.toneMapped = false;         // 标签是 UI 信息, 不参与 ACES 色调映射
  sp.renderOrder = 900;
  sp.scale.set(size * tw / 96, size, 1);
  return sp;
}
function m3dInit() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xe9ecef);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 3000);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.shadowMap.enabled = true;             // 软阴影: 体积感的关键
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.outputEncoding = THREE.sRGBEncoding;
  $("map3d").appendChild(renderer.domElement);
  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.495;
  renderer.domElement.addEventListener("mousemove", e => {   // 漫游转视角: 指针锁定, 或未锁定时按住左键拖动
    if (!walk.active) return;
    const locked = document.pointerLockElement === renderer.domElement;
    if (!locked && !(e.buttons & 1)) return;
    walk.yaw -= (e.movementX || 0) * 0.0026;
    walk.pitch = Math.min(1.1, Math.max(0.05, walk.pitch + (e.movementY || 0) * 0.0022));
  });
  // 三灯布光: 天光(冷) + 暖阳(投影) + 反向冷补光(无影), 替代旧的均质双灯
  scene.add(new THREE.HemisphereLight(0xe8f0fb, 0xb9b2a4, 0.52));
  const sun = new THREE.DirectionalLight(0xfff2dd, 1.18);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  scene.add(sun);
  scene.add(sun.target);
  const fill = new THREE.DirectionalLight(0xdde7f5, 0.42);
  fill.position.set(-14, 18, -10);
  scene.add(fill);
  try {                                   // 简易天光环境贴图: 金属件获得真实反射
    const pm = new THREE.PMREMGenerator(renderer);
    const envCv = document.createElement("canvas");
    envCv.width = 64; envCv.height = 32;
    const ec = envCv.getContext("2d");
    const g = ec.createLinearGradient(0, 0, 0, 32);
    g.addColorStop(0, "#cfe0f4"); g.addColorStop(0.55, "#eef1f4"); g.addColorStop(1, "#b8b2a4");
    ec.fillStyle = g; ec.fillRect(0, 0, 64, 32);
    const etex = new THREE.CanvasTexture(envCv);
    etex.mapping = THREE.EquirectangularReflectionMapping;
    etex.encoding = THREE.sRGBEncoding;
    scene.environment = pm.fromEquirectangular(etex).texture;
    etex.dispose(); pm.dispose();
  } catch (e) { /* 旧版 three 缺 PMREM 时静默跳过 */ }
  // 共享几何/材质: 单位盒 + 缩放, 重建场景时不释放
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  unitBox.userData.shared = true;
  const unitEdges = new THREE.EdgesGeometry(unitBox);
  unitEdges.userData.shared = true;
  const woodTex = (() => {   // 程序化木纹: 顺纹色条 + 细噪点, 桌面/门去塑料感
    const cv = document.createElement("canvas");
    cv.width = 256; cv.height = 256;
    const c = cv.getContext("2d");
    c.fillStyle = "#c8a06a"; c.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 46; i++) {          // 顺纹深浅条
      c.strokeStyle = `rgba(${120 + Math.random() * 40 | 0},${86 + Math.random() * 30 | 0},40,${0.10 + Math.random() * 0.16})`;
      c.lineWidth = 1 + Math.random() * 2.6;
      const y = Math.random() * 256;
      c.beginPath();
      c.moveTo(0, y);
      c.bezierCurveTo(85, y + (Math.random() * 9 - 4.5), 170, y + (Math.random() * 9 - 4.5), 256, y + (Math.random() * 7 - 3.5));
      c.stroke();
    }
    for (let i = 0; i < 900; i++) {         // 细噪点(木纹导管)
      c.fillStyle = `rgba(92,64,30,${Math.random() * 0.10})`;
      c.fillRect(Math.random() * 256, Math.random() * 256, 1.6, 1);
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.encoding = THREE.sRGBEncoding;
    tex.userData = { shared: true };
    return tex;
  })();
  const std = (color, opt) => new THREE.MeshStandardMaterial(Object.assign({ color, roughness: 0.8, metalness: 0.02, envMapIntensity: 0.35 }, opt));
  const mats = {
    wall: std(0xefeadf, { roughness: 0.94 }),          // 暖白乳胶漆墙(哑光)
    table: std(0xffffff, { map: woodTex, roughness: 0.5 }),   // 清漆木桌面(木纹)
    stair: std(0xb6bac1, { roughness: 0.96 }),         // 混凝土楼梯
    liftCol: std(0x97a0ab, { roughness: 0.35, metalness: 0.6, envMapIntensity: 0.9 }),
    liftSlab: std(0xdfe8f2, { transparent: true, opacity: 0.35, roughness: 0.15, metalness: 0.2 }),
    door: std(0xd8ac72, { map: woodTex, roughness: 0.55 }),   // 木门(木纹)
    plate: std(0xf4f2ee, { roughness: 0.9 }),
    frame: std(0xe7e3da, { roughness: 0.85 }),
    leg: std(0x6b5638, { roughness: 0.45, metalness: 0.25 }),       // 深色桌椅腿
    handle: std(0x9aa4af, { roughness: 0.3, metalness: 0.85, envMapIntensity: 0.9 }),  // 金属拉手
    chair: std(0x8d99ae, { roughness: 0.9 }),          // 布面座椅(哑光)
    antenna: std(0x2a323c, { roughness: 0.6 }),
    car: std(0xcfe0ee, { transparent: true, opacity: 0.3, roughness: 0.12, metalness: 0.15 }),  // 玻璃感轿厢
    slab: std(0xf2efe8, { roughness: 0.97 }),          // 米白楼板
    pt: std(0x0047ab, { roughness: 0.4 }),
    ptSel: std(0x0b6b2a, { roughness: 0.4 }),
    ptBusy: std(0xd97706, { roughness: 0.4 }),
    router: std(0x0284c7, { roughness: 0.55, envMapIntensity: 0.5 }),
    pole: std(0x9aa3ad, { roughness: 0.4, metalness: 0.5 }),
    edge: new THREE.LineBasicMaterial({ color: 0x3c4653, transparent: true, opacity: 0.16 }),
    edgeDark: new THREE.LineBasicMaterial({ color: 0x2a323c, transparent: true, opacity: 0.28 }),
    grayLine: new THREE.LineBasicMaterial({ color: 0x9aa3ad }),
    redLine: new THREE.LineBasicMaterial({ color: 0xb91c1c }),
  };
  Object.values(mats).forEach(m => m.userData = { shared: true });
  // 幽灵层材质: 非当前楼层半透明渲染, 突出正在编辑的楼层
  const gm = (color, op) => new THREE.MeshStandardMaterial(
    { color, transparent: true, opacity: op, depthWrite: false, roughness: 0.85, metalness: 0 });
  const gmats = {
    wall: gm(0xdfe3e8, 0.38), table: gm(0xc99a63, 0.38), stair: gm(0xcfd5dc, 0.38),
    liftCol: gm(0x9aa3ad, 0.42), liftSlab: gm(0xffffff, 0.2),
    door: gm(0xa8794e, 0.38), plate: gm(0xffffff, 0.22), frame: gm(0xf1f3f5, 0.4),
    chair: gm(0x8d99ae, 0.38),
    leg: gm(0x6b5638, 0.38), handle: gm(0x3c4653, 0.40), antenna: gm(0x2a323c, 0.40),
    antenna2: gm(0x2a323c, 0.40), car: gm(0xcfd5dc, 0.24), slab: gm(0xf7f8fa, 0.24),
    pt: gm(0x0047ab, 0.35), ptSel: gm(0x0b6b2a, 0.35), ptBusy: gm(0xd97706, 0.35),
    router: gm(0x0284c7, 0.35), pole: gm(0x9aa3ad, 0.30),
    edge: new THREE.LineBasicMaterial({ color: 0x9aa3ad, transparent: true, opacity: 0.25 }),
    edgeDark: new THREE.LineBasicMaterial({ color: 0x9aa3ad, transparent: true, opacity: 0.22 }),
    grayLine: new THREE.LineBasicMaterial({ color: 0xa9b4c0, transparent: true, opacity: 0.4 }),
    redLine: new THREE.LineBasicMaterial({ color: 0xb91c1c }),
  };
  Object.values(gmats).forEach(m => m.userData = { shared: true });
  const boxAt = (cx, cz, w, h, d, mat, y0 = 0) => {   // 放置一个缩放单位盒(底面 y0)
    const m = new THREE.Mesh(unitBox, mat);
    m.position.set(cx, y0 + h / 2, cz);
    m.scale.set(Math.max(w, 0.01), Math.max(h, 0.01), Math.max(d, 0.01));
    if (!mat.transparent) { m.castShadow = true; m.receiveShadow = true; }   // 幽灵层/玻璃不投影
    return m;
  };
  const boxWithEdges = (cx, cz, w, h, d, mat, y0 = 0, edgeMat = mats.edge) => {
    const g = new THREE.Group();
    g.add(boxAt(cx, cz, w, h, d, mat, y0));
    const e = new THREE.LineSegments(unitEdges, edgeMat);
    e.position.copy(g.children[0].position);
    e.scale.copy(g.children[0].scale);
    g.add(e);
    return g;
  };
  Object.assign(m3d, { scene, camera, renderer, controls, sun, unitBox, unitEdges, mats, gmats,
                       boxAt, boxWithEdges, content: null, fittedFor: null });
  const resize = () => {
    const w = $("map3dWrap").clientWidth, h = $("map3dWrap").clientHeight;
    if (!w || !h) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  };
  m3d.resize = resize;
  new ResizeObserver(resize).observe($("map3dWrap"));
  m3d.ready = true;
}
function m3dDispose(obj) {   // 释放重建时的旧对象(共享几何/材质除外)
  obj.traverse(o => {
    if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
    if (o.isSprite) { o.material.map && o.material.map.dispose(); o.material.dispose(); }
    else if (o.isMesh && o.material && !o.material.userData.shared) {
      if (o.material.map) o.material.map.dispose();
      o.material.dispose();
    }
  });
}
function floorExtentM(fd) {   // 单层内容的包围盒(米); 空层返回 null
  let x1 = Infinity, z1 = Infinity, x2 = -Infinity, z2 = -Infinity;
  const ext = (wx, wy) => {
    const [x, z] = m3(wx, wy);
    if (!isFinite(x) || !isFinite(z)) return;
    x1 = Math.min(x1, x); z1 = Math.min(z1, z); x2 = Math.max(x2, x); z2 = Math.max(z2, z);
  };
  for (const w of fd.walls || []) { ext(w.x1, w.y1); ext(w.x2, w.y2); }
  for (const t of fd.tables || []) { ext(t.x1, t.y1); ext(t.x2, t.y2); }
  for (const c of fd.chairs || []) { ext(c.x1, c.y1); ext(c.x2, c.y2); }
  for (const s of fd.stairs || []) { ext(s.x1, s.y1); ext(s.x2, s.y2); }
  for (const l of fd.lifts || []) { ext(l.x1, l.y1); ext(l.x2, l.y2); }
  for (const d of fd.doors || []) { ext(d.x1, d.y1); ext(d.x2, d.y2); }
  for (const r of fd.routers || []) ext(r.x, r.y);
  for (const p of fd.points || []) ext(p.x, p.y);
  if (!isFinite(x1)) return null;
  return { x1, z1, x2, z2, cx: (x1 + x2) / 2, cz: (z1 + z2) / 2, d: Math.max(x2 - x1, z2 - z1, 4) };
}
const liveFloorData = () => ({ points: mapPoints, walls, doors, tables, stairs, lifts, routers });
function m3dBBox() {         // 全部楼层内容的并集包围盒(米), 用于取景与栅格大小
  let x1 = Infinity, z1 = Infinity, x2 = -Infinity, z2 = -Infinity;
  if (mapHasImage && mapImgNatural[0]) {   // 底图属于整栋建筑(贴在最底层地面)
    const [ax, az] = m3(0, 0), [bx, bz] = m3(mapImgNatural[0], mapImgNatural[1]);
    x1 = Math.min(x1, ax); z1 = Math.min(z1, az); x2 = Math.max(x2, bx); z2 = Math.max(z2, bz);
  }
  for (const f of floors.length ? floors : [liveFloorData()]) {
    const fe = floorExtentM(f.id === curFloorId ? liveFloorData() : f);
    if (!fe) continue;
    x1 = Math.min(x1, fe.x1); z1 = Math.min(z1, fe.z1);
    x2 = Math.max(x2, fe.x2); z2 = Math.max(z2, fe.z2);
  }
  if (!isFinite(x1)) { x1 = -5; z1 = -5; x2 = 5; z2 = 5; }
  return { x1, z1, x2, z2, cx: (x1 + x2) / 2, cz: (z1 + z2) / 2,
           d: Math.max(x2 - x1, z2 - z1, 4) };
}
const m3dFitKey = () => (curMap ? curMap.id : "x") + "|" + floors.map(f => f.level).join(",");
function m3dBuild() {
  if (!m3d.ready) m3dInit();
  const { scene, mats, gmats, boxAt, boxWithEdges } = m3d;
  const g = new THREE.Group();
  m3d.wallMeshes = [];           // 墙体网格(含过梁, 带 level 标注), 供漫游相机防穿模
  const bb = m3dBBox();
  const pad = Math.max(1.5, bb.d * 0.08);
  const gz1 = bb.z1 - pad;
  const lvls = floors.length ? floors : [{ id: curFloorId, level: 0 }];
  const baseY = (floors.length ? floors[0].level : 0) * FLOOR_H;   // 最底层地面高度
  const topLv = floors.length ? floors[floors.length - 1].level : 0;
  // 地面与栅格(米格 + 每 5 米粗格), 铺在最底层地面; 低饱和浅灰栅格避免喧宾夺主
  const gsz = Math.max(Math.ceil(bb.x2 - bb.x1 + pad * 2), Math.ceil(bb.z2 - bb.z1 + pad * 2), 8);
  const gridC = new THREE.Group();
  const mkGrid = (size, step, c1, c2, y, op) => {
    const gr = new THREE.GridHelper(size, Math.round(size / step), c1, c2);
    gr.position.set(bb.cx, y, bb.cz);
    gr.material.transparent = true;
    gr.material.opacity = op;
    gr.geometry.userData = { shared: true };
    gr.material.userData = { shared: true };
    return gr;
  };
  gridC.add(mkGrid(gsz, 5, 0x9fb0c8, 0xbcc6d4, baseY + 0.03, 0.55));
  gridC.add(mkGrid(gsz, 1, 0xbcc6d4, 0xd6dde6, baseY + 0.02, 0.3));
  g.add(gridC);
  // 太阳随建筑取景: 低角度侧光(长投影), 阴影相机覆盖范围按包围盒伸缩
  {
    const spanY = (topLv - (floors.length ? floors[0].level : 0) + 1) * FLOOR_H;
    const R = Math.max(bb.d, spanY, 8);
    m3d.sun.position.set(bb.cx + R * 0.95, R * 0.5, bb.cz + R * 0.3);
    m3d.sun.target.position.set(bb.cx, baseY, bb.cz);
    const S = R * 0.78;
    Object.assign(m3d.sun.shadow.camera, { left: -S, right: S, top: S, bottom: -S, near: 0.5, far: R * 4 });
    m3d.sun.shadow.camera.updateProjectionMatrix();
  }
  // 底图图片贴地(上=北), 或暖灰实体地面(承接阴影)
  if (mapHasImage && mapImgNatural[0] && curMap) {
    const tex = new THREE.TextureLoader().load(`/api/maps/${curMap.id}/image?t=` + Date.now());
    tex.encoding = THREE.sRGBEncoding;
    const [iw, ih] = mapImgNatural;
    const w = iw / pxPerM, h = ih / pxPerM;
    const [cx, cz] = m3(iw / 2, ih / 2);
    const pl = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
      new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex,
                                       emissiveIntensity: 0.72, roughness: 0.95 }));
    pl.rotation.x = -Math.PI / 2;
    pl.position.set(cx, baseY, cz);
    pl.receiveShadow = true;
    g.add(pl);
  } else {
    const fp = new THREE.Mesh(new THREE.PlaneGeometry(gsz, gsz),
      new THREE.MeshStandardMaterial({ color: 0xe0ddd4, roughness: 1 }));
    fp.rotation.x = -Math.PI / 2;
    fp.position.set(bb.cx, baseY, bb.cz);
    fp.receiveShadow = true;
    g.add(fp);
  }
  // 北向箭头 + 原点红叉(在最层地面)
  const nz = gz1 - 0.2;
  g.add(new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1),
    new THREE.Vector3(bb.cx, baseY + 0.06, nz - 1.6), 1.6, 0x0b6b2a, 0.45, 0.25));
  const lblN = mapLabel("N", "#0b6b2a", 0.8);
  lblN.position.set(bb.cx, baseY + 0.5, nz - 4); g.add(lblN);
  const oc = 0.45;
  const oGe = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-oc, baseY + 0.05, 0), new THREE.Vector3(oc, baseY + 0.05, 0),
    new THREE.Vector3(0, baseY + 0.05, -oc), new THREE.Vector3(0, baseY + 0.05, oc)]);
  oGe.userData.shared = true;
  g.add(new THREE.LineSegments(oGe, mats.redLine));
  const lblO = mapLabel("(0,0)", "#b91c1c", 0.55);
  lblO.position.set(0, baseY + 0.45, 0); g.add(lblO);

  /* ---- 单层内容: active 层实体, 其余幽灵半透明 ---- */
  const floorShapes = (fd, y0, active) => {
    const M = active ? mats : gmats;
    const fe = floorExtentM(fd);
    // 楼板(该层地面, 板厚 0.12): 有内容的层才铺板
    if (fe) {
      const sw = fe.x2 - fe.x1 + 0.6, sd = fe.z2 - fe.z1 + 0.6;
      const slab = boxAt(fe.cx, fe.cz, sw, 0.12, sd, M.slab, y0 - 0.12);
      g.add(slab);
    }
    // 墙: 拉伸出 2.8 m 实体; 墙上的门洞按门跨扣开(上方做过梁), 出入口真实可通行
    const levelOfWall = Math.round(y0 / FLOOR_H);
    for (const w of fd.walls || []) {
      let x = Math.min(w.x1, w.x2), y = Math.min(w.y1, w.y2);
      let ww = Math.abs(w.x2 - w.x1), hh = Math.abs(w.y2 - w.y1);
      if (ww < 0.5) { x -= wallThick / 2; ww = wallThick; }
      if (hh < 0.5) { y -= wallThick / 2; hh = wallThick; }
      const horiz = ww >= hh;
      const addWallBox = (ax1, ay1, ax2, ay2) => {
        const [mcx, mcz] = m3((ax1 + ax2) / 2, (ay1 + ay2) / 2);
        const grp = boxWithEdges(mcx, mcz, (ax2 - ax1) / pxPerM, M_WALL_H, (ay2 - ay1) / pxPerM, M.wall, y0, M.edge);
        grp.children[0].userData.level = levelOfWall;
        m3d.wallMeshes.push(grp.children[0]);
        g.add(grp);
      };
      // 找出落在这道墙上的门跨(沿墙长轴投影, 门中线在墙厚范围内)
      const spans = [];
      for (const d of fd.doors || []) {
        const dmin = horiz ? Math.min(d.x1, d.x2) : Math.min(d.y1, d.y2);
        const dmax = horiz ? Math.max(d.x1, d.x2) : Math.max(d.y1, d.y2);
        const dperp = horiz ? (d.y1 + d.y2) / 2 : (d.x1 + d.x2) / 2;
        const wmin = horiz ? x : y, wmax = horiz ? x + ww : y + hh;
        const pmin = horiz ? y : x, pmax = horiz ? y + hh : x + ww;
        if (dmax > wmin + 1 && dmin < wmax - 1 && dperp >= pmin - wallThick && dperp <= pmax + wallThick)
          spans.push([Math.max(dmin, wmin), Math.min(dmax, wmax)]);
      }
      if (!spans.length) { addWallBox(x, y, x + ww, y + hh); continue; }
      spans.sort((a, b) => a[0] - b[0]);
      let cur = horiz ? x : y;
      const end = horiz ? x + ww : y + hh;
      for (const [s1, s2] of spans) {
        if (s1 > cur + 1)
          horiz ? addWallBox(x, y, s1, y + hh) : addWallBox(x, y, x + ww, s1);
        const [lx1, ly1] = horiz ? [s1, y] : [x, s1];       // 门洞过梁(门高→墙高)
        const [lx2, ly2] = horiz ? [s2, y + hh] : [x + ww, s2];
        const [lcx, lcz] = m3((lx1 + lx2) / 2, (ly1 + ly2) / 2);
        const lintel = boxAt(lcx, lcz, (lx2 - lx1) / pxPerM, M_WALL_H - M_DOOR_H,
                             (ly2 - ly1) / pxPerM, M.wall, y0 + M_DOOR_H);
        lintel.userData.level = levelOfWall;
        m3d.wallMeshes.push(lintel);
        g.add(lintel);
        cur = s2;
      }
      if (end > cur + 1)
        horiz ? addWallBox(cur, y, x + ww, y + hh) : addWallBox(x, cur, x + ww, y + hh);
    }
    // 桌: 桌面(厚 5cm, 顶面 0.75m) + 四条方桌腿
    for (const t of fd.tables || []) {
      const x = Math.min(t.x1, t.x2), y = Math.min(t.y1, t.y2);
      const w = Math.abs(t.x2 - t.x1), hh = Math.abs(t.y2 - t.y1);
      const [cx, cz] = m3(x + w / 2, y + hh / 2);
      const wm = Math.max(w / pxPerM, 0.2), dm = Math.max(hh / pxPerM, 0.2);
      g.add(boxWithEdges(cx, cz, wm, 0.05, dm, M.table, y0 + 0.70, M.edgeDark));
      const ix = Math.min(0.10, wm * 0.18), iz = Math.min(0.10, dm * 0.18);
      for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]])
        g.add(boxAt(cx + sx * (wm / 2 - ix - 0.03), cz + sz * (dm / 2 - iz - 0.03),
          0.06, 0.70, 0.06, M.leg, y0));
    }
    // 座椅: 座面板 + 四腿 + 靠背(座面 0.45m, 靠背顶 0.90m)
    for (const c of fd.chairs || []) {
      const x = Math.min(c.x1, c.x2), y = Math.min(c.y1, c.y2);
      const w = Math.abs(c.x2 - c.x1), hh = Math.abs(c.y2 - c.y1);
      const [cx, cz] = m3(x + w / 2, y + hh / 2);
      const wm = Math.max(w / pxPerM, 0.2), dm = Math.max(hh / pxPerM, 0.2);
      g.add(boxAt(cx, cz, wm, 0.05, dm, M.chair, y0 + 0.42));
      for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]])
        g.add(boxAt(cx + sx * (wm / 2 - 0.045), cz + sz * (dm / 2 - 0.045),
          0.035, 0.42, 0.035, M.leg, y0));
      const bw = Math.max(0.06, Math.min(wm, dm) * 0.22);   // 靠背: 沿 dir 边立起
      const bk = c.dir === 0
        ? boxAt(cx, cz - dm / 2 + bw / 2, wm, 0.43, bw, M.chair, y0 + 0.47)
        : c.dir === 1 ? boxAt(cx + wm / 2 - bw / 2, cz, bw, 0.43, dm, M.chair, y0 + 0.47)
        : c.dir === 2 ? boxAt(cx, cz + dm / 2 - bw / 2, wm, 0.43, bw, M.chair, y0 + 0.47)
        : boxAt(cx - wm / 2 + bw / 2, cz, bw, 0.43, dm, M.chair, y0 + 0.47);
      g.add(bk);
    }
    // 楼梯: 沿上行方向逐级升高, 总升高 = 一整层(3D 中贯通到上一层楼面)
    for (const st of fd.stairs || []) {
      const x = Math.min(st.x1, st.x2), y = Math.min(st.y1, st.y2);
      const w = Math.abs(st.x2 - st.x1), hh = Math.abs(st.y2 - st.y1);
      const horiz = w >= hh;
      const lenM = (horiz ? w : hh) / pxPerM, widM = (horiz ? hh : w) / pxPerM;
      const n = Math.max(2, Math.min(24, Math.round(lenM / M_STEP_RUN)));
      const run = lenM / n, rise = FLOOR_H / n;
      const sgn = st.dir ? -1 : 1;               // dir=1 上行指向长轴负端
      const [scx, scz] = m3(x + w / 2, y + hh / 2);
      for (let k = 0; k < n; k++) {
        const off = (lenM / 2 - run * (k + 0.5)) * sgn;
        g.add(horiz
          ? boxAt(scx + off, scz, run, rise * (k + 1), widM, M.stair, y0)
          : boxAt(scx, scz + off, widM, rise * (k + 1), run, M.stair, y0));
      }
      if (active) {   // 地面行进箭头 + 顶端「上」标(幽灵层省略)
        const dir3 = new THREE.Vector3(horiz ? sgn : 0, 0, horiz ? 0 : sgn);
        const aSt = new THREE.Vector3(scx, y0 + 0.06, scz).addScaledVector(dir3, -lenM / 2 + 0.3);
        g.add(new THREE.ArrowHelper(dir3, aSt, Math.min(lenM * 0.45, 1.6), 0xb45309, 0.3, 0.18));
        const lblU = mapLabel("上", "#b45309", 0.55);
        lblU.position.set(scx + dir3.x * (lenM / 2 + 0.35), y0 + FLOOR_H + 0.5, scz + dir3.z * (lenM / 2 + 0.35));
        g.add(lblU);
      }
    }
    // 电梯: 四角井柱 + 半透明顶板 + 地面交叉线 + 层门 + 半透明轿厢
    for (const lf of fd.lifts || []) {
      const x = Math.min(lf.x1, lf.x2), y = Math.min(lf.y1, lf.y2);
      const w = Math.abs(lf.x2 - lf.x1), hh = Math.abs(lf.y2 - lf.y1);
      const [cx, cz] = m3(x + w / 2, y + hh / 2);
      const wm = Math.max(w / pxPerM, 0.4), hm = Math.max(hh / pxPerM, 0.4), col = 0.12;
      for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]])
        g.add(boxAt(cx + sx * (wm / 2 - col / 2), cz + sz * (hm / 2 - col / 2),
          col, M_WALL_H, col, M.liftCol, y0));
      g.add(boxAt(cx, cz, wm, 0.1, hm, M.liftSlab, y0 + M_WALL_H));
      g.add(boxAt(cx, cz, Math.max(wm - 0.34, 0.1), 2.2, Math.max(hm - 0.34, 0.1), M.car, y0 + 0.02));
      const xg = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(cx - wm / 2, y0 + 0.05, cz - hm / 2), new THREE.Vector3(cx + wm / 2, y0 + 0.05, cz + hm / 2),
        new THREE.Vector3(cx + wm / 2, y0 + 0.05, cz - hm / 2), new THREE.Vector3(cx - wm / 2, y0 + 0.05, cz + hm / 2)]);
      g.add(new THREE.LineSegments(xg, M.grayLine));
      const dw = wm * 0.42;                       // 层门两扇(南侧)
      g.add(boxAt(cx - wm * 0.21, cz + hm / 2 + 0.03, dw, M_DOOR_H, 0.06, M.door, y0));
      g.add(boxAt(cx + wm * 0.21, cz + hm / 2 + 0.03, dw, M_DOOR_H, 0.06, M.door, y0));
    }
    // 门: 门框(两竖框+顶横框) + 白色门槛板 + 立起的门叶(开 90°)+ 门把 + 开启弧线
    for (const d of fd.doors || []) {
      const flip = d.flip ? -1 : 1, hingeA = !d.hinge;
      const [hx, hz] = m3(hingeA ? d.x1 : d.x2, hingeA ? d.y1 : d.y2);
      const [ox, oz] = m3(hingeA ? d.x2 : d.x1, hingeA ? d.y2 : d.y1);
      const [cx2, cz2] = [hx - (oz - hz) * flip, hz + (ox - hx) * flip];
      const r = Math.hypot(ox - hx, oz - hz);
      const mx = (hx + ox) / 2, mz = (hz + oz) / 2;
      const dx = ox - hx, dz = oz - hz, dl = Math.hypot(dx, dz) || 1;
      const ux = dx / dl, uz = dz / dl;           // 门洞方向单位向量
      const th = Math.max(wallThick / pxPerM, 0.12);
      const rot = -Math.atan2(uz, ux);
      const plate = boxAt(mx, mz, dl, 0.04, th, M.plate, y0);   // 门槛(白)
      plate.rotation.y = rot;
      g.add(plate);
      const fw = 0.07, fh = M_DOOR_H + 0.10;                    // 门框
      for (const [jx, jz] of [[hx, hz], [ox, oz]]) {
        const jb = boxAt(jx, jz, fw, fh, th + 0.06, M.frame, y0);
        jb.rotation.y = rot;
        g.add(jb);
      }
      const lintel = boxAt(mx, mz, dl + fw * 2, 0.10, th + 0.06, M.frame, y0 + fh);
      lintel.rotation.y = rot;
      g.add(lintel);
      const ldx = cx2 - hx, ldz = cz2 - hz;                     // 门叶(开 90°)
      const ll = Math.hypot(ldx, ldz) || 1;
      const leaf = boxAt((hx + cx2) / 2, (hz + cz2) / 2, ll, M_DOOR_H, 0.05, M.door, y0);
      leaf.rotation.y = -Math.atan2(ldz, ldx);
      g.add(leaf);
      if (active) {                                             // 竖条门把(靠自由端)
        const hd = boxAt(hx + ldx / ll * (ll - 0.16), hz + ldz / ll * (ll - 0.16),
          0.05, 0.18, 0.05, M.handle, y0 + 0.92);
        hd.rotation.y = leaf.rotation.y;
        g.add(hd);
      }
      const pts = [];                                           // 90° 开启弧
      const a0 = Math.atan2(oz - hz, ox - hx), a1 = Math.atan2(cz2 - hz, cx2 - hx);
      for (let k = 0; k <= 16; k++) {
        const a = a0 + (a1 - a0) * k / 16;
        pts.push(new THREE.Vector3(hx + Math.cos(a) * r, y0 + 0.05, hz + Math.sin(a) * r));
      }
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), M.grayLine));
    }
    // 路由器(AP): 悬挂式设备(可设 z 高度, 无落地杆) + 地面定位环
    for (const rt of fd.routers || []) {
      const [cx, cz] = m3(rt.x, rt.y);
      const rz = Math.min(6, Math.max(0.1, +rt.z || 2.5));
      const dev = new THREE.Group();
      dev.position.set(cx, y0 + rz, cz);
      const body = new THREE.Mesh(m3d.unitBox, M.router);
      body.scale.set(0.30, 0.07, 0.30);
      const be = new THREE.LineSegments(m3d.unitEdges, M.edgeDark);
      be.scale.copy(body.scale);
      dev.add(body, be);
      for (const sx of [-1, 1]) {   // 双天线(斜立)
        const ant = new THREE.Mesh(m3d.unitBox, M.antenna);
        ant.scale.set(0.022, 0.24, 0.022);
        ant.position.set(sx * 0.11, 0.14, 0);
        ant.rotation.z = -sx * 0.38;
        dev.add(ant);
      }
      g.add(dev);
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.10, 0.16, 24),   // 地面定位环
        new THREE.MeshBasicMaterial({ color: 0x0284c7, transparent: true,
          opacity: active ? 0.55 : 0.22, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(cx, y0 + 0.06, cz);
      g.add(ring);
      if (active) {
        const lblR = mapLabel("AP " + rz.toFixed(1) + "m", "#0284c7", 0.42);
        lblR.position.set(cx, y0 + rz + 0.32, cz);
        g.add(lblR);
      }
    }
    // 测点: 蓝柱(选中绿/采集中琥珀) + 名称标签(仅当前层显示标签)
    for (const p of fd.points || []) {
      const [cx, cz] = m3(p.x, p.y);
      const sel = active && p.id === selPointId;
      const pm = p.collecting ? M.ptBusy : sel ? M.ptSel : M.pt;
      g.add(boxAt(cx, cz, 0.26, 0.14, 0.26, pm, y0 + 0.02));
      if (active) {
        const lbl = mapLabel(p.name, sel ? "#0b6b2a" : "#0047ab", 0.5);
        lbl.position.set(cx, y0 + 0.55, cz);
        g.add(lbl);
      }
    }
  };
  for (const f of lvls) {
    const y0 = f.level * FLOOR_H;
    const active = f.id === curFloorId || !floors.length;
    floorShapes(f.id === curFloorId || !floors.length ? liveFloorData() : f, y0, active);
    // 楼层名标签(建筑左上角逐层标注)
    const lblF = mapLabel(floors.length ? f.name : "1F",
      active ? "#0047ab" : "#7a8494", 0.7);
    lblF.position.set(bb.x1 - 0.9, y0 + FLOOR_H * 0.55, bb.z1 - 0.9);
    g.add(lblF);
  }
  if (m3d.content) { m3dDispose(m3d.content); scene.remove(m3d.content); }
  scene.add(g);
  m3d.content = g;
  const spanY = (topLv - (floors.length ? floors[0].level : 0) + 1) * FLOOR_H;
  scene.fog = new THREE.Fog(0xe9ecef, Math.max(bb.d, spanY) * 3.2, Math.max(bb.d, spanY) * 10);
  if (m3d.fittedFor !== m3dFitKey()) m3dFit(bb);   // 换图/增删楼层自动取景; 同结构不重置视角
}
function m3dFit(bb) {
  bb = bb || m3dBBox();
  const { camera, controls } = m3d;
  const minLv = floors.length ? floors[0].level : 0;
  const spanY = (floors.length ? floors[floors.length - 1].level - minLv + 1 : 1) * FLOOR_H;
  controls.target.set(bb.cx, minLv * FLOOR_H + spanY / 2, bb.cz);
  const d = Math.max(bb.d, spanY, 4);
  camera.position.set(bb.cx + d * 0.62, minLv * FLOOR_H + spanY * 0.95, bb.cz + d * 0.85);
  controls.minDistance = 1;
  controls.maxDistance = d * 8;
  m3d.fittedFor = m3dFitKey();
  controls.update();
}
let m3dNeedsBuild = false;
function map3dTouch() { m3dNeedsBuild = true; }   // 数据变化时标记, 帧循环内统一重建
let m3dLastT = performance.now();
(function animateMap3d() {
  requestAnimationFrame(animateMap3d);
  const now = performance.now();
  const dt = Math.min(0.05, (now - m3dLastT) / 1000);
  m3dLastT = now;
  if (!view3d || !m3d.ready) return;
  if (m3dNeedsBuild) { m3dNeedsBuild = false; m3dBuild(); }
  if (walk.active) walkStep(dt);     // 漫游模式接管相机
  else m3d.controls.update();
  m3d.renderer.render(m3d.scene, m3d.camera);
})();
function set3dView(on) {
  if (on && !curMap) { alert("请先打开地图"); return; }
  if (!on && walk.active) walkExit();   // 返回二维时先退出漫游
  view3d = on;
  $("map3dWrap").style.display = on ? "block" : "none";
  $("mapStage").style.display = on ? "none" : "block";
  const b = $("btn3dView");
  b.textContent = on ? "返回二维编辑" : "三维视角";
  b.classList.toggle("activeTool", on);
  b.classList.toggle("primary", !on);
  if (on) { m3dBuild(); m3d.resize(); }
}
$("btn3dView").onclick = () => { if (walk.active) walkExit(); set3dView(!view3d); };
window.addEventListener("keydown", e => {        // Esc: 漫游→三维→二维, 逐级退出
  if (e.key === "Escape" && view3d && !walk.active) set3dView(false);
});
