// 采集数据库管理弹窗(Esc②, document 级)
/* ---- 采集数据库管理窗口 (增删改查) ---- */
const DB_COLS = {
  imu: [
    { k: "id", t: "ID", ro: 1 }, { k: "ts", t: "时间", ro: 1, time: 1 }, { k: "_pt", t: "测点", ro: 1 },
    { k: "ori", t: "朝向°", num: 1 }, { k: "yaw", t: "yaw°", num: 1, step: 0.1 },
    { k: "pitch", t: "pitch°", num: 1, step: 0.1 }, { k: "roll", t: "roll°", num: 1, step: 0.1 },
    { k: "mag_x", t: "magX", num: 1, step: 0.1 }, { k: "mag_y", t: "magY", num: 1, step: 0.1 },
    { k: "mag_z", t: "magZ", num: 1, step: 0.1 },
  ],
  wifi: [
    { k: "id", t: "ID", ro: 1 }, { k: "ts", t: "时间", ro: 1, time: 1 }, { k: "_pt", t: "测点", ro: 1 },
    { k: "scan_no", t: "扫描#", num: 1 }, { k: "ori", t: "朝向°", num: 1 },
    { k: "yaw", t: "yaw°", num: 1, step: 0.1 },
    { k: "ap_name", t: "AP 名称", str: 1, wide: 1 }, { k: "rssi", t: "RSSI", num: 1 },
  ],
};
let dbKind = "imu", dbPage = 1, dbSel = new Set(), dbEditingId = null, dbAdding = false, dbRows = [];
const dbSelKey = (kind, id) => kind + ":" + id;

function dbPointName(pid) {
  const p = mapPoints.find(q => q.id === pid);
  return p ? p.name : pid;
}
function dbInvalidateStat(pid) {   // 库内容变化后作废对应测点的聚合缓存
  const p = mapPoints.find(q => q.id === pid);
  if (p) { p.stat = null; p.statFetched = false; ensureStat(p); }
  if (selPointId === pid) renderDetail();
}
function dbFillPointSel(sel) {
  const box = $("dbPointSel");
  const cur = sel !== undefined ? sel : box.value;
  box.innerHTML = '<option value="">全部测点</option>' + mapPoints.map(p =>
    `<option value="${escH(p.id)}">${escH(p.name)}</option>`).join("");
  box.value = [...box.options].some(o => o.value === cur) ? cur : "";
}
function dbOpen(pointId) {
  $("dbOverlay").classList.add("show");
  dbFillPointSel(pointId || "");
  dbPage = 1; dbSel.clear(); dbEditingId = null; dbAdding = false;
  dbLoad();
}
function dbClose() { $("dbOverlay").classList.remove("show"); }

