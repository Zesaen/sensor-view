#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
传感器实时展示服务
- TCP 接收:
    9001  IMU 姿态  {"yaw","pitch","roll","mag":[x,y,z]}   (JSON Lines, UTF-8, \n 分隔)
    9002  WiFi 扫描 {"timestamp_ms","aps":[{rank,name,rssi}]}
  支持多设备同时连接/自动重连, 旧连接静默不阻塞新设备
- 8888 端口: Web 界面 + /events (SSE) 实时推送 + /healthz 状态
- 数据采集 API:
    /api/status    采集状态 + 后台已存条数 + 累计/速率
    /api/collect   ?action=start|stop&src=imu|wifi|all&limit=N  开始/停止采集(limit=0 不限量, 达到 N 条自动停)
    /api/download  ?src=imu|wifi&fmt=csv|json                   把后台已采集数据下载为文件
    /api/clear     清空后台数据(采集缓冲 + 累计计数)
- 多地图 API (data/maps/<id>/ 每图一目录: meta.json + map.json + image.<ext>):
    GET  /api/maps                   地图列表 [{id,name,created,updated,opened,counts…}] 按最近打开排序
    POST /api/maps                  {name} 新建地图 → {id}
    GET  /api/maps/<id>/data        地图数据 (?open=1 顺带刷新最近打开时间)
    POST /api/maps/<id>/data        保存地图数据(同旧 /api/map/data 的字段)
    GET  /api/maps/<id>/image       该地图底图
    POST /api/maps/<id>/image       上传底图(二进制体, ?name=xx.png; 空请求体=删除)
    POST /api/maps/<id>/meta        {action:"rename"|"duplicate"|"delete", name?}
    GET  /api/maps/<id>/export      导出为单个 .svmap.json 文件(底图内嵌 base64)
    POST /api/maps/import           导入 .svmap.json(或旧版 map.json) → 新地图(测点重新编号)
    GET  /api/map                   旧版兼容: 返回最近打开地图的数据
    POST /api/map/data|image        旧版兼容: 保存到最近打开的地图
    GET  /api/map/templates          绘图模板列表 [{name, walls, doors, tables, stairs, lifts, routers, time}]
    POST /api/map/templates         {action:"save", name, walls, doors, tables, stairs, lifts, routers} 存/覆盖同名
                                    {action:"del", name} 删除
  首次启动时旧版 data/map.json 自动迁移为第一张地图
- 采集数据库 API (SQLite, data/sensors.db, 存地图按点采集的样本):
    GET  /api/db/stats                总条数 + 按测点统计 + 库大小
    GET  /api/db/list                 ?kind=imu|wifi&point_id=&page=&size=  分页查询
    GET  /api/db/agg                  ?point_id=  按点聚合(均值/条数, 库被改后随之更新)
    GET  /api/db/export               ?kind=&fmt=csv|json&point_id=        从库导出文件
    POST /api/db/bulk                 {point_id, imu:[], wifi:[], replace}  批量入库(replace=先清该点旧行)
    POST /api/db/insert               {kind, point_id, fields:{列:值}}      手动新增一行
    POST /api/db/update               {kind, id, fields:{列:值}}            部分更新(白名单列)
    POST /api/db/delete               {ids:[{kind,id}]} | {point_id} | {all:true}
