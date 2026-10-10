// $ / fmt1 微工具 —— 必须最先加载
const $ = id => document.getElementById(id);
const fmt1 = v => (v == null || isNaN(v)) ? "--" : v.toFixed(1);