async function dbLoad() {
  const pid = $("dbPointSel").value;
  const d = await api(`/api/db/list?kind=${dbKind}&page=${dbPage}&size=50`
    + (pid ? "&point_id=" + encodeURIComponent(pid) : ""));
  if (!d || !d.ok) {
    $("dbBody").innerHTML = '<div class="empty" style="padding:24px">加载失败, 请检查服务</div>';
    return;
  }
  dbRows = d.rows;
  dbEditingId = null;
  const pages = Math.max(1, Math.ceil(d.total / d.size));
  if (dbPage > pages) dbPage = pages;
  $("dbTotal").textContent = `共 ${d.total} 条`;
  $("dbPage").textContent = `${dbPage} / ${pages}`;
  $("btnDbPrev").disabled = dbPage <= 1;
  $("btnDbNext").disabled = dbPage >= pages;
  const cols = DB_COLS[dbKind];
  const head = `<tr><th class="chkCol"></th>${cols.map(c => `<th>${c.t}</th>`).join("")}<th>操作</th></tr>`;
  const addRow = dbAdding ? dbFormRowHtml(null, cols) : "";
  const rows = d.rows.length
    ? d.rows.map(r => dbRowHtml(r, cols)).join("")
    : `<tr><td colspan="${cols.length + 2}" class="empty" style="padding:18px;text-align:center">暂无数据</td></tr>`;
  $("dbBody").innerHTML = `<table class="dbTable"><thead>${head}</thead><tbody>${addRow}${rows}</tbody></table>`;
}
function dbRowHtml(r, cols) {
  const tds = cols.map(c => {
    let v;
    if (c.k === "_pt") v = escH(dbPointName(r.point_id));
    else if (c.time) v = fmtT(r[c.k]);
    else if (c.str) v = escH(r[c.k] ?? "");
    else v = r[c.k] ?? "";
    const cls = (c.num || c.k === "id" ? "num" : "") + (c.k === "id" ? " idCol" : "");
    return `<td class="${cls}">${v}</td>`;
  }).join("");
  const checked = dbSel.has(dbSelKey(dbKind, r.id)) ? " checked" : "";
  return `<tr data-id="${r.id}"><td class="chkCol"><input type="checkbox" class="dbChk"${checked}></td>${tds}
    <td><div class="dbRowAct"><button class="dbMini dbEdit" title="行内编辑">编辑</button>
      <button class="dbMini del dbDel" title="删除该条">删除</button></div></td></tr>`;
}
function dbFormRowHtml(r, cols) {   // r=null → 新增行; 否则编辑既有行
  const tds = cols.map(c => {
    if (c.k === "id") return `<td class="num idCol">${r ? r.id : "新"}</td>`;
    if (c.time) return `<td class="num idCol">${r ? fmtT(r[c.k]) : nowStr()}</td>`;
    if (c.k === "_pt") {
      if (r) return `<td>${escH(dbPointName(r.point_id))}</td>`;
      return `<td><select class="txt sel dbAddPt" style="width:auto;min-width:110px">${mapPoints.map(p =>
        `<option value="${escH(p.id)}">${escH(p.name)}</option>`).join("")}</select></td>`;
    }
    const v = r ? (r[c.k] ?? "") : "";
    if (c.str) return `<td><input type="text" class="wide${r ? "" : " dbAddF"}" data-col="${c.k}"
      value="${escH(String(v))}" placeholder="${c.t}"></td>`;
    return `<td><input type="number" step="${c.step || 1}"${r ? "" : ' class="dbAddF"'} data-col="${c.k}"
      value="${v}" placeholder="${c.t}"></td>`;
  }).join("");
  return `<tr data-id="${r ? r.id : "new"}" class="dbAddRow"><td class="chkCol"></td>${tds}
    <td><div class="dbRowAct"><button class="dbMini ${r ? "dbSave" : "dbAddSave"}">保存</button>
      <button class="dbMini del ${r ? "dbCancel" : "dbAddCancel"}">取消</button></div></td></tr>`;
}
async function dbSaveForm(tr, row) {
  const fields = {};
  tr.querySelectorAll("input[data-col]").forEach(inp => {
    fields[inp.dataset.col] = inp.type === "number"
      ? (inp.value === "" ? null : +inp.value) : inp.value;
  });
  if (row) {                                   // 编辑
    const r = await apiPost("/api/db/update",
      JSON.stringify({ kind: dbKind, id: row.id, fields }), "application/json");
    if (!r || !r.ok) { alert("保存失败: " + ((r && r.error) || "网络错误")); return; }
    dbInvalidateStat(row.point_id);
  } else {                                     // 新增
    const pid = tr.querySelector(".dbAddPt").value;
    if (!pid) { alert("请选择测点"); return; }
    const fs = {};
    for (const [k, v] of Object.entries(fields)) if (v !== "" && v !== null) fs[k] = v;
    const r = await apiPost("/api/db/insert",
      JSON.stringify({ kind: dbKind, point_id: pid, fields: fs }), "application/json");
    if (!r || !r.ok) { alert("保存失败: " + ((r && r.error) || "网络错误")); return; }
    dbAdding = false;
    dbInvalidateStat(pid);
  }
  dbLoad(); refreshDbCard();
}
async function dbDeleteRow(row) {
  const what = dbKind === "imu" ? `IMU 采样 #${row.id}` : `WiFi 记录 #${row.id} (${row.ap_name})`;
  if (!confirm(`删除${what}?`)) return;
  const r = await apiPost("/api/db/delete",
    JSON.stringify({ ids: [{ kind: dbKind, id: row.id }] }), "application/json");
  if (r && r.ok) { dbInvalidateStat(row.point_id); dbLoad(); refreshDbCard(); }
}
$("dbBody").addEventListener("click", ev => {
  const btn = ev.target.closest("button");
  if (!btn) return;
  const tr = btn.closest("tr");
  if (!tr) return;
  const row = dbRows.find(r => String(r.id) === tr.dataset.id);
  if (btn.classList.contains("dbEdit") && row) {
    tr.outerHTML = dbFormRowHtml(row, DB_COLS[dbKind]);
    const first = $("dbBody").querySelector('tr input[data-col]');
    if (first) first.focus();
  } else if (btn.classList.contains("dbDel") && row) {
    dbDeleteRow(row);
  } else if (btn.classList.contains("dbSave") && row) {
    dbSaveForm(tr, row);
  } else if (btn.classList.contains("dbCancel")) {
    dbLoad();
  } else if (btn.classList.contains("dbAddSave")) {
    dbSaveForm(tr, null);
  } else if (btn.classList.contains("dbAddCancel")) {
    dbAdding = false; dbLoad();
  }
});
$("dbBody").addEventListener("change", ev => {
  if (!ev.target.classList.contains("dbChk")) return;
  const id = +ev.target.closest("tr").dataset.id;
  const key = dbSelKey(dbKind, id);
  if (ev.target.checked) dbSel.add(key); else dbSel.delete(key);
});
document.querySelectorAll(".dbTab").forEach(b => b.onclick = () => {
  dbKind = b.dataset.kind;
  document.querySelectorAll(".dbTab").forEach(x => x.classList.toggle("on", x === b));
  dbPage = 1; dbSel.clear(); dbLoad();
});
$("dbPointSel").onchange = () => { dbPage = 1; dbSel.clear(); dbLoad(); };
$("btnDbPrev").onclick = () => { if (dbPage > 1) { dbPage--; dbLoad(); } };
$("btnDbNext").onclick = () => { dbPage++; dbLoad(); };
$("btnDbAdd").onclick = () => { dbAdding = !dbAdding; dbLoad(); };
$("btnDbClose").onclick = dbClose;
$("dbOverlay").addEventListener("click", ev => { if (ev.target === $("dbOverlay")) dbClose(); });
document.addEventListener("keydown", ev => {
  if (ev.key === "Escape" && $("dbOverlay").classList.contains("show")) dbClose();
});
$("btnDbExportNow").onclick = () => {
  const pid = $("dbPointSel").value;
  const aEl = document.createElement("a");
  aEl.href = `/api/db/export?kind=${dbKind}&fmt=csv` + (pid ? "&point_id=" + encodeURIComponent(pid) : "");
  document.body.appendChild(aEl); aEl.click(); aEl.remove();
};
$("btnDbDelSel").onclick = async () => {
  const ids = [...dbSel].filter(k => k.startsWith(dbKind + ":"))
    .map(k => ({ kind: dbKind, id: +k.slice(dbKind.length + 1) }));
  if (!ids.length) { alert("请先勾选要删除的行"); return; }
  if (!confirm(`删除所选 ${ids.length} 条记录?`)) return;
  const r = await apiPost("/api/db/delete", JSON.stringify({ ids }), "application/json");
  if (r && r.ok) {
    dbSel.clear();
    for (const row of dbRows) if (ids.some(i => i.id === row.id)) dbInvalidateStat(row.point_id);
    dbLoad(); refreshDbCard();
  }
};
$("btnDbMgmt").onclick = () => dbOpen("");
$("btnDbExportAll").onclick = () => {
  const aEl = document.createElement("a");
  aEl.href = "/api/db/export?kind=all&fmt=csv";
  document.body.appendChild(aEl); aEl.click(); aEl.remove();
};
$("btnDbClear").onclick = async () => {
  if (!confirm("清空数据库中全部采样记录? 地图与测点不受影响, 不可恢复")) return;
  const r = await apiPost("/api/db/delete", JSON.stringify({ all: true }), "application/json");
  if (r && r.ok) {
    for (const p of mapPoints) { p.stat = null; p.statFetched = false; p.nWifiSaved = 0; }
    dbSel.clear();
    if ($("dbOverlay").classList.contains("show")) dbLoad();
    refreshDbCard(); renderDetail();
  }
};
