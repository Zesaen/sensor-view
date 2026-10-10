// 多楼层 + 家具精化端到端测试
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { writeFileSync } from "node:fs";
const CHROME = "/home/ubuntu/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell";
const BASE = "http://127.0.0.1:8888";
const proc = spawn(CHROME, ["--remote-debugging-port=9517", "--no-sandbox", "--disable-gpu",
  "--window-size=1600,1000", "about:blank"], { stdio: "ignore" });
process.on("exit", () => proc.kill());
let ws, msgId = 0; const pending = new Map(); const errs = [];
async function cdp(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => { pending.set(id, { res, rej });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error("timeout " + method)); } }, 15000); });
}
const evalJs = async expr => {
  const r = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.result.value;
};
for (let i = 0; i < 40; i++) { try { await fetch("http://127.0.0.1:9517/json/version"); break; } catch { await sleep(200); } }
const page = (await (await fetch("http://127.0.0.1:9517/json/list")).json()).find(p => p.type === "page");
ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
ws.addEventListener("message", m => { const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id).res(d); pending.delete(d.id); }
  if (d.method === "Runtime.exceptionThrown") errs.push(JSON.stringify(d.params.exceptionDetails).slice(0, 300));
  if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") errs.push(d.params.args.map(a => a.value).join(" ")); });
await cdp("Page.enable"); await cdp("Runtime.enable");
// confirm 弹窗自动接受
ws.addEventListener("message", m => { const d = JSON.parse(m.data);
  if (d.method === "Page.javascriptDialogOpening")
    cdp("Page.handleJavaScriptDialog", { accept: true }).catch(() => {}); });
await cdp("Page.navigate", { url: BASE });
await sleep(1500);
const results = [];
const check = (name, ok, extra = "") => { results.push({ name, ok });
  console.log((ok ? "PASS" : "FAIL") + " | " + name + (extra ? " | " + extra : "")); };
