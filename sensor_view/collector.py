# -*- coding: utf-8 -*-
"""数据采集: TCP 接收(9001 IMU / 9002 RSSI) + 后台缓冲 + SSE 广播 + 速率统计"""
import json
import socket
import threading
import time
from collections import deque

from .config import HISTORY_CAP, IDLE_TIMEOUT, TCP_SOURCES
from .util import _cell, _fmt_ts, log

# 实时状态: latest 最新一帧 / last_ts 最近时刻 / counts 累计 / rates 速率(条/秒)
# 读写一律持 hist_lock(与 history 缓冲共用一把锁)
latest = {"imu": None, "rssi": None}
last_ts = {"imu": 0.0, "rssi": 0.0}
counts = {"imu": 0, "rssi": 0}
rates = {"imu": 0.0, "rssi": 0.0}

history = {"imu": deque(maxlen=HISTORY_CAP), "rssi": deque(maxlen=HISTORY_CAP)}
hist_lock = threading.Lock()
# 采集会话: active=记录中, limit=目标条数(0=不限量, 手动停), taken=本会话已记录条数
record = {
    "imu":  {"active": False, "limit": 0, "taken": 0},
    "rssi": {"active": False, "limit": 0, "taken": 0},
}

clients = set()               # 每个 SSE 客户端一个队列
clients_lock = threading.Lock()


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
                with hist_lock:
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


def rate_counter():
    with hist_lock:
        prev = dict(counts)
    while True:
        time.sleep(2)
        with hist_lock:
            for k in TCP_SOURCES:
                rates[k] = max(0.0, (counts[k] - prev[k]) / 2.0)
                prev[k] = counts[k]


# ---- 后台缓冲 → 下载文件格式 ----

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
