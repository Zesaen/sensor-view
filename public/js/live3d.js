// 实时监控 3D 场景(设备姿态盒子/罗盘, 加载即启动)
/* ================= Three.js 3D 场景 ================= */
/* 坐标约定:
   世界: Y 上, -Z 北(磁北), +X 东; 1 单位 = 1 cm
   机体系(FRD): X 前, Y 右, Z 下 (与 mag 数据一致)
   姿态: yaw 绕天轴 — 逆时针为正(实测板子顺时针转时 yaw 减小, 模型同向:
         rotation.y 直接取 +yaw, 板子顺时针转模型也顺时针转),
         pitch 抬头为正, roll 右倾为正 */
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf2f4f6);
scene.fog = new THREE.Fog(0xf2f4f6, 90, 220);

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
camera.position.set(26, 22, 36);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio || 1);
$("scene").appendChild(renderer.domElement);

const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.target.set(0, 2, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.495;
controls.minDistance = 12;
controls.maxDistance = 160;

scene.add(new THREE.HemisphereLight(0xffffff, 0xc9ced6, 1.0));
const sun = new THREE.DirectionalLight(0xffffff, 0.9);
sun.position.set(18, 30, 12);
scene.add(sun);

/* 地面: 蓝色坐标纸(与 2D 地图同款双层网格) + 罗盘 */
const grid2 = new THREE.GridHelper(80, 8, 0x0047ab, 0xa9bcdc);   // 粗格(每 10 单位)
grid2.position.y = -0.03;
scene.add(grid2);
const grid = new THREE.GridHelper(80, 40, 0x0047ab, 0xdde5f2);   // 细格(每 2 单位)
grid.position.y = -0.02;
scene.add(grid);

function textSprite(text, color, size = 3) {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 128;
  const c = cv.getContext("2d");
  c.font = "bold 84px 'Cascadia Code', Consolas, monospace"; c.textAlign = "center"; c.textBaseline = "middle";
  c.fillStyle = color; c.fillText(text, 64, 70);
  const tex = new THREE.CanvasTexture(cv);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
  sp.scale.set(size, size, 1);
  return sp;
}
const R = 22;
const north = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0.05, 0), R, 0x0b6b2a, 2.4, 1.4);
scene.add(north);
const lblN = textSprite("N", "#0b6b2a", 4); lblN.position.set(0, 0.5, -R - 3.4); scene.add(lblN);
const lblE = textSprite("E", "#3c4653", 3.4); lblE.position.set(R + 2.8, 0.5, 0); scene.add(lblE);
const lblS = textSprite("S", "#3c4653", 3.4); lblS.position.set(0, 0.5, R + 2.8); scene.add(lblS);
const lblW = textSprite("W", "#3c4653", 3.4); lblW.position.set(-R - 2.8, 0.5, 0); scene.add(lblW);

/* 设备模型: 父组承载姿态欧拉角, 子组为机体系(FRD)固定映射 */
const attitudeGroup = new THREE.Group();
scene.add(attitudeGroup);
const bodyGroup = new THREE.Group();
// FRD -> 世界(机头朝北): X前->-Z, Y右->+X, Z下->-Y
bodyGroup.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(
  new THREE.Vector3(0, 0, -1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, -1, 0)));
attitudeGroup.add(bodyGroup);

// 10x10x3: 机体系 X 前 10, Y 右 10, Z 厚 3; 顶面丝印 = 仪器铭牌(白底蓝格图纸风)
const screenTex = (() => {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 256;
  const c = cv.getContext("2d");
  c.fillStyle = "#ffffff"; c.fillRect(0, 0, 256, 256);
  c.strokeStyle = "rgba(0,71,171,.16)"; c.lineWidth = 1.5;
  for (let i = 32; i < 256; i += 32) {
    c.beginPath(); c.moveTo(i, 0); c.lineTo(i, 256); c.stroke();
    c.beginPath(); c.moveTo(0, i); c.lineTo(256, i); c.stroke();
  }
  c.strokeStyle = "#0047ab"; c.lineWidth = 5; c.strokeRect(9, 9, 238, 238);
  c.lineWidth = 1.5; c.strokeRect(22, 22, 212, 212);
  c.fillStyle = "#101317"; c.textAlign = "center";
  c.font = "bold 52px 'Cascadia Code', Consolas, monospace";
  c.fillText("IMU", 128, 118);
  c.font = "bold 26px 'Cascadia Code', Consolas, monospace";
  c.fillStyle = "#0047ab"; c.fillText("NODE · FRD", 128, 162);
  c.strokeStyle = "#101317"; c.lineWidth = 2;                  // 中心十字标线
  c.beginPath(); c.moveTo(116, 128); c.lineTo(140, 128); c.moveTo(128, 116); c.lineTo(128, 140); c.stroke();
  return new THREE.CanvasTexture(cv);
})();

