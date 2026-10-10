// sensor-view 交互优化端到端测试: 图形拖拽移动 / 移动撤销 / Delete 删除 / Esc 退工具 / toast / 尺寸提示
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = "/home/ubuntu/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell";
const PORT = 9513;
const BASE = "http://127.0.0.1:8888";

const proc = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  "--no-sandbox", "--disable-gpu", "--window-size=1600,1000", "--hide-scrollbars",
  "about:blank",
], { stdio: "ignore" });
const shutdown = () => { try { proc.kill(); } catch {} };
process.on("exit", shutdown);

let ws, msgId = 0;
const pending = new Map();
async function cdp(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error("cdp timeout " + method)); } }, 15000);
  });
}
async function evalJs(expr) {
  const r = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("page eval failed: " + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.result.value;
}
for (let i = 0; i < 40; i++) {
  try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(200); }
}
const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const wsUrl = pages.find(p => p.type === "page").webSocketDebuggerUrl;
ws = new WebSocket(wsUrl);
await new Promise(r => ws.onopen = r);
ws.onmessage = m => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id).res(d); pending.delete(d.id); }
};
await cdp("Page.enable");
await cdp("Runtime.enable");
const consoleErrors = [];
ws.addEventListener("message", m => {
  const d = JSON.parse(m.data);
  if (d.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(d.params.type))
    consoleErrors.push(d.params.type + ": " + (d.params.args || []).map(a => a.value || a.description || "").join(" "));
  if (d.method === "Runtime.exceptionThrown")
    consoleErrors.push("exception: " + JSON.stringify(d.params.exceptionDetails).slice(0, 500));
});

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok, extra });
  console.log((ok ? "PASS" : "FAIL") + " | " + name + (extra ? " | " + extra : ""));
};
async function mouse(type, x, y, btn = "left", extra = {}) {
  await cdp("Input.dispatchMouseEvent", { type, x, y, button: btn, clickCount: 1, ...extra });
}
async function clickAt(x, y) { await mouse("mousePressed", x, y); await mouse("mouseReleased", x, y); }
async function drag(x1, y1, x2, y2, steps = 12) {
  await mouse("mousePressed", x1, y1);
  for (let i = 1; i <= steps; i++)
    await mouse("mouseMoved", x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps);
  await sleep(80);
  await mouse("mouseReleased", x2, y2);
}
async function center(sel) {
  return evalJs(`(() => { const e = document.querySelector('${sel}'); if (!e) return null;
    e.scrollIntoView({ block: "center", inline: "center" });
    const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
}
async function key(opt) {
  await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify(opt)}))`);
}
async function shot(name) {
  const r = await cdp("Page.captureScreenshot", { format: "png" });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(`/tmp/${name}.png`, Buffer.from(r.result.data, "base64"));
}

await cdp("Page.navigate", { url: BASE });
await sleep(1500);

await evalJs(`(() => { const cards = [...document.querySelectorAll('#cardGrid .mapCard')];
  const t = cards.find(c => c.textContent.includes('测试地图')) || cards[0]; if (t) t.click(); })()`);
await sleep(1200);
if (await evalJs("document.querySelector('#viewMap').style.display") === "none") {
  await evalJs("document.querySelector('#btnHomeNew').click()");
  await sleep(300);
  await cdp("Input.insertText", { text: "测试地图-交互优化" });
  await sleep(200);
  await evalJs("document.querySelector('#nameDlgOk').click()");
}
await sleep(1200);
check("打开地图编辑视图", await evalJs("document.querySelector('#viewMap').style.display") !== "none");

await evalJs("walls=[];doors=[];tables=[];chairs=[];stairs=[];lifts=[];routers=[];undoStack=[];selShape=null;updateShapeCtl();persist();renderDrawings();setTool('pan');");
await sleep(600);

// ---- 1. 画一张桌(检查尺寸提示 + 放置 toast) ----
const tb = await center("#btnTable");
await clickAt(tb[0], tb[1]);
const stage = await evalJs(`(() => { const r = document.querySelector('#mapStage').getBoundingClientRect();
  return [r.x + r.width / 2, r.y + r.height / 2, r.width, r.height]; })()`);
const [scx, scy] = [stage[0], stage[1]];
await mouse("mousePressed", scx, scy);
await mouse("mouseMoved", scx + 40, scy + 25);
await sleep(60);
const tipInfo = await evalJs(`(() => { const t = document.querySelector('#draftTip');
  return { disp: getComputedStyle(t).display, txt: t.textContent }; })()`);
