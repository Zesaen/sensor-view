// sensor-view 楼梯/电梯绘制 + 三维视角 端到端测试(chromium headless + 原生 CDP)
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = "/home/ubuntu/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell";
const PORT = 9507;
const BASE = "http://127.0.0.1:8888";

const proc = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  "--no-sandbox", "--disable-gpu", "--window-size=1600,1000", "--hide-scrollbars",
  "about:blank",
], { stdio: "ignore" });
const shutdown = () => { try { proc.kill(); } catch {} };
process.on("exit", shutdown);

// ---- 最小 CDP 客户端 ----
let ws, msgId = 0;
const pending = new Map();
const events = [];
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
  return r.result.result.value;   // CDP: value 嵌套在 message.result.result.value
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
  else if (d.method) events.push(d);
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

// ---- 工具函数 ----
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
async function clickSel(sel) { const c = await center(sel); if (!c) throw new Error("no element " + sel); await clickAt(c[0], c[1]); }
async function shot(name) {
  const r = await cdp("Page.captureScreenshot", { format: "png" });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(`/tmp/${name}.png`, Buffer.from(r.result.data, "base64"));
}

// ---- 打开页面 ----
await cdp("Page.navigate", { url: BASE });
await sleep(1500);

// 进入第一张地图(没有则新建)
// 优先选测试地图, 避免污染示范图(教学楼)
await evalJs(`(() => { const cards = [...document.querySelectorAll('#cardGrid .mapCard')];
  const t = cards.find(c => c.textContent.includes('测试地图')) || cards[0]; if (t) t.click(); })()`);
await sleep(1200);
if (await evalJs("document.querySelector('#viewMap').style.display") === "none") {
  await evalJs("document.querySelector('#btnHomeNew').click()");
  await sleep(300);
  await cdp("Input.insertText", { text: "测试地图-楼梯电梯3D" });
  await sleep(200);
  await evalJs("document.querySelector('#nameDlgOk').click()");
}
await sleep(1200);
check("打开地图编辑视图", await evalJs("document.querySelector('#viewMap').style.display") !== "none");

// 清空既有图形, 保证断言针对本次绘制
await evalJs("walls=[];doors=[];tables=[];stairs=[];lifts=[];routers=[];undoStack=[];selShape=null;updateShapeCtl();persist();renderDrawings();");
await sleep(800);

// 记录当前图形数量作基线
const base = await evalJs("JSON.stringify({ stairs: stairs.length, lifts: lifts.length, walls: walls.length })");

// ---- 楼梯绘制 ----
const st = await center("#btnStair");
await clickAt(st[0], st[1]);
const stage = await evalJs(`(() => { const r = document.querySelector('#mapStage').getBoundingClientRect();
  return [r.x, r.y]; })()`);
await drag(stage[0] + 150, stage[1] + 120, stage[0] + 390, stage[1] + 210);
await sleep(500);
const st1 = await evalJs("JSON.stringify({ n: stairs.length, d: stairs[stairs.length-1] })");
check("绘制楼梯", JSON.parse(st1).n === JSON.parse(base).stairs + 1, st1);
check("楼梯自动选中并出现「调转上楼方向」按钮", await evalJs("document.querySelector('#btnStairFlip').style.display") === "" &&
  await evalJs("document.querySelector('#shapeInfo').textContent") === "已选中楼梯");
await shot("3d-stair-2d");

// 调转上行方向 → 「上」字标签位置变化
const labelBefore = await evalJs("document.querySelector('#wallG text') ? document.querySelector('#wallG text').getAttribute('x') : null");
await clickSel("#btnStairFlip");
await sleep(300);
const labelAfter = await evalJs("document.querySelector('#wallG text') ? document.querySelector('#wallG text').getAttribute('x') : null");
check("调转上楼方向生效", labelBefore !== null && labelAfter !== null && labelBefore !== labelAfter, `${labelBefore} -> ${labelAfter}`);