"""
import base64
import glob
import json
import math
import os
import queue
import re
import shutil
import socket
import sqlite3
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote

ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(ROOT, "public")
DATA = os.path.join(ROOT, "data")
WEB_PORT = 8888
IDLE_TIMEOUT = 300            # 连接静默 5 分钟后断开, 避免死连接占位

MAP_FILE = os.path.join(DATA, "map.json")            # {points, walls, doors, tables, origin, gridSize}
LEGACY_POINTS_FILE = os.path.join(DATA, "map_points.json")
MAP_IMAGE_BASE = os.path.join(DATA, "map_image")     # 实际文件名带扩展名
TPL_FILE = os.path.join(DATA, "map_templates.json")  # 绘图模板列表
IMAGE_MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
              ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp"}
MAX_MAP_BODY = 8 * 1024 * 1024                       # 地图数据 JSON 上限
MAX_IMAGE_BODY = 12 * 1024 * 1024                    # 地图图片上限


def load_templates():
    try:
        with open(TPL_FILE, "r", encoding="utf-8") as f:
            tpls = json.load(f)
        return tpls if isinstance(tpls, list) else []
    except (OSError, ValueError):
        return []


def load_map_data():
    data = {"points": [], "walls": [], "doors": [], "tables": [], "chairs": [], "stairs": [], "lifts": [], "routers": [],
            "floors": [], "curFloor": "",
            "origin": {"x": 0, "y": 0}, "gridSize": 50,
            "wallThick": 10, "thickUnit": "m", "pxPerM": 50, "gridOn": True,
            "gridMinorOn": True}
    try:
        with open(MAP_FILE, "r", encoding="utf-8") as f:
            saved = json.load(f)
        if isinstance(saved, dict):
            for k in data:
                if k in saved:
                    data[k] = saved[k]
    except (OSError, ValueError):
        try:                                          # 兼容旧版仅存坐标点的文件
            with open(LEGACY_POINTS_FILE, "r", encoding="utf-8") as f:
                data["points"] = json.load(f)
        except (OSError, ValueError):
            pass
    return data

# ---------------- 多地图存储 ----------------
# data/maps/<mid>/meta.json  {id,name,created,updated,opened,points,walls,…,image}
#             /map.json      地图数据(与旧版 data/map.json 同构)
#             /image.<ext>   该地图的底图(可选)
MAPS_DIR = os.path.join(DATA, "maps")
MAP_ID_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z_.-]{2,40}$")
MAX_IMPORT_BODY = 24 * 1024 * 1024                 # 导入 .svmap.json 上限(含内嵌底图)
meta_lock = threading.Lock()


def _now_str():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def new_map_id():
    return time.strftime("%Y%m%d-%H%M%S-") + os.urandom(3).hex()


def map_paths(mid):
    d = os.path.join(MAPS_DIR, mid)
    return d, os.path.join(d, "meta.json"), os.path.join(d, "map.json"), os.path.join(d, "image")


def valid_map_id(mid):
    return bool(mid) and bool(MAP_ID_RE.match(mid)) and os.path.isdir(os.path.join(MAPS_DIR, mid))


def load_map_meta(mid):
    _, mfp, _, _ = map_paths(mid)
    try:
        with open(mfp, "r", encoding="utf-8") as f:
            meta = json.load(f)
        meta["id"] = mid
        return meta if isinstance(meta, dict) else None
    except (OSError, ValueError):
        return None


def save_map_meta(mid, meta):
    _, mfp, _, _ = map_paths(mid)
    tmp = mfp + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False)
    os.replace(tmp, mfp)


def touch_map_meta(mid, **fields):
    with meta_lock:
        meta = load_map_meta(mid)
        if meta is None:
            return None
        meta.update(fields)
        save_map_meta(mid, meta)
        return meta


def read_map_data(mid):
    _, _, jfp, _ = map_paths(mid)
    base = {"points": [], "walls": [], "doors": [], "tables": [], "chairs": [], "stairs": [], "lifts": [], "routers": [],
            "floors": [], "curFloor": "",
            "origin": {"x": 0, "y": 0}, "gridSize": 50,
            "wallThick": 10, "thickUnit": "m", "pxPerM": 50, "gridOn": True,
            "gridMinorOn": True}
    try:
        with open(jfp, "r", encoding="utf-8") as f:
            saved = json.load(f)
        if isinstance(saved, dict):
            for k in base:
                if k in saved:
                    base[k] = saved[k]
    except (OSError, ValueError):
        pass
    return base


def map_image_file(mid):
    _, _, _, ibase = map_paths(mid)
    for ext in IMAGE_MIME:
        fp = ibase + ext
        if os.path.isfile(fp):
            return fp
    return None


def map_counts(mid, data):
    return meta_counts(mid, data)


def list_maps():
    """全部地图 meta, 按最近打开时间倒序(无则按更新时间)"""
    out = []
    try:
        names = os.listdir(MAPS_DIR)
    except OSError:
        return out
    for mid in names:
        if not valid_map_id(mid):
            continue
        meta = load_map_meta(mid)
        if meta:
            out.append(meta)
    out.sort(key=lambda m: (m.get("opened") or "", m.get("updated") or ""), reverse=True)
    return out


def newest_map_id():
    maps = list_maps()
    return maps[0]["id"] if maps else None


def clean_map_payload(saved):
    """前端提交的地图数据白名单清洗(旧 /api/map/data 同款逻辑)"""
    try:
        wall_thick = float(saved.get("wallThick"))
    except (TypeError, ValueError):
        wall_thick = 10.0
    try:
        px_per_m = float(saved.get("pxPerM"))
    except (TypeError, ValueError):
        px_per_m = 50.0
    floors = [f for f in (saved.get("floors") or []) if isinstance(f, dict)] \
        if isinstance(saved.get("floors"), list) else []
    return {
        "points": saved.get("points") if isinstance(saved.get("points"), list) else [],
        "walls": saved.get("walls") if isinstance(saved.get("walls"), list) else [],
        "doors": saved.get("doors") if isinstance(saved.get("doors"), list) else [],
        "tables": saved.get("tables") if isinstance(saved.get("tables"), list) else [],
        "chairs": saved.get("chairs") if isinstance(saved.get("chairs"), list) else [],
        "stairs": saved.get("stairs") if isinstance(saved.get("stairs"), list) else [],
        "lifts": saved.get("lifts") if isinstance(saved.get("lifts"), list) else [],
        "routers": saved.get("routers") if isinstance(saved.get("routers"), list) else [],
        "floors": floors,
        "curFloor": saved.get("curFloor") if isinstance(saved.get("curFloor"), str) else "",
        "origin": saved.get("origin") if isinstance(saved.get("origin"), dict) else {"x": 0, "y": 0},
        "gridSize": saved.get("gridSize") if isinstance(saved.get("gridSize"), (int, float)) else 50,
        "wallThick": max(1.0, wall_thick),
        "thickUnit": saved.get("thickUnit") if saved.get("thickUnit") in ("px", "m") else "m",
        "pxPerM": max(1.0, px_per_m),
        "gridOn": bool(saved.get("gridOn", True)),
        "gridMinorOn": bool(saved.get("gridMinorOn", True)),
    }


def save_map_data_file(mid, data):
    _, _, jfp, _ = map_paths(mid)
    tmp = jfp + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, jfp)


def meta_counts(mid, data):
    return {"points": len(data.get("points") or []),
            "walls": len(data.get("walls") or []),
            "doors": len(data.get("doors") or []),
            "tables": len(data.get("tables") or []),
            "routers": len(data.get("routers") or []),
            "image": bool(map_image_file(mid))}


def regen_point_ids(data):
    """复制/导入地图时给测点换新 id, 避免与原图共用 SQLite 采样记录(含各楼层)"""
    def regen(points):
        for p in points or []:
            if isinstance(p, dict):
                p["id"] = "m" + os.urandom(7).hex()
    regen(data.get("points"))
    for f in data.get("floors") or []:
        if isinstance(f, dict):
            regen(f.get("points"))


def db_delete_points(point_ids):
    if not point_ids:
        return 0
    with db_lock:
        cur = db.cursor()
        n = 0
        for i in range(0, len(point_ids), 500):
            chunk = point_ids[i:i + 500]
            ph = ",".join("?" * len(chunk))
            cur.execute("DELETE FROM imu WHERE point_id IN (%s)" % ph, chunk)
            n += cur.rowcount if cur.rowcount > 0 else 0
            cur.execute("DELETE FROM wifi WHERE point_id IN (%s)" % ph, chunk)
            n += cur.rowcount if cur.rowcount > 0 else 0
        db.commit()
    return n


def empty_map_data():
    return {"points": [], "walls": [], "doors": [], "tables": [], "chairs": [], "stairs": [], "lifts": [], "routers": [],
            "origin": {"x": 0, "y": 0}, "gridSize": 50,
            "wallThick": 10, "thickUnit": "m", "pxPerM": 50, "gridOn": True,
            "gridMinorOn": True}


def create_map(name, data=None):
    mid = new_map_id()
    d, _, _, _ = map_paths(mid)
    os.makedirs(d, exist_ok=True)
    data = empty_map_data() if data is None else data   # 新建 = 空白地图
    save_map_data_file(mid, data)
    meta = {"id": mid, "name": name, "created": _now_str(), "updated": _now_str(),
            "opened": _now_str()}
    meta.update(meta_counts(mid, data))
    save_map_meta(mid, meta)
    return mid


def duplicate_map(mid, name):
    src_meta = load_map_meta(mid) or {}
    data = read_map_data(mid)
    regen_point_ids(data)
    new_id = create_map(name or ((src_meta.get("name") or "地图") + " - 副本"), data)
    img = map_image_file(mid)
    if img:
        _, _, _, ibase = map_paths(new_id)
        shutil.copyfile(img, ibase + os.path.splitext(img)[1].lower())
        touch_map_meta(new_id, image=True)
    return new_id


def delete_map(mid):
    _, mfp, jfp, _ = map_paths(mid)
    ids = []
    try:
        with open(jfp, "r", encoding="utf-8") as f:
            d = json.load(f)
        for p in (d.get("points") or []):
            if isinstance(p, dict) and p.get("id"):
                ids.append(str(p["id"]))
        for fl in (d.get("floors") or []):        # 多楼层: 各层测点采样一并清理
            if isinstance(fl, dict):
                for p in (fl.get("points") or []):
                    if isinstance(p, dict) and p.get("id"):
                        ids.append(str(p["id"]))
    except (OSError, ValueError, AttributeError):
        pass
    shutil.rmtree(os.path.join(MAPS_DIR, mid), ignore_errors=True)
    n = db_delete_points(ids)
    log("[maps] 删除地图 %s (连带采样 %d 条)" % (mid, n))


def ensure_maps_migrated():
    """首次启动: 旧版单地图 data/map.json + map_image.* → 迁移为第一张地图"""
    os.makedirs(MAPS_DIR, exist_ok=True)
    if os.listdir(MAPS_DIR):
        return
    if not os.path.isfile(MAP_FILE):
        return
    saved = load_map_data()
    mid = create_map("默认地图", saved)
    has_img = False
    for ext in IMAGE_MIME:
        src = MAP_IMAGE_BASE + ext
        if os.path.isfile(src):
            _, _, _, ibase = map_paths(mid)
            shutil.copyfile(src, ibase + ext)
            has_img = True
            break
    if has_img:
        touch_map_meta(mid, image=True)
    log("[maps] 旧版单地图已迁移 → %s" % mid)


def map_data_response(mid, bump_opened=False):
    meta = load_map_meta(mid) or {}
    data = read_map_data(mid)
    img = map_image_file(mid)
    data["image"] = ("/api/maps/%s/image?v=%d" % (mid, int(os.path.getmtime(img)))) if img else None
    if bump_opened:
        touch_map_meta(mid, opened=_now_str())
    return {"ok": True, "id": mid, "name": meta.get("name") or "未命名地图", "data": data}


TCP_SOURCES = {
    "imu": 9001,
    "rssi": 9002,
}

# ---------------- 采集数据库 (SQLite) ----------------
# 地图按点采集的 IMU/WiFi 样本持久化; 前端 burst 采满/旧数据迁移时 POST /api/db/bulk 入库
DB_FILE = os.path.join(DATA, "sensors.db")
os.makedirs(DATA, exist_ok=True)
DB_COLS = {                                        # 除 id/point_id 外的业务列(兼做白名单)
    "imu": ["ts", "ori", "yaw", "pitch", "roll", "mag_x", "mag_y", "mag_z"],
    "wifi": ["ts", "ori", "yaw", "scan_no", "ap_name", "rssi"],
}
DB_TYPES = {                                       # insert/update 时的类型转换
    "ts": "num", "ori": "int", "yaw": "num", "pitch": "num", "roll": "num",
    "mag_x": "num", "mag_y": "num", "mag_z": "num",
    "scan_no": "int", "ap_name": "str", "rssi": "int",
}
MAX_DB_BODY = 32 * 1024 * 1024                     # /api/db/bulk 请求体上限

db = sqlite3.connect(DB_FILE, check_same_thread=False)
db_lock = threading.Lock()
db.executescript("""
CREATE TABLE IF NOT EXISTS imu (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    point_id TEXT NOT NULL,
    ts REAL NOT NULL,                -- 客户端采集时刻(epoch 毫秒)
    ori INTEGER,                     -- 朝向槽 0/90/180/270
    yaw REAL, pitch REAL, roll REAL,
    mag_x REAL, mag_y REAL, mag_z REAL);
