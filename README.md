# sensor-view

传感器实时监控与地图采集系统: IMU 姿态 / 磁力计 / WiFi RSSI 实时流(SSE)、
多地图多楼层建筑编辑、三维视角与沉浸漫游、SQLite 按点采样库。
纯 Python 标准库后端 + 无构建前端，拷来即跑。

## 运行

```bash
python3 server.py          # 或 systemctl restart sensor-view (生产)
```

- `8888` Web 界面与全部 REST API(`server.py` 文档注释有完整 API 清单)
- `9001` IMU 姿态 TCP 接入(JSON Lines)，`9002` WiFi 扫描 TCP 接入
- 运行时数据在 `data/`(git 忽略): `maps/<mid>/` 每图一目录，`sensors.db` 采样库

## 目录结构

```
server.py            入口(systemd ExecStart 指向它, 仅调用 sensor_view.main)
sensor_view/         后端包
  config.py            常量与路径(改动入口)
  schema.py            地图数据默认值/白名单/校验的唯一权威定义
  mapstore.py          多地图文件 IO / 迁移 / 导入导出 / 生命周期
  templates.py         绘图模板读写
  db.py                SQLite 采样库(init_db() 显式初始化)
  collector.py         TCP 采集 / 后台缓冲 / SSE 广播
  web.py               HTTP 路由表与处理器
  util.py main.py      工具与启动编排
public/
  index.html           纯 HTML 骨架(402 行)
  css/                 base / live / editor / view3d / home
  js/                  22 个全局脚本, 必须按 index.html 中的顺序加载
  vendor/              three.min.js / OrbitControls.js(旧版全局 API)
tests/                回归测试(见下)
```

### 前端加载顺序(重要)

传统多 `<script>` 全局脚本，顺序即依赖。关键约束:

- `util.js` 最先; `vendor/` 在一切业务脚本之前
- `main.js`(启动代码)保持在 `live3d/map3d/walk` 之前 —— 与拆分前的原始执行时序一致
- 三个 Esc 键监听器靠注册顺序实现"漫游→三维→二维"逐级退出:
  `tools.js` → `dbmodal.js` → `map3d.js`，勿调整这三个文件的相对顺序
- `state.js` 中 walls/doors/… 活动数组与 `floors[i]` 各字段是**同一引用**
  (loadFloorIntoEditor/syncFloorRefs/floorsPayload 维护)，改数组必须原地改或走 syncFloorRefs

### 后端注意

- 新增地图字段只改 `sensor_view/schema.py` 一处(读取默认值与提交校验同源)
- SQL 表名/列名靠 `config.DB_COLS` 白名单保证安全，勿引入用户输入拼列名

## 测试

```bash
export PATH=/home/ubuntu/.zcode/server:$PATH    # node 22
cd tests
./capture_golden.sh /tmp/golden_now && diff -r golden /tmp/golden_now   # 接口金样
node ux_test.mjs && node floor_test.mjs && node chair_ap_test.mjs \
  && node gui_test3d.mjs && node walk_test.mjs                          # CDP 端到端
```

- CDP 测试用 chromium headless shell + 原生 WebSocket 协议，会真实操作页面
  (新建测试地图/画图/切层/3D/漫游)，跑前确认服务已在 8888 端口
- `walk_test.mjs` 有 1 项已知失败("出生在 1F 地面 y=6.00"，出生点在高层，
  属应用既有问题)，21/22 为当前基线
- 改动后端后: `python3 -m py_compile sensor_view/*.py`，再 `diff -r` 金样