// ---- 电梯绘制 ----
await clickSel("#btnLift");
await drag(stage[0] + 450, stage[1] + 120, stage[0] + 570, stage[1] + 230);
await sleep(500);
const lf1 = await evalJs("JSON.stringify(lifts)");
check("绘制电梯", JSON.parse(lf1).length === JSON.parse(base).lifts + 1, lf1);
check("电梯选中提示", await evalJs("document.querySelector('#shapeInfo').textContent") === "已选中电梯");
await shot("3d-lift-2d");

// 撤销一笔(电梯被撤销)
await clickSel("#btnUndoDraw");
await sleep(300);
check("撤销刚画的电梯", await evalJs("lifts.length") === JSON.parse(base).lifts);
// 重画电梯(留给 3D 展示); 按钮是开关式, 先归位再进入电梯模式
await evalJs(`setTool("pan"); setTool("lift")`);
await drag(stage[0] + 450, stage[1] + 120, stage[0] + 570, stage[1] + 230);
await sleep(500);

// ---- 持久化验证 ----
await sleep(1000);
const mid = await evalJs("curMap.id");
const saved = await (await fetch(`${BASE}/api/maps/${mid}/data`)).json();
check("map.json 已保存 stairs/lifts", Array.isArray(saved.data.stairs) && saved.data.stairs.length > 0 &&
  Array.isArray(saved.data.lifts) && saved.data.lifts.length > 0,
  `stairs=${saved.data.stairs.length} lifts=${saved.data.lifts.length}`);

// ---- 三维视角(入口已收进「视图」菜单) ----
await evalJs(`[...document.querySelectorAll('#mbar .mtop')][2].querySelector('button').click()`);
await sleep(200);
await evalJs(`[...document.querySelectorAll('#mbar .dd .ddItem')].find(el => el.textContent.includes('三维视角')).click()`);
await sleep(2500);
check("菜单进入三维视角(2D 隐藏/3D 显示)", await evalJs("document.querySelector('#map3dWrap').style.display") === "block" &&
  await evalJs("document.querySelector('#mapStage').style.display") === "none");
check("3D 右上角返回按钮可见", await evalJs(`document.querySelector('#btn3dView').offsetParent !== null &&
  document.querySelector('#btn3dView').textContent.includes('返回二维')`));
await shot("3d-view-on");
// 拖动旋转一下视角再截一张
const w3 = await evalJs("[document.querySelector('#map3dWrap').clientWidth, document.querySelector('#map3dWrap').clientHeight]");
await drag(w3[0] / 2, w3[1] / 2, w3[0] / 2 - 180, w3[1] / 2 + 60);
await sleep(900);
await shot("3d-view-rotated");

// Esc 返回 2D
await evalJs("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
await sleep(600);
check("Esc 返回二维编辑", await evalJs("document.querySelector('#map3dWrap').style.display") === "none" &&
  await evalJs("document.querySelector('#mapStage').style.display") === "block");

// ---- 菜单项存在性 ----
check("绘图菜单含楼梯/电梯项", await evalJs("MENUS[3].items().some(i => i.t === '放置楼梯') && MENUS[3].items().some(i => i.t === '放置电梯')"));
check("视图菜单含三维视角项", await evalJs("MENUS[2].items().some(i => i.t === '三维视角')"));
check("工具栏已收敛(危险/低频按钮移入菜单)", await evalJs(`document.querySelector('#btnWall') && document.querySelector('#btnUndoDraw') &&
  !document.querySelector('#btnClearDraw') && !document.querySelector('#btnClearPts') &&
  !document.querySelector('#btnResetView') && !document.querySelector('#btnGridBg') && !document.querySelector('#tplSel')`) !== null);
check("绘图菜单含模板项", await evalJs("MENUS[3].items().some(i => i.t === '存当前为模板…') && MENUS[3].items().some(i => i.t === '模板')"));

console.log("\nconsole errors:", consoleErrors.length ? consoleErrors : "(无)");
const fails = results.filter(r => !r.ok).length;
console.log(`\n==== ${results.length - fails}/${results.length} passed ====`);
shutdown();
process.exit(fails ? 1 : 0);
