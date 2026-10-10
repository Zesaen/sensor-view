// 启动入口: 进入主页 + 周期刷新 —— 保持原时序, 位于 dbmodal 之后、live3d 之前
/* 入口: 欢迎主页(最近地图) */
showView("home");
refreshHome();
loadTemplates();
refreshDbCard();

/* 周期刷新状态徽标 / 统计 */
setInterval(() => {
  const now = Date.now();
  const imuAge = lastImuTs ? (now - lastImuTs) / 1000 : null;
  const rssiAge = lastRssiTs ? (now - lastRssiTs) / 1000 : null;
  const badge = (age, warn, bad) => !sseOk ? ["bad", "SSE断开"] :
    age == null ? ["bad", "无数据"] : age < warn ? ["ok", fmt1(age) + "s 前"] :
    age < bad ? ["warn", fmt1(age) + "s 前"] : ["bad", fmt1(age) + "s 未更新"];
  let [c, t] = badge(imuAge, 3, 10);  $("dotImu").className = "dot " + c; $("imuBadge").textContent = t;
  [c, t] = badge(rssiAge, 6, 15);     $("dotRssi").className = "dot " + c; $("rssiBadge").textContent = t;
  $("ageImu").textContent = imuAge == null ? "--" : fmt1(imuAge) + "s 前";
  $("ageRssi").textContent = rssiAge == null ? "--" : fmt1(rssiAge) + "s 前";
  $("stImu").textContent = stats.imuCount + " 条 · " + fmt1(stats.imuRate) + "/s";
  $("stRssi").textContent = stats.rssiCount + " 条 · " + fmt1(stats.rssiRate) + "/s";
  $("stUp").textContent = bootMs == null ? "--" : (bootMs / 1000).toFixed(0) + " s";
  $("stTime").textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  renderChart(lastAps);
}, 1000);
refreshCollect();
setInterval(refreshCollect, 1000);
