// 网格 / 吸附 / 墙厚单位设置
/* ---- 墙体厚度 / 单位(px 或 m, m 最小 0.1) ---- */
function syncThickInput() {
  $("thickUnitIn").value = thickUnit;
  $("pxPerMIn").value = pxPerM;
  $("wallThickIn").value = thickUnit === "m" ? +(wallThick / pxPerM).toFixed(2) : +wallThick.toFixed(1);
  $("wallThickIn").min = thickUnit === "m" ? "0.1" : "1";
}
function applyThickInput() {
  let v = +$("wallThickIn").value || 0;
  if (thickUnit === "m") v = Math.max(0.1, v) * pxPerM;   // 米最小 0.1m
  else v = Math.max(1, v);                                 // 像素最小 1px
  wallThick = Math.round(v * 10) / 10;
  syncThickInput();
  persist(); renderDrawings();
}
$("wallThickIn").onchange = applyThickInput;
$("thickUnitIn").onchange = e => { thickUnit = e.target.value; applyThickInput(); };
$("pxPerMIn").onchange = e => {
  pxPerM = Math.max(1, Math.round(+$("pxPerMIn").value || 50));
  applyView();                              // 每米加粗线间距随比例变化
  if (thickUnit === "m") applyThickInput(); // 换算比例变了, 米厚度重新折算 px
  else persist();
};