const faceMat = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.05 });
const screenMat = new THREE.MeshStandardMaterial({ map: screenTex, roughness: 0.4, metalness: 0.05 });
// BoxGeometry 材质顺序: +x, -x, +y, -y, +z, -z ; 机体系 -Z 为顶面
const box = new THREE.Mesh(
  new THREE.BoxGeometry(10, 10, 3),
  [faceMat(0xe4e7ec), faceMat(0xe4e7ec), faceMat(0xd9dee4), faceMat(0xd9dee4),
   faceMat(0xcfd5dc), screenMat]
);
bodyGroup.add(box);
bodyGroup.add(new THREE.LineSegments(
  new THREE.EdgesGeometry(box.geometry),
  new THREE.LineBasicMaterial({ color: 0x16181d, transparent: true, opacity: 0.9 })
));

// 机头指示(深琥珀锥, 指向机体系 +X)
const nose = new THREE.Mesh(
  new THREE.ConeGeometry(1.1, 2.6, 4),
  new THREE.MeshStandardMaterial({ color: 0xb45309, emissive: 0x3a2404, roughness: 0.4 })
);
nose.rotation.z = -Math.PI / 2;
nose.position.set(4.1, 0, -1.6);
bodyGroup.add(nose);

// 磁场箭头(机体系, 随设备一起转); 关闭深度测试使其穿过盒体可见
const magArrow = new THREE.ArrowHelper(
  new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0), 12, 0xb91c1c, 1.8, 1.0);
magArrow.line.material.depthTest = false;
magArrow.cone.material.depthTest = false;
magArrow.line.renderOrder = 999;
magArrow.cone.renderOrder = 999;
bodyGroup.add(magArrow);
const magOrigin = new THREE.Mesh(
  new THREE.SphereGeometry(0.55, 12, 12),
  new THREE.MeshBasicMaterial({ color: 0xb91c1c, depthTest: false }));
magOrigin.renderOrder = 999;
bodyGroup.add(magOrigin);

/* 自适应尺寸 */
function resize() {
  const wrap = $("sceneWrap");
  const w = wrap.clientWidth, h = wrap.clientHeight;
  if (!w || !h) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
new ResizeObserver(resize).observe($("sceneWrap"));
resize();

/* 姿态平滑(含 yaw 环绕) */
function lerpAngle(a, b, t) {
  const d = ((b - a + 540) % 360) - 180;
  return a + d * t;
}
function animate() {
  requestAnimationFrame(animate);
  cur.yaw = lerpAngle(cur.yaw, tgt.yaw, 0.18);
  cur.pitch += (tgt.pitch - cur.pitch) * 0.18;
  cur.roll += (tgt.roll - cur.roll) * 0.18;
  attitudeGroup.rotation.set(
    THREE.MathUtils.degToRad(cur.pitch),
    THREE.MathUtils.degToRad(cur.yaw),
    THREE.MathUtils.degToRad(-cur.roll),
    "YXZ");
  const m = tgt.mag, mag = Math.hypot(m[0], m[1], m[2]);
  if (mag > 0.01) {
    magArrow.setDirection(new THREE.Vector3(m[0], m[1], m[2]).normalize());
    magArrow.setLength(Math.min(16, Math.max(3, mag * 0.35)), 1.9, 1.1);
  }
  controls.update();
  renderer.render(scene, camera);
}
animate();