CREATE INDEX IF NOT EXISTS idx_imu_pt ON imu(point_id, ts);
CREATE TABLE IF NOT EXISTS wifi (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    point_id TEXT NOT NULL,
    ts REAL NOT NULL,                -- 客户端扫描时刻(epoch 毫秒)
    ori INTEGER, yaw REAL,           -- yaw=采该扫描时的实测姿态
    scan_no INTEGER,                 -- 该点第几次扫描
    ap_name TEXT NOT NULL, rssi INTEGER);
CREATE INDEX IF NOT EXISTS idx_wifi_pt ON wifi(point_id, ts);
""")
db.commit()


def _num(v, default=None):
    if v is None or v == "":
        return default
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _int(v):
    n = _num(v)
    return None if n is None else int(round(n))


def _coerce(col, v):
    """insert/update 字段类型转换; 数值列非法值抛 ValueError, 空串转 NULL"""
    if DB_TYPES.get(col) == "str":
        return "" if v is None else str(v)[:100]
    if v is None or v == "":
        return None
    n = _num(v)
    if n is None:
        raise ValueError("字段 %s 需要数值" % col)
    return int(n) if DB_TYPES.get(col) == "int" else n


def _fmt_ms(ts):
    ts = _num(ts, 0.0)
    return _fmt_ts(ts / 1000.0 if ts > 1e11 else ts)


def db_bulk_insert(point_id, imu, wifi, replace):
    """按点写入样本. imu: [{t,yaw,pitch,roll,mag,ori}], wifi: [{t,aps:[{name,rssi}],ori,yaw,scan_no}]
    replace=True 先删该点旧行再插入(burst 重采/旧数据迁移的幂等写入)"""
    imu_rows, wifi_rows = [], []
    for s in imu if isinstance(imu, list) else []:
        if not isinstance(s, dict):
            continue
        m = s.get("mag") if isinstance(s.get("mag"), list) else []
        imu_rows.append((point_id, _num(s.get("t"), time.time() * 1000), _int(s.get("ori")),
                         _num(s.get("yaw")), _num(s.get("pitch")), _num(s.get("roll")),
                         _num(m[0]) if len(m) > 0 else None,
                         _num(m[1]) if len(m) > 1 else None,
                         _num(m[2]) if len(m) > 2 else None))
    for sc in wifi if isinstance(wifi, list) else []:
        if not isinstance(sc, dict):
            continue
        for ap in (sc.get("aps") if isinstance(sc.get("aps"), list) else []):
            ap = ap if isinstance(ap, dict) else {}
            wifi_rows.append((point_id, _num(sc.get("t"), time.time() * 1000), _int(sc.get("ori")),
                              _num(sc.get("yaw")), _int(sc.get("scan_no")),
                              str(ap.get("name") or "")[:100], _int(ap.get("rssi"))))
    with db_lock:
        cur = db.cursor()
        try:
            if replace:
                cur.execute("DELETE FROM imu WHERE point_id=?", (point_id,))
                cur.execute("DELETE FROM wifi WHERE point_id=?", (point_id,))
            if imu_rows:
                cur.executemany(
                    "INSERT INTO imu(point_id,ts,ori,yaw,pitch,roll,mag_x,mag_y,mag_z)"
                    " VALUES(?,?,?,?,?,?,?,?,?)", imu_rows)
            if wifi_rows:
                cur.executemany(
                    "INSERT INTO wifi(point_id,ts,ori,yaw,scan_no,ap_name,rssi)"
                    " VALUES(?,?,?,?,?,?,?)", wifi_rows)
            db.commit()
        except Exception:
            db.rollback()
            raise
    return len(imu_rows), len(wifi_rows)


latest = {"imu": None, "rssi": None}
last_ts = {"imu": 0.0, "rssi": 0.0}
counts = {"imu": 0, "rssi": 0}
rates = {"imu": 0.0, "rssi": 0.0}

# ---------------- 后台数据采集 ----------------
HISTORY_CAP = 200000          # 每个数据源后台最多保留条数, 超出自动丢弃最旧
history = {"imu": deque(maxlen=HISTORY_CAP), "rssi": deque(maxlen=HISTORY_CAP)}
hist_lock = threading.Lock()
# 采集会话: active=记录中, limit=目标条数(0=不限量, 手动停), taken=本会话已记录条数
record = {
    "imu":  {"active": False, "limit": 0, "taken": 0},
    "rssi": {"active": False, "limit": 0, "taken": 0},
}


def record_sample(name, obj):
    """采集会话进行中时把样本写入后台缓冲; 设了目标条数则到量自动停"""
    with hist_lock:
        r = record[name]
        if not r["active"]:
            return
        history[name].append({"ts": time.time(), "data": obj})
        r["taken"] += 1
        if r["limit"] and r["taken"] >= r["limit"]:
            r["active"] = False
            log("[%s] 采集完成, 共 %d 条" % (name, r["taken"]))

clients = set()               # 每个 SSE 客户端一个队列
clients_lock = threading.Lock()

os.makedirs(DATA, exist_ok=True)


def broadcast(event, data):
    msg = "event: %s\ndata: %s\n\n" % (event, json.dumps(data, ensure_ascii=False))
    with clients_lock:
        dead = []
        for q in clients:
            try:
                q.put_nowait(msg)
            except Exception:
                dead.append(q)                # 慢客户端队列满, 直接丢弃
        for q in dead:
            clients.discard(q)


def log(msg):
    print(time.strftime("[%H:%M:%S] ") + msg, flush=True)


# ---------------- TCP 数据接收 ----------------

def handle_conn(name, conn, addr):
    """单条设备连接: 逐行解析 JSON 并广播"""
    peer = "%s:%d" % addr
    log("[%s] 设备接入 %s" % (name, peer))
    conn.settimeout(IDLE_TIMEOUT)
    buf = b""
    try:
        while True:
            chunk = conn.recv(8192)
            if not chunk:
                break
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                line = line.decode("utf-8", "ignore").strip()
                if not line.startswith("{"):
                    continue
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                latest[name] = obj
                last_ts[name] = time.time()
                counts[name] += 1
                broadcast(name, obj)
                record_sample(name, obj)
    except (socket.timeout, ConnectionResetError, OSError):
        pass
    finally:
        try:
            conn.close()
        except OSError:
            pass
        log("[%s] 设备断开 %s" % (name, peer))


def tcp_source(name, port):
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        srv.bind(("0.0.0.0", port))
    except OSError as e:
        log("[%s] 端口 %d 绑定失败: %s" % (name, port, e))
        return
    srv.listen(8)
    log("[%s] 监听 0.0.0.0:%d" % (name, port))
    while True:
        try:
            conn, addr = srv.accept()
        except OSError:
            time.sleep(0.5)
            continue
        threading.Thread(target=handle_conn, args=(name, conn, addr), daemon=True).start()


# ---------------- Web 服务 ----------------

STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    **IMAGE_MIME,
}


def _fmt_ts(ts):
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts)) + ".%03d" % int(ts % 1 * 1000)


def _cell(v):
    return "" if v is None else str(v)


def imu_csv(rows):
    out = ["time,yaw,pitch,roll,mag_x,mag_y,mag_z"]
    for r in rows:
        d = r["data"]
        m = d.get("mag") or [None, None, None]
        cells = [_fmt_ts(r["ts"]), d.get("yaw"), d.get("pitch"), d.get("roll"), *m[:3]]
        out.append(",".join(_cell(c) for c in cells))
    return "\n".join(out) + "\n"


def rssi_csv(rows):
    out = ["scan_time,scan_id,rank,name,rssi_dbm"]
    for scan_id, r in enumerate(rows, 1):
        t = _fmt_ts(r["ts"])
        for ap in (r["data"].get("aps") or []):
            nm = '"%s"' % str(ap.get("name", "")).replace('"', '""')
            out.append(",".join([t, str(scan_id), _cell(ap.get("rank")), nm, _cell(ap.get("rssi"))]))
    return "\n".join(out) + "\n"


def rows_json(rows):
    return json.dumps(
        [{"time": _fmt_ts(r["ts"]), "data": r["data"]} for r in rows],
        ensure_ascii=False, indent=1)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):        # 静默默认访问日志
        pass

    def send_file(self, path):
        try:
            with open(path, "rb") as f:
                body = f.read()
        except OSError:
            self.send_response(404)
            self.end_headers()
            return
        ext = os.path.splitext(path)[1].lower()
        self.send_response(200)
        self.send_header("Content-Type", STATIC_TYPES.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def api_status(self):
        with hist_lock:
            body = {
                "recording": {k: dict(v) for k, v in record.items()},
                "history": {k: len(v) for k, v in history.items()},
                "counts": dict(counts),
                "rates": dict(rates),
            }
        self.send_json(body)

    def api_collect(self, qs):
        action = (qs.get("action") or ["start"])[0]
        src = (qs.get("src") or ["all"])[0]
        try:
            limit = max(0, int((qs.get("limit") or ["0"])[0]))
        except ValueError:
            limit = 0
        names = {"imu": ["imu"], "wifi": ["rssi"], "all": ["imu", "rssi"]}.get(src)
        if not names or action not in ("start", "stop"):
            self.send_json({"ok": False, "error": "参数无效"}, 400)
            return
        with hist_lock:
            for n in names:
                r = record[n]
                if action == "start":
                    r["active"] = True
                    r["limit"] = limit
                    r["taken"] = 0
                else:
                    r["active"] = False
        log("采集%s: src=%s limit=%d" % ("开始" if action == "start" else "停止", src, limit))
        self.api_status()

    def api_clear(self):
        with hist_lock:
            for n in history:
                history[n].clear()
                record[n]["active"] = False
                record[n]["taken"] = 0
            for n in counts:
                counts[n] = 0
                rates[n] = 0.0
                last_ts[n] = 0.0
                latest[n] = None
        log("后台数据已清空")
        self.api_status()

    def api_download(self, qs):
        src = (qs.get("src") or ["imu"])[0]
        fmt = (qs.get("fmt") or ["csv"])[0]
        key = {"imu": "imu", "wifi": "rssi"}.get(src)
        if not key:
            self.send_json({"ok": False, "error": "src 参数无效"}, 400)
            return
        with hist_lock:
            rows = list(history[key])
        stamp = time.strftime("%Y%m%d_%H%M%S")
        if fmt == "json":
            body = rows_json(rows).encode("utf-8")
            ctype = "application/json; charset=utf-8"
            fname = "%s_%s.json" % (src, stamp)
        else:
            text = imu_csv(rows) if key == "imu" else rssi_csv(rows)
            body = b"\xef\xbb\xbf" + text.encode("utf-8")   # 带 BOM, Excel 直接打开不乱码
            ctype = "text/csv; charset=utf-8"
            fname = "%s_%s.csv" % (src, stamp)
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Disposition", 'attachment; filename="%s"' % fname)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ---------------- 采集数据库 ----------------

    def db_json_body(self):
        body = self.read_body(MAX_DB_BODY)
        if body is None:
            self.send_json({"ok": False, "error": "数据过大"}, 413)
            return None
        try:
            req = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self.send_json({"ok": False, "error": "JSON 无效"}, 400)
            return None
        if not isinstance(req, dict):
            self.send_json({"ok": False, "error": "JSON 需为对象"}, 400)
            return None
        return req

    def db_point_names(self):
        names = {}
        for p in load_map_data().get("points") or []:
            if isinstance(p, dict) and p.get("id") is not None:
                names[str(p.get("id"))] = str(p.get("name") or p.get("id"))
        return names

    def api_db_stats(self):
        with db_lock:
            n_imu = db.execute("SELECT COUNT(*) FROM imu").fetchone()[0]
            n_wifi = db.execute("SELECT COUNT(*) FROM wifi").fetchone()[0]
            pts = {}
            for pid, n in db.execute("SELECT point_id, COUNT(*) FROM imu GROUP BY point_id"):
                pts.setdefault(pid, {"point_id": pid, "imu": 0, "wifi": 0})["imu"] = n
            for pid, n in db.execute("SELECT point_id, COUNT(*) FROM wifi GROUP BY point_id"):
                pts.setdefault(pid, {"point_id": pid, "imu": 0, "wifi": 0})["wifi"] = n
        try:
            size = os.path.getsize(DB_FILE)
        except OSError:
            size = 0
        self.send_json({"ok": True, "imu": n_imu, "wifi": n_wifi,
                        "by_point": sorted(pts.values(), key=lambda d: -(d["imu"] + d["wifi"])),
                        "db_bytes": size})

    def api_db_list(self, qs):
        kind = (qs.get("kind") or ["imu"])[0]
        if kind not in DB_COLS:
            return self.send_json({"ok": False, "error": "kind 参数无效"}, 400)
        point_id = (qs.get("point_id") or [""])[0].strip()
        page = max(1, _int((qs.get("page") or ["1"])[0]) or 1)
        size = min(200, max(1, _int((qs.get("size") or ["50"])[0]) or 50))
        where, args = "", []
        if point_id:
            where, args = " WHERE point_id=?", [point_id]
        cols = ["id", "point_id"] + DB_COLS[kind]
        with db_lock:
            total = db.execute("SELECT COUNT(*) FROM %s%s" % (kind, where), args).fetchone()[0]
            rows = db.execute("SELECT %s FROM %s%s ORDER BY id DESC LIMIT ? OFFSET ?"
                              % (",".join(cols), kind, where),
                              args + [size, (page - 1) * size]).fetchall()
        self.send_json({"ok": True, "total": total, "page": page, "size": size,
                        "rows": [dict(zip(cols, r)) for r in rows]})

    def api_db_export(self, qs):
        kind = (qs.get("kind") or ["imu"])[0]
        fmt = (qs.get("fmt") or ["csv"])[0]
        point_id = (qs.get("point_id") or [""])[0].strip()
        if kind not in list(DB_COLS) + ["all"] or fmt not in ("csv", "json"):
            return self.send_json({"ok": False, "error": "参数无效"}, 400)
        where, args = "", []
        if point_id:
            where, args = " WHERE point_id=?", [point_id]

        def fetch(k):
            cols = ["id", "point_id"] + DB_COLS[k]
            with db_lock:
                return [dict(zip(cols, r)) for r in db.execute(
                    "SELECT %s FROM %s%s ORDER BY point_id, id"
                    % (",".join(cols), k, where), args)]

        map_pts = load_map_data().get("points") or []
        names, order = {}, []
        for p in map_pts:
            if isinstance(p, dict) and p.get("id") is not None:
                pid = str(p.get("id"))
                names[pid] = str(p.get("name") or pid)
                order.append(pid)

        def pt_no(pid):                       # 编号 = 测点在地图中的顺序
            if pid not in order:
                names.setdefault(pid, pid)
                order.append(pid)
            return order.index(pid) + 1

        def q(s):                             # CSV 引号转义
            return '"%s"' % str(s if s is not None else "").replace('"', '""')

        stamp = time.strftime("%Y%m%d_%H%M%S")
        kinds = list(DB_COLS) if kind == "all" else [kind]
        if fmt == "json":
            data = {k: fetch(k) for k in kinds}
            body = json.dumps(data if kind == "all" else data[kind],
                              ensure_ascii=False, indent=1).encode("utf-8")
            ctype = "application/json; charset=utf-8"
            fname = "db_%s_%s.json" % (kind, stamp)
        else:
            out = []
            if kind in ("imu", "all"):
                if kind == "all":
                    out.append("[姿态逐条数据]")
                    out.append("编号,名称,样本#,朝向(°),时间,Yaw(°),Pitch(°),Roll(°),"
                               "MagX(µT),MagY(µT),MagZ(µT)")
                else:
                    out.append("id,测点,名称,朝向(°),时间,yaw,pitch,roll,mag_x,mag_y,mag_z")
                seq = {}
                for d in fetch("imu"):
                    seq[d["point_id"]] = seq.get(d["point_id"], 0) + 1
                    if kind == "all":
                        cells = [pt_no(d["point_id"]), names.get(d["point_id"], ""),
                                 seq[d["point_id"]], d["ori"], _fmt_ms(d["ts"]),
                                 d["yaw"], d["pitch"], d["roll"],
                                 d["mag_x"], d["mag_y"], d["mag_z"]]
                    else:
                        cells = [d["id"], d["point_id"], names.get(d["point_id"], ""),
                                 d["ori"], _fmt_ms(d["ts"]), d["yaw"], d["pitch"], d["roll"],
                                 d["mag_x"], d["mag_y"], d["mag_z"]]
                    out.append(",".join(_cell(c) for c in cells))
            if kind in ("wifi", "all"):
                if kind == "all" and out:
                    out.append("")          # 两段之间的空行
                if kind == "all":
                    out.append("[WiFi逐条数据]")
                    out.append("编号,名称,扫描#,朝向(°),实测Yaw(°),时间,AP名称,RSSI(dBm)")
                else:
                    out.append("id,测点,名称,扫描#,朝向(°),实测yaw(°),时间,AP名称,RSSI(dBm)")
                seq = {}
                for d in fetch("wifi"):
                    seq[d["point_id"]] = seq.get(d["point_id"], 0) + 1
                    if kind == "all":
                        cells = [pt_no(d["point_id"]), q(names.get(d["point_id"], "")),
                                 seq[d["point_id"]], d["ori"], d["yaw"], _fmt_ms(d["ts"]),
                                 q(d["ap_name"]), d["rssi"]]
                    else:
                        cells = [d["id"], d["point_id"], q(names.get(d["point_id"], "")),
                                 d["scan_no"], d["ori"], d["yaw"], _fmt_ms(d["ts"]),
                                 q(d["ap_name"]), d["rssi"]]
                    out.append(",".join(_cell(c) for c in cells))
            body = b"\xef\xbb\xbf" + ("\n".join(out) + "\n").encode("utf-8")
            ctype = "text/csv; charset=utf-8"
            fname = "db_%s_%s.csv" % (kind, stamp)
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Disposition", 'attachment; filename="%s"' % fname)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def api_db_agg(self, qs):
        """按点聚合(SQLite 为准): 供详情面板均值/汇总导出, 库中记录被改后均值随之更新"""
        point_id = (qs.get("point_id") or [""])[0].strip()
        names = self.db_point_names()
        with db_lock:
            pts = set(r[0] for r in db.execute("SELECT DISTINCT point_id FROM imu"))
            pts |= set(r[0] for r in db.execute("SELECT DISTINCT point_id FROM wifi"))
            if point_id:
                pts &= {point_id}
            out = []
            for pid in sorted(pts):
                n_imu, ptch, rl_, mx, my, mz = db.execute(
                    "SELECT COUNT(*), AVG(pitch), AVG(roll), AVG(mag_x), AVG(mag_y), AVG(mag_z)"
                    " FROM imu WHERE point_id=?", (pid,)).fetchone()
                yaw = None
                if n_imu:                       # yaw 走圆周均值, 不能直接 AVG
                    sx = sy = 0.0
                    for (y,) in db.execute(
                            "SELECT yaw FROM imu WHERE point_id=? AND yaw IS NOT NULL", (pid,)):
                        sx += math.sin(math.radians(y))
                        sy += math.cos(math.radians(y))
                    yaw = (math.degrees(math.atan2(sx, sy)) + 360) % 360
                n_scans = db.execute(
                    "SELECT COUNT(DISTINCT ts) FROM wifi WHERE point_id=?", (pid,)).fetchone()[0]
                aps = [{"name": nm, "n": c, "rssi": round(a)}
                       for nm, c, a in db.execute(
                           "SELECT ap_name, COUNT(*), AVG(rssi) FROM wifi"
                           " WHERE point_id=? GROUP BY ap_name"
                           " ORDER BY COUNT(*) DESC, ap_name", (pid,))]
                out.append({"point_id": pid, "name": names.get(pid, pid),
                            "n_imu": n_imu, "n_scans": n_scans,
                            "yaw": round(yaw, 2) if yaw is not None else None,
                            "pitch": ptch, "roll": rl_,
                            "mx": mx, "my": my, "mz": mz, "aps": aps})
        self.send_json({"ok": True, "points": out})

    def api_db_bulk(self):
        req = self.db_json_body()
        if req is None:
            return
        point_id = str(req.get("point_id") or "").strip()
        if not point_id:
            return self.send_json({"ok": False, "error": "point_id 不能为空"}, 400)
        try:
            n_imu, n_wifi = db_bulk_insert(point_id, req.get("imu"), req.get("wifi"),
                                           bool(req.get("replace")))
        except Exception as e:
            return self.send_json({"ok": False, "error": "写入失败: %s" % e}, 500)
        log("[db] %s 写入 imu=%d wifi=%d%s"
            % (point_id, n_imu, n_wifi, " (替换)" if req.get("replace") else ""))
        self.send_json({"ok": True, "imu": n_imu, "wifi": n_wifi})

    def api_db_insert(self):
        req = self.db_json_body()
        if req is None:
            return
        kind = req.get("kind")
        point_id = str(req.get("point_id") or "").strip()
        fields = req.get("fields") if isinstance(req.get("fields"), dict) else {}
        if kind not in DB_COLS or not point_id:
            return self.send_json({"ok": False, "error": "kind/point_id 参数无效"}, 400)
        vals = {}
        for col in DB_COLS[kind]:
            if col in fields:
                try:
                    vals[col] = _coerce(col, fields[col])
                except ValueError as e:
                    return self.send_json({"ok": False, "error": str(e)}, 400)
        if not vals.get("ts"):
            vals["ts"] = round(time.time() * 1000)
        if kind == "wifi" and not (vals.get("ap_name") or ""):
            return self.send_json({"ok": False, "error": "ap_name 不能为空"}, 400)
        cols = ["point_id"] + list(vals)
        with db_lock:
            try:
                cur = db.execute("INSERT INTO %s(%s) VALUES(%s)"
                                 % (kind, ",".join(cols), ",".join("?" * len(cols))),
                                 [point_id] + list(vals.values()))
                db.commit()
            except sqlite3.Error as e:
                db.rollback()
                return self.send_json({"ok": False, "error": "写入失败: %s" % e}, 500)
        self.send_json({"ok": True, "id": cur.lastrowid})

    def api_db_update(self):
        req = self.db_json_body()
        if req is None:
            return
        kind = req.get("kind")
        rid = _int(req.get("id"))
        fields = req.get("fields") if isinstance(req.get("fields"), dict) else {}
        if kind not in DB_COLS or rid is None:
            return self.send_json({"ok": False, "error": "kind/id 参数无效"}, 400)
        sets, args = [], []
        for col in DB_COLS[kind]:                   # 列名走白名单, 值全部参数化
            if col in fields:
                try:
                    sets.append("%s=?" % col)
                    args.append(_coerce(col, fields[col]))
                except ValueError as e:
                    return self.send_json({"ok": False, "error": str(e)}, 400)
        if not sets:
            return self.send_json({"ok": False, "error": "无可更新字段"}, 400)
        args.append(rid)
        with db_lock:
            cur = db.execute("UPDATE %s SET %s WHERE id=?" % (kind, ",".join(sets)), args)
            db.commit()
            n = cur.rowcount
        if not n:
            return self.send_json({"ok": False, "error": "记录不存在"}, 404)
        self.send_json({"ok": True, "updated": n})

    def api_db_delete(self):
        req = self.db_json_body()
        if req is None:
            return
        with db_lock:
            cur = db.cursor()
            n = 0
            try:
                if req.get("all"):
                    cur.execute("DELETE FROM imu")
                    n += cur.rowcount
                    cur.execute("DELETE FROM wifi")
                    n += cur.rowcount
                elif str(req.get("point_id") or "").strip():
                    pid = str(req["point_id"]).strip()
                    cur.execute("DELETE FROM imu WHERE point_id=?", (pid,))
                    n += cur.rowcount
                    cur.execute("DELETE FROM wifi WHERE point_id=?", (pid,))
                    n += cur.rowcount
                elif isinstance(req.get("point_ids"), list) and req["point_ids"]:
                    for pid in req["point_ids"]:
                        pid = str(pid).strip()
                        if not pid:
                            continue
                        cur.execute("DELETE FROM imu WHERE point_id=?", (pid,))
                        n += cur.rowcount
                        cur.execute("DELETE FROM wifi WHERE point_id=?", (pid,))
                        n += cur.rowcount
                elif isinstance(req.get("ids"), list) and req["ids"]:
                    for it in req["ids"]:
                        if not isinstance(it, dict):
                            continue
                        k, i = it.get("kind"), _int(it.get("id"))
                        if k in DB_COLS and i is not None:
                            cur.execute("DELETE FROM %s WHERE id=?" % k, (i,))
                            n += cur.rowcount
                else:
                    return self.send_json({"ok": False, "error": "缺少 ids/point_id/all"}, 400)
                db.commit()
            except Exception:
                db.rollback()
                raise
        log("[db] 删除 %d 条" % n)
        self.send_json({"ok": True, "deleted": n})

    # ---------------- 多地图 ----------------

    def read_body(self, limit):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n > limit:
            return None
        return self.rfile.read(n) if n > 0 else b""

    def api_maps_list(self):
        self.send_json({"ok": True, "maps": list_maps()})

    def api_maps_create(self):
        body = self.read_body(64 * 1024)
        if body is None:
            return self.send_json({"ok": False, "error": "数据过大"}, 413)
        try:
            req = json.loads(body.decode("utf-8") or "{}")
        except (ValueError, UnicodeDecodeError):
            req = {}
        name = str((req or {}).get("name") or "未命名地图").strip()[:40] or "未命名地图"
        mid = create_map(name)
        log("[maps] 新建地图 %s「%s」" % (mid, name))
        self.send_json({"ok": True, "id": mid, "name": name})

    def api_map_data_get(self, mid, bump=False):
        if not valid_map_id(mid):
            return self.send_json({"ok": False, "error": "地图不存在"}, 404)
        self.send_json(map_data_response(mid, bump_opened=bump))

    def api_map_data_post(self, mid):
        if not valid_map_id(mid):
            return self.send_json({"ok": False, "error": "地图不存在"}, 404)
        body = self.read_body(MAX_MAP_BODY)
        if body is None:
            return self.send_json({"ok": False, "error": "数据过大"}, 413)
        try:
            saved = json.loads(body.decode("utf-8"))
            if not isinstance(saved, dict):
                raise ValueError
            clean = clean_map_payload(saved)
        except (ValueError, UnicodeDecodeError):
            return self.send_json({"ok": False, "error": "JSON 无效"}, 400)
        save_map_data_file(mid, clean)
        counts = meta_counts(mid, clean)
        with meta_lock:
            meta = load_map_meta(mid) or {"id": mid}
            meta.update(counts)
            meta["updated"] = _now_str()
            save_map_meta(mid, meta)
        self.send_json({"ok": True, "points": counts["points"], "walls": counts["walls"]})

    def api_map_image_get(self, mid):
        if not valid_map_id(mid):
            return self.send_json({"ok": False, "error": "地图不存在"}, 404)
        fp = map_image_file(mid)
        if fp:
            return self.send_file(fp)
        self.send_response(404)
        self.end_headers()

    def api_map_image_post(self, mid, qs):
        if not valid_map_id(mid):
            return self.send_json({"ok": False, "error": "地图不存在"}, 404)
        body = self.read_body(MAX_IMAGE_BODY)
        if body is None:
            return self.send_json({"ok": False, "error": "图片超过 10MB"}, 413)
        _, _, _, ibase = map_paths(mid)
        for old in glob.glob(ibase + ".*"):      # 扩展名可能变化, 清掉旧图
            try:
                os.remove(old)
            except OSError:
                pass
        if not body:                              # 空请求体 = 删除底图
            touch_map_meta(mid, image=False, updated=_now_str())
            return self.send_json({"ok": True, "image": False})
        name = (qs.get("name") or ["map.png"])[0]
        ext = os.path.splitext(name)[1].lower()
        if ext not in IMAGE_MIME:
            ext = ".png"
        with open(ibase + ext, "wb") as f:
            f.write(body)
        touch_map_meta(mid, image=True, updated=_now_str())
        log("[maps] %s 底图已更新 (%d bytes)" % (mid, len(body)))
        self.send_json({"ok": True, "image": True})

    def api_map_meta_post(self, mid, qs):
        if not valid_map_id(mid):
            return self.send_json({"ok": False, "error": "地图不存在"}, 404)
        body = self.read_body(1024 * 1024)
        if body is None:
            return self.send_json({"ok": False, "error": "数据过大"}, 413)
        try:
            req = json.loads(body.decode("utf-8"))
            action = req.get("action")
            name = str(req.get("name") or "").strip()[:40]
        except (ValueError, UnicodeDecodeError, AttributeError):
            return self.send_json({"ok": False, "error": "JSON 无效"}, 400)
        if action == "rename":
            if not name:
                return self.send_json({"ok": False, "error": "名称不能为空"}, 400)
            touch_map_meta(mid, name=name, updated=_now_str())
            self.send_json({"ok": True, "name": name})
        elif action == "duplicate":
            new_id = duplicate_map(mid, name or None)
            log("[maps] 复制 %s → %s" % (mid, new_id))
            self.send_json({"ok": True, "id": new_id})
        elif action == "delete":
            delete_map(mid)
            self.send_json({"ok": True})
        else:
            self.send_json({"ok": False, "error": "action 无效"}, 400)

    def api_map_export(self, mid):
        if not valid_map_id(mid):
            return self.send_json({"ok": False, "error": "地图不存在"}, 404)
        meta = load_map_meta(mid) or {}
        data = read_map_data(mid)
        image_url = None
        fp = map_image_file(mid)
        if fp:
            with open(fp, "rb") as f:
                b = f.read()
            ext = os.path.splitext(fp)[1].lower()
            image_url = "data:%s;base64,%s" % (IMAGE_MIME.get(ext, "application/octet-stream"),
                                               base64.b64encode(b).decode())
        payload = {"app": "sensor-view", "type": "map", "version": 1,
                   "name": meta.get("name") or "未命名地图", "exported": _now_str(),
                   "data": data, "image": image_url}
        body = json.dumps(payload, ensure_ascii=False).encode()
        fn = re.sub(r'[\\/:*?"<>|\s]+', "_", meta.get("name") or "map") or "map"
        fn_ascii = fn.encode("ascii", "ignore").decode() or "map"   # HTTP 头不吃非 ASCII
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Disposition",
                         "attachment; filename=%s.svmap.json; filename*=UTF-8''%s.svmap.json"
                         % (fn_ascii, quote(fn)))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def api_maps_import(self, qs):
        body = self.read_body(MAX_IMPORT_BODY)
        if body is None:
            return self.send_json({"ok": False, "error": "文件超过 24MB"}, 413)
        try:
            obj = json.loads(body.decode("utf-8"))
            if not isinstance(obj, dict):
                raise ValueError
        except (ValueError, UnicodeDecodeError):
            return self.send_json({"ok": False, "error": "不是有效的地图文件(JSON)"}, 400)
        if obj.get("type") == "map" and isinstance(obj.get("data"), dict):
            name, data, img = obj.get("name"), clean_map_payload(obj["data"]), obj.get("image")
        else:                                     # 旧版 map.json 裸数据也接受
            name, data, img = (qs.get("name") or [""])[0], clean_map_payload(obj), None
        name = str(name or "").strip()[:40] or "导入地图"
        regen_point_ids(data)
        mid = create_map(name, data)
        if isinstance(img, str) and img.startswith("data:"):
            try:
                head, b64 = img.split(",", 1)
                ext = ".png"
                for e, mime in IMAGE_MIME.items():
                    if mime in head:
                        ext = e
                        break
                _, _, _, ibase = map_paths(mid)
                with open(ibase + ext, "wb") as f:
                    f.write(base64.b64decode(b64))
                touch_map_meta(mid, image=True)
            except (ValueError, OSError):
                log("[maps] 导入地图 %s 的底图解码失败, 忽略底图" % mid)
        log("[maps] 导入地图 %s「%s」" % (mid, name))
        self.send_json({"ok": True, "id": mid, "name": name})

    # 旧版单地图接口 → 作用于最近打开的地图
    def api_map_info(self):
        mid = newest_map_id()
        if not mid:
            return self.send_json({"ok": False, "error": "没有地图"}, 404)
        self.send_json(map_data_response(mid)["data"])

    def api_map_image(self):
        mid = newest_map_id()
        if not mid:
            self.send_response(404)
            return self.end_headers()
        fp = map_image_file(mid)
        if fp:
            return self.send_file(fp)
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        path, _, query = self.path.partition("?")
        qs = parse_qs(query)
        seg = path.split("/")
        if path == "/api/maps":
            self.api_maps_create()
        elif len(seg) == 5 and seg[2] == "maps" and seg[3] and seg[4]:
            mid, res = seg[3], seg[4]
            if res == "data":
                self.api_map_data_post(mid)
            elif res == "image":
                self.api_map_image_post(mid, qs)
            elif res == "meta":
                self.api_map_meta_post(mid, qs)
            else:
                self.send_json({"ok": False, "error": "未知接口"}, 404)
        elif path == "/api/maps/import":
            self.api_maps_import(qs)
        elif path == "/api/map/data":           # 旧版兼容: 保存到最近打开的地图
            mid = newest_map_id()
            if not mid:
                return self.send_json({"ok": False, "error": "没有地图"}, 404)
            self.api_map_data_post(mid)
        elif path == "/api/map/image":
            mid = newest_map_id()
            if not mid:
                return self.send_json({"ok": False, "error": "没有地图"}, 404)
            self.api_map_image_post(mid, qs)
        elif path == "/api/map/templates":
            body = self.read_body(1024 * 1024)
            if body is None:
                return self.send_json({"ok": False, "error": "数据过大"}, 413)
            try:
                req = json.loads(body.decode("utf-8"))
                action = req.get("action")
                name = str(req.get("name") or "").strip()[:40]
            except (ValueError, UnicodeDecodeError):
                return self.send_json({"ok": False, "error": "JSON 无效"}, 400)
            tpls = load_templates()
            if action == "save":
                if not name:
                    return self.send_json({"ok": False, "error": "名称不能为空"}, 400)
                tpls = [t for t in tpls if t.get("name") != name]   # 同名覆盖
                tpls.append({
                    "name": name,
                    "walls": req.get("walls") if isinstance(req.get("walls"), list) else [],
                    "doors": req.get("doors") if isinstance(req.get("doors"), list) else [],
                    "tables": req.get("tables") if isinstance(req.get("tables"), list) else [],
                    "chairs": req.get("chairs") if isinstance(req.get("chairs"), list) else [],
                    "stairs": req.get("stairs") if isinstance(req.get("stairs"), list) else [],
                    "lifts": req.get("lifts") if isinstance(req.get("lifts"), list) else [],
                    "routers": req.get("routers") if isinstance(req.get("routers"), list) else [],
                    "time": time.strftime("%Y-%m-%d %H:%M:%S"),
                })
                tpls = tpls[-50:]                                   # 最多保留 50 个
            elif action == "del":
                tpls = [t for t in tpls if t.get("name") != name]
            else:
                return self.send_json({"ok": False, "error": "action 无效"}, 400)
            tmp = TPL_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(tpls, f, ensure_ascii=False)
            os.replace(tmp, TPL_FILE)
            self.send_json({"ok": True, "count": len(tpls)})
        elif path == "/api/db/bulk":
            self.api_db_bulk()
        elif path == "/api/db/insert":
            self.api_db_insert()
        elif path == "/api/db/update":
            self.api_db_update()
        elif path == "/api/db/delete":
            self.api_db_delete()
        else:
            self.send_json({"ok": False, "error": "未知接口"}, 404)

    def do_GET(self):
        path, _, query = self.path.partition("?")
        qs = parse_qs(query)
        seg = path.split("/")
        if path == "/":
            self.send_file(os.path.join(PUBLIC, "index.html"))
        elif path == "/events":
            self.handle_sse()
        elif path == "/api/status":
            self.api_status()
        elif path == "/api/collect":
            self.api_collect(qs)
        elif path == "/api/clear":
            self.api_clear()
        elif path == "/api/download":
            self.api_download(qs)
        elif path == "/api/db/stats":
            self.api_db_stats()
        elif path == "/api/db/list":
            self.api_db_list(qs)
        elif path == "/api/db/agg":
            self.api_db_agg(qs)
        elif path == "/api/db/export":
            self.api_db_export(qs)
        elif path == "/api/maps":
            self.api_maps_list()
        elif len(seg) == 5 and seg[2] == "maps" and seg[3] and seg[4]:
            mid, res = seg[3], seg[4]
            if res == "data":
                self.api_map_data_get(mid, bump=(qs.get("open") or [""])[0] == "1")
            elif res == "image":
                self.api_map_image_get(mid)
            elif res == "export":
                self.api_map_export(mid)
            else:
                self.send_json({"ok": False, "error": "未知接口"}, 404)
        elif path == "/api/map":
            self.api_map_info()
        elif path == "/api/map/templates":
            self.send_json(load_templates())
        elif path == "/api/map/image":
            self.api_map_image()
        elif path == "/healthz":
            body = json.dumps({
                "latest": latest,
                "counts": counts,
                "rates": rates,
                "last_ts": last_ts,
                "clients": len(clients),
            }, ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            fp = os.path.normpath(os.path.join(PUBLIC, path.lstrip("/")))
            if fp.startswith(PUBLIC) and os.path.isfile(fp):
                self.send_file(fp)
            else:
                self.send_response(404)
                self.end_headers()

    def handle_sse(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        q = queue.Queue(maxsize=2000)
        with clients_lock:
            clients.add(q)
        try:
            snap = {
                "imu": latest["imu"],
                "rssi": latest["rssi"],
                "stats": {
                    "counts": counts, "rates": rates, "last_ts": last_ts,
                    "server_time": time.time(),
                },
            }
            self.wfile.write(("event: snapshot\ndata: %s\n\n"
                              % json.dumps(snap, ensure_ascii=False)).encode())
            self.wfile.flush()
            while True:
                try:
                    msg = q.get(timeout=10)
                    self.wfile.write(msg.encode())
                    self.wfile.flush()
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")   # 保活, 顺带探测断连
                    self.wfile.flush()
        except Exception:
            pass
        finally:
            with clients_lock:
                clients.discard(q)


def rate_counter():
    prev = dict(counts)
    while True:
        time.sleep(2)
        for k in TCP_SOURCES:
            rates[k] = max(0.0, (counts[k] - prev[k]) / 2.0)
            prev[k] = counts[k]


def main():
    ensure_maps_migrated()
    for name, port in TCP_SOURCES.items():
        threading.Thread(target=tcp_source, args=(name, port), daemon=True).start()
    threading.Thread(target=rate_counter, daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", WEB_PORT), Handler)
    server.daemon_threads = True
    log("sensor-view 启动: web=0.0.0.0:%d, tcp=%s" % (WEB_PORT, TCP_SOURCES))
    server.serve_forever()


if __name__ == "__main__":
    main()
