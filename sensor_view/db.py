# -*- coding: utf-8 -*-
"""采集数据库(SQLite): 地图按点采集的 IMU/WiFi 样本

连接在建在 init_db()(main 显式调用), 模块导入不再有建库副作用。
"""
import sqlite3
import threading
import time

from .config import DB_COLS, DB_FILE, DB_TYPES
from .util import _int, _num

db = None                       # sqlite3 连接, init_db() 后可用
db_lock = threading.Lock()

_SCHEMA = """
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
"""


def init_db():
    global db
    db = sqlite3.connect(DB_FILE, check_same_thread=False)
    db.executescript(_SCHEMA)
    db.commit()


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


def db_delete_points(point_ids):
    """删除一批测点的全部采样(分 500/批, 删地图时连带清理用)"""
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
