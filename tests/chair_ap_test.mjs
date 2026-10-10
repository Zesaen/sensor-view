// 座椅/AP 高度功能测试 + 教学楼示范建筑截图
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { writeFileSync } from "node:fs";
const CHROME = "/home/ubuntu/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell";
const BASE = "http://127.0.0.1:8888";
const proc = spawn(CHROME, ["--remote-debugging-port=9519", "--no-sandbox", "--disable-gpu",
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
for (let i = 0; i < 40; i++) { try { await fetch("http://127.0.0.1:9519/json/version"); break; } catch { await sleep(200); } }
const page = (await (await fetch("http://127.0.0.1:9519/json/list")).json()).find(p => p.type === "page");
ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
ws.addEventListener("message", m => { const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id).res(d); pending.delete(d.id); }
  if (d.method === "Runtime.exceptionThrown") errs.push(JSON.stringify(d.params.exceptionDetails).slice(0, 300));
  if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") errs.push(d.params.args.map(a => a.value).join(" ")); });
await cdp("Page.enable"); await cdp("Runtime.enable");
ws.addEventListener("message", m => { const d = JSON.parse(m.data);
  if (d.method === "Page.javascriptDialogOpening")
    cdp("Page.handleJavaScriptDialog", { accept: true }).catch(() => {}); });
await cdp("Page.navigate", { url: BASE });
await sleep(1600);
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
async function drag(x1, y1, x2, y2, steps = 10) {
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: x1, y: y1, button: "left", clickCount: 1 });
  for (let i = 1; i <= steps; i++)
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: x1 + (x2 - x1) * i / steps, y: y1 + (y2 - y1) * i / steps });
  await sleep(80);
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: x2, y: y2, button: "left", clickCount: 1 });
}
async function shot(name) {
  const r = await cdp("Page.captureScreenshot", { format: "png" });
  writeFileSync(`/tmp/${name}.png`, Buffer.from(r.result.data, "base64"));
}

// ---- 打开教学楼示范地图 ----
await evalJs(`(() => { const cards = [...document.querySelectorAll('#cardGrid .mapCard')];
  const t = cards.find(c => c.textContent.includes('教学楼'));
  if (t) { t.click(); return true; } return false; })()`);
await sleep(1500);
check("打开教学楼地图", (await evalJs("document.querySelector('#mapName').textContent")).includes("教学楼"),
  await evalJs("document.querySelector('#mapName').textContent"));
check("教学楼 3 层加载", await evalJs("floors.length") === 3);
check("当前层 1F 有 52 桌 48 椅 3 AP", (await evalJs("tables.length")) === 52 &&
  (await evalJs("chairs.length")) === 48 && (await evalJs("routers.length")) === 3);
await evalJs("fitView()");
await sleep(500);
await shot("tb-2d");

// ---- 座椅功能(在教学楼上直接操作会改动示范图, 先记基线) ----
const baseChairs = await evalJs("chairs.length");
await evalJs(`setTool("pan"); setTool("chair")`);
const ctr = await evalJs(`(() => { const r = document.querySelector('#mapStage').getBoundingClientRect();
  return [r.x + r.width * 0.5, r.y + r.height * 0.5]; })()`);
await drag(ctr[0], ctr[1], ctr[0] + 120, ctr[1] + 80);  // 大对角拖拽(避免网格吸附吸成零宽/零高)
await sleep(500);
check("拖拽放置座椅", await evalJs("chairs.length") === baseChairs + 1,
  await evalJs("JSON.stringify(chairs[chairs.length-1])"));
check("座椅选中显示「旋转朝向」", (await evalJs("document.querySelector('#shapeInfo').textContent")) === "已选中座椅" &&
  (await evalJs("document.querySelector('#btnChairRot').style.display")) === "");
const bandBefore = await evalJs("chairs[chairs.length-1].dir");
check("新座椅初始 dir=0 且已选中", bandBefore === 0 &&
  (await evalJs("document.querySelector('#shapeInfo').textContent")) === "已选中座椅");
await clickSel("#btnChairRot");
await clickSel("#btnChairRot");
await sleep(300);
check("旋转朝向 0→2", (await evalJs("chairs[chairs.length-1].dir")) === 2, `${bandBefore} -> ${await evalJs("chairs[chairs.length-1].dir")}`);
await evalJs(`(() => { chairs.pop(); syncFloorRefs(); persist(); renderDrawings(); updateShapeCtl(); })()`);   // 清掉测试座椅
await sleep(400);

// ---- AP 高度功能: 选中一个 AP 改高度 ----
await evalJs(`(() => { selShape = { kind: "router", obj: routers[0] }; selPointId = null; updateShapeCtl(); renderDrawings(); })()`);
await sleep(300);
check("AP 选中显示安装高度输入", (await evalJs("document.querySelector('#routerZIn').style.display")) === "" &&
  (await evalJs("document.querySelector('#routerZIn').value")) === "2.7");
await evalJs(`(() => { const i = document.querySelector('#routerZIn'); i.value = 1.2;
  i.dispatchEvent(new Event('change')); })()`);
await sleep(400);
check("AP 高度改为 1.2m", (await evalJs("routers[0].z")) === 1.2);
check("2D 出现高度标注 1.2m", (await evalJs("document.querySelector('#wallG').innerHTML")).includes("1.2m"));
await evalJs(`(() => { routers[0].z = 2.7; persist(); renderDrawings(); })()`);   // 还原
await sleep(400);

// ---- 3D 视角截图(教学楼 3 层) ----
await evalJs("set3dView(true)");
await sleep(3200);
await shot("tb-3d");
// 拖到低角度看走廊与教室内部
const w3 = await evalJs("[document.querySelector('#map3dWrap').clientWidth, document.querySelector('#map3dWrap').clientHeight]");
await drag(w3[0] * 0.45, w3[1] * 0.55, w3[0] * 0.75, w3[1] * 0.35);
await sleep(1100);
await shot("tb-3d-rotated");
check("3D 无报错", errs.length === 0, errs.join("; ").slice(0, 200));

console.log("\nconsole errors:", errs.length ? errs : "(无)");
const fails = results.filter(r => !r.ok).length;
console.log(`\n==== ${results.length - fails}/${results.length} passed ====`);
proc.kill();
process.exit(fails ? 1 : 0);