async function clickSel(sel) {
  const c = await evalJs(`(() => { const e = document.querySelector('${sel}'); if (!e) return null;
    e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  if (!c) throw new Error("no element " + sel);
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: c[0], y: c[1], button: "left", clickCount: 1 });
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: c[0], y: c[1], button: "left", clickCount: 1 });
  await sleep(350);
}
async function shot(name) {
  const r = await cdp("Page.captureScreenshot", { format: "png" });
  writeFileSync(`/tmp/${name}.png`, Buffer.from(r.result.data, "base64"));
}

await evalJs("document.querySelector('#cardGrid .mapCard').click()");
await sleep(1200);

// 构造丰富一层场景
await evalJs(`(() => {
  walls = [
    { x1: 200, y1: 150, x2: 200, y2: 550 },
    { x1: 200, y1: 550, x2: 900, y2: 550 },
    { x1: 900, y1: 150, x2: 900, y2: 550 },
    { x1: 200, y1: 150, x2: 900, y2: 150 },
  ];
  doors = [
    { x1: 480, y1: 550, x2: 580, y2: 550 },
    { x1: 200, y1: 280, x2: 200, y2: 360, flip: 1 },
  ];
  tables = [ { x1: 320, y1: 230, x2: 470, y2: 340 }, { x1: 320, y1: 390, x2: 470, y2: 500 } ];
  stairs = [ { x1: 600, y1: 230, x2: 860, y2: 330, dir: 0 } ];
  lifts = [ { x1: 600, y1: 390, x2: 730, y2: 510 } ];
  routers = [ { x: 850, y: 190 } ];
  origin = { x: 200, y: 550 };
  mapPoints = [
    { id: "fa", name: "P1", x: 400, y: 450, nImu: 10, nWifi: 3, roundsDone: 0, imuSamples: [], wifiScans: [] },
    { id: "fb", name: "P2", x: 520, y: 300, nImu: 10, nWifi: 3, roundsDone: 0, imuSamples: [], wifiScans: [] },
  ];
  syncFloorRefs(); persist(); renderDrawings(); renderMarkers(); renderPtList();
})()`);
await sleep(900);
check("初始为单层 1F", await evalJs("floors.length") === 1 && await evalJs("floors[0].name") === "1F",
  await evalJs("JSON.stringify(floors.map(f=>[f.id,f.name,f.level]))"));

// 新建上层
await clickSel("#btnFloorUp");
await sleep(500);
// addFloor 弹 msgDlg 信息框 → 关闭
await evalJs("document.querySelector('#msgDlgOk') && document.querySelector('#msgDlgOk').click()");
await sleep(400);
check("＋上层新建 2F(当前层切换)", await evalJs("floors.length") === 2 &&
  await evalJs("curFloor().name") === "2F" && await evalJs("curFloor().level") === 1);
check("2F 布局复制自 1F(墙4/门2/桌2/梯1/电梯1)", await evalJs(
  "curFloor().walls.length === 4 && curFloor().doors.length === 2 && curFloor().tables.length === 2 && curFloor().stairs.length === 1 && curFloor().lifts.length === 1"));
check("2F 不复制测点", (await evalJs("curFloor().points.length")) === 0);
check("楼层条显示两个标签", await evalJs("document.querySelectorAll('#floorChips .fChip').length") === 2);

// 在 2F 上改: 删一面墙 + 加一测点 → 只影响 2F
await evalJs(`(() => { const f = curFloor(); f.walls.pop(); syncFloorRefs(); persist(); renderDrawings(); })()`);
await sleep(700);
check("2F 删墙后 walls=3", await evalJs("walls.length") === 3);
// 切回 1F
await evalJs(`(() => { const f1 = floors.find(f => f.level === 0);
  document.querySelectorAll('#floorChips .fChip').forEach(el => { if (el.dataset.id === f1.id) el.click(); }); })()`);
await sleep(500);
check("切回 1F: 墙仍是 4, 测点 2 个", await evalJs("walls.length") === 4 && await evalJs("mapPoints.length") === 2);

// 持久化验证
await sleep(900);
const mid = await evalJs("curMap.id");
const saved = await (await fetch(`${BASE}/api/maps/${mid}/data`)).json();
check("服务器保存 floors=2 层且 1F 墙 4 / 2F 墙 3", saved.data.floors && saved.data.floors.length === 2 &&
  saved.data.floors.every(f => f.walls.length === (f.level === 0 ? 4 : 3)),
  JSON.stringify((saved.data.floors || []).map(f => [f.name, f.walls.length])));

// 刷新页面 → 楼层保持
await cdp("Page.navigate", { url: `${BASE}/?r=${Date.now()}` });
await sleep(1600);
await evalJs("document.querySelector('#cardGrid .mapCard').click()");
await sleep(1300);
check("刷新后楼层仍在(2 层, 当前层恢复)", await evalJs("floors.length") === 2 &&
  ["1F", "2F"].includes(await evalJs("curFloor().name")));

// 3D 多层渲染
await evalJs(`(() => { const f2 = floors.find(f => f.level === 1);
  document.querySelectorAll('#floorChips .fChip').forEach(el => { if (el.dataset.id === f2.id) el.click(); }); })()`);
await sleep(500);
await evalJs("set3dView(true)");
await sleep(2600);
await shot("mf-3d-2f-active");
// 切回 1F 为实体层
await evalJs(`(() => { const f1 = floors.find(f => f.level === 0);
  document.querySelectorAll('#floorChips .fChip').forEach(el => { if (el.dataset.id === f1.id) el.click(); }); })()`);
await sleep(1800);
await shot("mf-3d-1f-active");
check("3D 内容构建无报错", errs.length === 0, errs.join("; ").slice(0, 200));

// 删除 2F
await evalJs(`(() => { const f2 = floors.find(f => f.level === 1);
  document.querySelectorAll('#floorChips .fChip .fx').forEach(el => { if (el.dataset.id === f2.id) el.click(); }); })()`);
await sleep(600);
check("删除 2F 后回到单层", await evalJs("floors.length") === 1 && await evalJs("curFloor().name") === "1F");
await sleep(800);

console.log("\nconsole errors:", errs.length ? errs : "(无)");
const fails = results.filter(r => !r.ok).length;
console.log(`\n==== ${results.length - fails}/${results.length} passed ====`);
proc.kill();
process.exit(fails ? 1 : 0);