check("拖拽中显示尺寸提示", tipInfo.disp === "block" && tipInfo.txt.includes("×"), JSON.stringify(tipInfo));
await mouse("mouseMoved", scx + 120, scy + 80);
await sleep(60);
await mouse("mouseReleased", scx + 120, scy + 80);
await sleep(300);
const t0 = await evalJs("tables.length === 1 ? JSON.stringify(tables[0]) : 'X:' + tables.length");
check("拖出一张桌", t0.startsWith("{"), t0);
const toast1 = await evalJs(`document.querySelector('#stageToast').classList.contains('show') + '|' + document.querySelector('#stageToast').textContent`);
check("放置 toast 反馈", toast1.startsWith("true|已放置桌"), toast1);

// ---- 2. 平移模式下拖拽移动图形 ----
await evalJs("setTool('pan')");
await sleep(150);
const before = await evalJs("JSON.stringify(tables[0])");
const sc = await evalJs(`JSON.stringify((() => { const t = tables[0];
  const [x, y] = worldToScreen((t.x1 + t.x2) / 2, (t.y1 + t.y2) / 2);
  const r = document.querySelector('#mapStage').getBoundingClientRect();
  return [x + r.x, y + r.y]; })())`);
const [tx, ty] = JSON.parse(sc);
await drag(tx, ty, tx + 100, ty + 60);
await sleep(300);
const moved = await evalJs("JSON.stringify(tables[0])");
const dxOK = await evalJs(`(() => { const a = ${before}, b = ${moved};
  const dx = b.x1 - a.x1, dy = b.y1 - a.y1;
  const expX = snapV(100 / view.s), expY = snapV(60 / view.s);
  return Math.abs(dx - expX) < 0.001 && Math.abs(dy - expY) < 0.001 &&
         (b.x2 - b.x1) === (a.x2 - a.x1) && dx !== 0; })()`);
check("拖拽移动桌(位移=吸附值, 尺寸不变)", dxOK, before + " -> " + moved);
check("移动 toast", await evalJs(`document.querySelector('#stageToast').classList.contains('show') &&
  document.querySelector('#stageToast').textContent.includes('已移动桌')`));
check("移动记入撤销栈", await evalJs("undoStack.length > 0 && undoStack[undoStack.length-1].kind === 'move'"));
check("移动后仍选中该桌", await evalJs(`selShape && selShape.kind === 'table' && selShape.obj === tables[0]`));

// ---- 3. Ctrl+Z 撤销移动 ----
await key({ key: "z", ctrlKey: true, bubbles: true });
await sleep(300);
check("Ctrl+Z 恢复移动前坐标", await evalJs(`JSON.stringify(tables[0]) === '${before}'`));

// ---- 4. 单击选中 + Delete 删除 ----
const sc2 = JSON.parse(await evalJs(`JSON.stringify((() => { const t = tables[0];
  const [x, y] = worldToScreen((t.x1 + t.x2) / 2, (t.y1 + t.y2) / 2);
  const r = document.querySelector('#mapStage').getBoundingClientRect();
  return [x + r.x, y + r.y]; })())`));
await clickAt(sc2[0], sc2[1]);
await sleep(250);
check("单击选中桌", await evalJs(`document.querySelector('#shapeInfo').textContent === '已选中桌子'`));
await key({ key: "Delete", bubbles: true });
await sleep(300);
check("Delete 删除选中桌", await evalJs("tables.length === 0"));

// ---- 5. Esc 退出绘制工具 ----
await evalJs("setTool('table')");
await key({ key: "Escape", bubbles: true });
await sleep(150);
check("Esc 退回平移工具", await evalJs(`tool === 'pan' && document.querySelector('#toolState').classList.contains('on') === false`));

// ---- 6. 3D 无报错(新渲染管线) ----
await evalJs("set3dView(true)");
await sleep(2500);
check("三维视角构建无报错", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" ; "));
await shot("ux-3d");
await evalJs("set3dView(false)");

const fails = results.filter(r => !r.ok).length;
console.log("\nconsole errors: " + (consoleErrors.length ? consoleErrors.join("\n") : "(无)"));
console.log(`\n==== ${results.length - fails}/${results.length} passed ====`);
proc.kill();
process.exit(fails ? 1 : 0);
