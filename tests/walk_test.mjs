// sensor-view 沉浸漫游端到端测试: 进入/移动/疾跑/碰撞/门洞/爬楼梯/Esc 逐级退出
// 注: 无头环境 rAF 仅 ~2fps, 时间驱动移动不可靠 → 用 walkStep(1/60) 手动步进(确定性)
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = "/home/ubuntu/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell";
const PORT = 9515;
const proc = spawn(CHROME, [`--remote-debugging-port=${PORT}`, "--no-sandbox", "--disable-gpu",
  "--window-size=1600,1000", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
process.on("exit", () => { try { proc.kill(); } catch {} });

let ws, msgId = 0; const pending = new Map();
async function cdp(method, params = {}) {
  const id = ++msgId; ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => { pending.set(id, { res, rej });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error("timeout " + method)); } }, 15000); });
}
async function evalJs(expr) {
  const r = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("page eval failed: " + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.result.value;
}
for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(200); } }
const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
ws = new WebSocket(pages.find(p => p.type === "page").webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id).res(d); pending.delete(d.id); } };
await cdp("Page.enable"); await cdp("Runtime.enable");
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
async function key(opt) { await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify(opt)}))`); }
// 手动步进 n 帧(60fps 等效), 期间按住 keys
async function step(n, keys) {
  return evalJs(`(() => { Object.assign(walk.keys, ${JSON.stringify(keys)});
    for (let i = 0; i < ${n}; i++) walkStep(1/60);
    walk.keys = {}; return true; })()`);
}
async function shot(name, ms = 800) {
  await sleep(ms);   // 等 rAF 至少渲染一帧
  const r = await cdp("Page.captureScreenshot", { format: "png" });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(`/tmp/${name}.png`, Buffer.from(r.result.data, "base64"));
}

await cdp("Page.navigate", { url: "http://127.0.0.1:8888" });
await sleep(1500);
await evalJs(`(() => { const cards = [...document.querySelectorAll('#cardGrid .mapCard')];
  const t = cards.find(c => c.textContent.includes('教学楼')); if (t) t.click(); })()`);
await sleep(1800);

// ---- 1. 进入三维 → 漫游 ----
await evalJs("set3dView(true)");
await sleep(1500);
check("三维视角已开启", await evalJs("view3d === true"));
const btnVisible = await evalJs(`(() => { const b = document.querySelector('#btnWalk');
  const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`);
check("出现「沉浸漫游」按钮", btnVisible);
await evalJs("walkEnter()");
await sleep(400);
check("漫游已激活", await evalJs("walk.active === true"));
check("出生在 1F 地面", await evalJs(`Math.abs(walk.pos.y) < 0.01`), "y=" + await evalJs("walk.pos.y.toFixed(2)"));
check("小人加入场景", await evalJs(`walk.char.group.parent === m3d.scene`));
check("提示条显示/图例隐藏", await evalJs(`document.querySelector('#walkHint').style.display === '' &&
  document.querySelector('#map3dLegend').style.display === 'none'`));

// ---- 2. 扫描畅通走廊: 东行普通速度 ----
const runway = await evalJs(`(() => {   // 找 +x 方向畅通 ≥3m 的起点
  const fd = walkFloorAt(0); const fe = floorExtentM(fd);
  for (let z = fe.z1 + 0.6; z < fe.z2; z += 0.5)
    for (let x = fe.x1 + 0.6; x < fe.x2; x += 0.5) {
      if (walkBlocked(x, z, 0)) continue;
      let open = 0;
      for (let t = 0.5; t <= 3.0; t += 0.5) { if (walkBlocked(x + t, z, 0)) break; open = t; }
      if (open >= 3.0) {
        walk.pos.set(x, 0, z); walk.yaw = -Math.PI / 2; walk.charYaw = null; walk.speed = 0;
        return JSON.stringify([+x.toFixed(2), +z.toFixed(2)]);
      }
    }
  return null;
})()`);
check("找到畅通走廊", runway !== null, runway || "无");
const d1 = await evalJs("JSON.stringify([walk.pos.x, walk.pos.z])");
await step(60, { w: 1 });
const walk1 = await evalJs(`(() => { const a = ${d1};
  return Math.hypot(walk.pos.x - a[0], walk.pos.z - a[1]).toFixed(2); })()`);
check("W 前进 ≈1.5m(60帧)", +walk1 > 0.9 && +walk1 < 2.2, "moved " + walk1 + "m");
await shot("walk-1");

// ---- 3. Shift 疾跑 ----
const d2 = await evalJs("JSON.stringify([walk.pos.x, walk.pos.z])");
await step(60, { w: 1, shift: 1 });
const walk2 = await evalJs(`(() => { const a = ${d2};
  return Math.hypot(walk.pos.x - a[0], walk.pos.z - a[1]).toFixed(2); })()`);
check("Shift 疾跑 ≈3m(60帧)", +walk2 > 1.8 && +walk2 < 4.4, "moved " + walk2 + "m");

// ---- 4. 墙体阻挡: 找北向 1~2m 后有墙的位置, 推 150 帧不得穿越 ----
const wallSpot = await evalJs(`(() => {   // 北向畅通 1.0~2.0m 且 2.5m 内撞墙
  const fd = walkFloorAt(0); const fe = floorExtentM(fd);
  for (let z = fe.z1 + 3; z < fe.z2; z += 0.5)
    for (let x = fe.x1 + 0.6; x < fe.x2; x += 0.5) {
      if (walkBlocked(x, z, 0)) continue;
      let open = 0, blockedAt = null;
      for (let t = 0.5; t <= 2.5; t += 0.5) {
        if (walkBlocked(x, z - t, 0)) { blockedAt = t; break; }
        open = t;
      }
      if (open >= 1.0 && open <= 2.0 && blockedAt) {
        const p0 = walk.pos.clone();
        walk.pos.set(x, 0, z); walk.yaw = 0; walk.charYaw = null; walk.speed = 0;
        const r = JSON.stringify({ x: +x.toFixed(2), z: +z.toFixed(2), open, blockedAt });
        walk.pos.copy(p0);
        return r;
      }
    }
  return null;
})()`);
check("找到撞墙测试位", wallSpot !== null, wallSpot || "无");
if (wallSpot) {
  const wp = JSON.parse(wallSpot);
  await evalJs(`walk.pos.set(${wp.x}, 0, ${wp.z}); walk.yaw = 0; walk.charYaw = null; walk.speed = 0;`);
  await step(150, { w: 1 });
  const zEnd = await evalJs("+walk.pos.z.toFixed(2)");
  const movedN = wp.z - zEnd;                   // 实际北移距离
  check("墙体阻挡(停在墙前)", movedN > 0.5 && movedN < wp.blockedAt + 0.1,
    "北移 " + movedN.toFixed(2) + "m, 障碍采样点在 " + wp.blockedAt + "m 处");
}

// ---- 5. 门洞可通行 ----
const doorPick = await evalJs(`(() => {   // 选一扇两侧 1.5m 通道畅通的门
  const fd = walkFloorAt(0);
  for (const d of fd.doors) {
    const horiz = Math.abs(d.x2 - d.x1) >= Math.abs(d.y2 - d.y1);
    const mid = m3((d.x1 + d.x2) / 2, (d.y1 + d.y2) / 2);
    const clear = (x, z) => !walkBlocked(x, z, 0);
    let ok = !walkBlocked(mid[0], mid[1], 0);
    for (let t = 0.3; t <= 1.5; t += 0.3) {
      if (horiz) { ok = ok && clear(mid[0], mid[1] - t) && clear(mid[0], mid[1] + t); }
      else { ok = ok && clear(mid[0] - t, mid[1]) && clear(mid[0] + t, mid[1]); }
    }
    if (ok) {
      if (horiz) { walk.pos.set(mid[0], 0, mid[1] - 1.5); walk.yaw = Math.PI; }
      else { walk.pos.set(mid[0] - 1.5, 0, mid[1]); walk.yaw = -Math.PI / 2; }
      walk.charYaw = null; walk.speed = 0;
      return JSON.stringify({ horiz, mid: mid.map(v => +v.toFixed(2)) });
    }
  }
  return null;
})()`);
check("找到可测门洞", doorPick !== null, doorPick || "无畅通门");
if (doorPick) {
  const dp = JSON.parse(doorPick);
  await step(150, { w: 1 });
  const crossed = await evalJs(`JSON.stringify({ x: +walk.pos.x.toFixed(2), z: +walk.pos.z.toFixed(2) })`);
  const cp = JSON.parse(crossed);
  const far = dp.horiz ? cp.z - dp.mid[1] : cp.x - dp.mid[0];
  check("穿门通行(越过门线 ≥0.8m)", far > 0.8, "越过 " + far.toFixed(2) + "m");
}

// ---- 6. 楼梯爬升 ----
const stOk = await evalJs(`(() => {
  const fd = walkFloorAt(0);
  const st = fd.stairs[0];
  if (!st) return null;
  const horiz = Math.abs(st.x2 - st.x1) >= Math.abs(st.y2 - st.y1);
  const x1 = Math.min(st.x1, st.x2), x2 = Math.max(st.x1, st.x2);
  const y1 = Math.min(st.y1, st.y2), y2 = Math.max(st.y1, st.y2);
  const mC = m3((x1 + x2) / 2, (y1 + y2) / 2);
  const lenM = (horiz ? x2 - x1 : y2 - y1) / pxPerM;
  const sgn = st.dir ? -1 : 1;               // 低端在 sgn 正端(prog=1-t, dir=0)
  if (horiz) {
    walk.pos.set(mC[0] + sgn * (lenM / 2 - 0.4), 0, mC[1]);
    walk.yaw = sgn * Math.PI / 2;            // 沿 -sgn*x 方向上坡
  } else {
    walk.pos.set(mC[0], 0, mC[1] + sgn * (lenM / 2 - 0.4));
    walk.yaw = sgn > 0 ? 0 : Math.PI;
  }
  walk.charYaw = null; walk.speed = 0;
  return JSON.stringify({ lenM: +lenM.toFixed(1) });
})()`);
check("找到楼梯", stOk !== null, stOk || "无楼梯");
await step(120, { w: 1 });
const yClimb = await evalJs("+walk.pos.y.toFixed(2)");
check("楼梯爬升(高度上升 >1m)", yClimb > 1.0, "y=" + yClimb);
await shot("walk-stairs");

// ---- 7. Esc 退出漫游(逐级) ----
await key({ key: "Escape", bubbles: true });
await sleep(300);
check("Esc 退出漫游", await evalJs("walk.active === false"));
check("仍在三维视角(逐级退出)", await evalJs("view3d === true"));
check("小人移出场景", await evalJs("walk.char.group.parent === null"));
check("轨道控制恢复", await evalJs("m3d.controls.enabled === true"));
check("提示条隐藏/按钮恢复", await evalJs(`document.querySelector('#walkHint').style.display === 'none' &&
  document.querySelector('#btnWalk').style.display === ''`));
await shot("walk-exit");

// ---- 8. 二次进入后经按钮退出, 再返回二维 ----
await evalJs("walkEnter()");
await sleep(300);
await evalJs("walkExit()");
check("按钮/接口退出正常", await evalJs("walk.active === false && view3d === true"));
await evalJs("set3dView(false)");
check("返回二维编辑", await evalJs("view3d === false"));

const fails = results.filter(r => !r.ok).length;
console.log("\nconsole errors: " + (consoleErrors.length ? consoleErrors.join("\n") : "(无)"));
console.log(`\n==== ${results.length - fails}/${results.length} passed ====`);
proc.kill();
process.exit(fails ? 1 : 0);
