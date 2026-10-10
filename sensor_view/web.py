# -*- coding: utf-8 -*-
"""Web 层: HTTP Handler + 路由表 + 静态文件 + SSE

路由分三层: 精确路径表(GET_ROUTES/POST_ROUTES) → /api/maps/<id>/<res>
子资源正则 → 回退(静态文件 / 404), 与原 if/elif 链行为一致。
"""
import base64
import glob
import json
import math
import os
import queue
import re
import sqlite3
import time
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, quote

from . import collector, db, mapstore
from .config import (DB_COLS, DB_FILE, IMAGE_MIME, MAX_DB_BODY, MAX_IMAGE_BODY,
                     MAX_IMPORT_BODY, MAX_MAP_BODY, PUBLIC, STATIC_TYPES)
from .schema import clean_map_payload
from .templates import load_templates, save_templates, tpl_from_payload
from .util import _cell, _fmt_ms, _int, log, now_str

RE_MAPS_SUB = re.compile(r"^/api/maps/([^/]+)/([^/]+)$")

# 精确路由: 路径 → Handler 方法名(方法统一收 qs 参数)
GET_ROUTES = {
    "/api/status": "api_status",
    "/api/collect": "api_collect",
    "/api/clear": "api_clear",
    "/api/download": "api_download",
    "/api/db/stats": "api_db_stats",
    "/api/db/list": "api_db_list",
    "/api/db/agg": "api_db_agg",
    "/api/db/export": "api_db_export",
    "/api/maps": "api_maps_list",
    "/api/map": "api_map_info",
    "/api/map/templates": "api_templates_list",
    "/api/map/image": "api_map_image",
    "/healthz": "api_healthz",
}

POST_ROUTES = {
    "/api/maps/import": "api_maps_import",
    "/api/map/data": "api_map_data_legacy",      # 旧版兼容: 保存到最近打开的地图
    "/api/map/image": "api_map_image_legacy",
    "/api/map/templates": "api_templates_post",
    "/api/db/bulk": "api_db_bulk",
    "/api/db/insert": "api_db_insert",
    "/api/db/update": "api_db_update",
    "/api/db/delete": "api_db_delete",
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):        # 静默默认访问日志
        pass

    # ---- 基础响应 ----

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

    def read_body(self, limit):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n > limit:
            return None
        return self.rfile.read(n) if n > 0 else b""

    # ---- 路由分发 ----

    def do_GET(self):
        path, _, query = self.path.partition("?")
        qs = parse_qs(query)
        if path == "/":
            return self.send_file(os.path.join(PUBLIC, "index.html"))
        if path == "/events":
            return self.handle_sse()
        name = GET_ROUTES.get(path)
        if name:
            return getattr(self, name)(qs)
        m = RE_MAPS_SUB.match(path)
        if m:
            mid, res = m.group(1), m.group(2)
            if res == "data":
                return self.api_map_data_get(mid, bump=(qs.get("open") or [""])[0] == "1")
            if res == "image":
                return self.api_map_image_get(mid)
            if res == "export":
                return self.api_map_export(mid)
            return self.send_json({"ok": False, "error": "未知接口"}, 404)
        fp = os.path.normpath(os.path.join(PUBLIC, path.lstrip("/")))
        if fp.startswith(PUBLIC) and os.path.isfile(fp):
            return self.send_file(fp)
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        path, _, query = self.path.partition("?")
        qs = parse_qs(query)
        if path == "/api/maps":
            return self.api_maps_create(qs)
        m = RE_MAPS_SUB.match(path)
        if m:
            mid, res = m.group(1), m.group(2)
            if res == "data":
                return self.api_map_data_post(mid)
            if res == "image":
                return self.api_map_image_post(mid, qs)
            if res == "meta":
                return self.api_map_meta_post(mid, qs)
            return self.send_json({"ok": False, "error": "未知接口"}, 404)
        name = POST_ROUTES.get(path)
        if name:
            return getattr(self, name)(qs)
        self.send_json({"ok": False, "error": "未知接口"}, 404)

    # ---- 采集(后台缓冲) API ----

    def api_status(self, qs):
        with collector.hist_lock:
            body = {
                "recording": {k: dict(v) for k, v in collector.record.items()},
                "history": {k: len(v) for k, v in collector.history.items()},
                "counts": dict(collector.counts),
                "rates": dict(collector.rates),
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
        with collector.hist_lock:
            for n in names:
                r = collector.record[n]
                if action == "start":
                    r["active"] = True
                    r["limit"] = limit
                    r["taken"] = 0
                else:
                    r["active"] = False
        log("采集%s: src=%s limit=%d" % ("开始" if action == "start" else "停止", src, limit))
        self.api_status(qs)

    def api_clear(self, qs):
        with collector.hist_lock:
            for n in collector.history:
                collector.history[n].clear()
                collector.record[n]["active"] = False
                collector.record[n]["taken"] = 0
            for n in collector.counts:
                collector.counts[n] = 0
                collector.rates[n] = 0.0
                collector.last_ts[n] = 0.0
                collector.latest[n] = None
        log("后台数据已清空")
        self.api_status(qs)

    def api_download(self, qs):
        src = (qs.get("src") or ["imu"])[0]
        fmt = (qs.get("fmt") or ["csv"])[0]
        key = {"imu": "imu", "wifi": "rssi"}.get(src)
        if not key:
            self.send_json({"ok": False, "error": "src 参数无效"}, 400)
            return
        with collector.hist_lock:
            rows = list(collector.history[key])
        stamp = time.strftime("%Y%m%d_%H%M%S")
        if fmt == "json":
            body = collector.rows_json(rows).encode("utf-8")
            ctype = "application/json; charset=utf-8"
            fname = "%s_%s.json" % (src, stamp)
        else:
            text = collector.imu_csv(rows) if key == "imu" else collector.rssi_csv(rows)
            body = b"\xef\xbb\xbf" + text.encode("utf-8")   # 带 BOM, Excel 直接打开不乱码
            ctype = "text/csv; charset=utf-8"
            fname = "%s_%s.csv" % (src, stamp)
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Disposition", 'attachment; filename="%s"' % fname)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ---- 采集数据库 API ----

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

    def api_db_stats(self, qs):
        with db.db_lock:
            n_imu = db.db.execute("SELECT COUNT(*) FROM imu").fetchone()[0]
            n_wifi = db.db.execute("SELECT COUNT(*) FROM wifi").fetchone()[0]
            pts = {}
            for pid, n in db.db.execute("SELECT point_id, COUNT(*) FROM imu GROUP BY point_id"):
                pts.setdefault(pid, {"point_id": pid, "imu": 0, "wifi": 0})["imu"] = n
            for pid, n in db.db.execute("SELECT point_id, COUNT(*) FROM wifi GROUP BY point_id"):
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
        with db.db_lock:
            total = db.db.execute("SELECT COUNT(*) FROM %s%s" % (kind, where), args).fetchone()[0]
            rows = db.db.execute("SELECT %s FROM %s%s ORDER BY id DESC LIMIT ? OFFSET ?"
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
            with db.db_lock:
                return [dict(zip(cols, r)) for r in db.db.execute(
                    "SELECT %s FROM %s%s ORDER BY point_id, id"
                    % (",".join(cols), k, where), args)]

        names, order = mapstore.point_name_map()    # 测点名遍历多地图, 不再用旧版冻结文件

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
        names = mapstore.point_name_map()[0]
        with db.db_lock:
            pts = set(r[0] for r in db.db.execute("SELECT DISTINCT point_id FROM imu"))
            pts |= set(r[0] for r in db.db.execute("SELECT DISTINCT point_id FROM wifi"))
            if point_id:
                pts &= {point_id}
            out = []
            for pid in sorted(pts):
                n_imu, ptch, rl_, mx, my, mz = db.db.execute(
                    "SELECT COUNT(*), AVG(pitch), AVG(roll), AVG(mag_x), AVG(mag_y), AVG(mag_z)"
                    " FROM imu WHERE point_id=?", (pid,)).fetchone()
                yaw = None
                if n_imu:                       # yaw 走圆周均值, 不能直接 AVG
                    sx = sy = 0.0
                    for (y,) in db.db.execute(
                            "SELECT yaw FROM imu WHERE point_id=? AND yaw IS NOT NULL", (pid,)):
                        sx += math.sin(math.radians(y))
                        sy += math.cos(math.radians(y))
                    yaw = (math.degrees(math.atan2(sx, sy)) + 360) % 360
                n_scans = db.db.execute(
                    "SELECT COUNT(DISTINCT ts) FROM wifi WHERE point_id=?", (pid,)).fetchone()[0]
                aps = [{"name": nm, "n": c, "rssi": round(a)}
                       for nm, c, a in db.db.execute(
                           "SELECT ap_name, COUNT(*), AVG(rssi) FROM wifi"
                           " WHERE point_id=? GROUP BY ap_name"
                           " ORDER BY COUNT(*) DESC, ap_name", (pid,))]
                out.append({"point_id": pid, "name": names.get(pid, pid),
                            "n_imu": n_imu, "n_scans": n_scans,
                            "yaw": round(yaw, 2) if yaw is not None else None,
                            "pitch": ptch, "roll": rl_,
                            "mx": mx, "my": mz, "mz": mz, "aps": aps})
        self.send_json({"ok": True, "points": out})

    def api_db_bulk(self, qs):
        req = self.db_json_body()
        if req is None:
            return
        point_id = str(req.get("point_id") or "").strip()
        if not point_id:
            return self.send_json({"ok": False, "error": "point_id 不能为空"}, 400)
        try:
            n_imu, n_wifi = db.db_bulk_insert(point_id, req.get("imu"), req.get("wifi"),
                                              bool(req.get("replace")))
        except Exception as e:
            return self.send_json({"ok": False, "error": "写入失败: %s" % e}, 500)
        log("[db] %s 写入 imu=%d wifi=%d%s"
            % (point_id, n_imu, n_wifi, " (替换)" if req.get("replace") else ""))
        self.send_json({"ok": True, "imu": n_imu, "wifi": n_wifi})

    def api_db_insert(self, qs):
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
                    vals[col] = db._coerce(col, fields[col])
                except ValueError as e:
                    return self.send_json({"ok": False, "error": str(e)}, 400)
        if not vals.get("ts"):
            vals["ts"] = round(time.time() * 1000)
        if kind == "wifi" and not (vals.get("ap_name") or ""):
            return self.send_json({"ok": False, "error": "ap_name 不能为空"}, 400)
        cols = ["point_id"] + list(vals)
        with db.db_lock:
            try:
                cur = db.db.execute("INSERT INTO %s(%s) VALUES(%s)"
                                    % (kind, ",".join(cols), ",".join("?" * len(cols))),
                                    [point_id] + list(vals.values()))
                db.db.commit()
            except sqlite3.Error as e:
                db.db.rollback()
                return self.send_json({"ok": False, "error": "写入失败: %s" % e}, 500)
        self.send_json({"ok": True, "id": cur.lastrowid})

    def api_db_update(self, qs):
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
                    args.append(db._coerce(col, fields[col]))
                except ValueError as e:
                    return self.send_json({"ok": False, "error": str(e)}, 400)
        if not sets:
            return self.send_json({"ok": False, "error": "无可更新字段"}, 400)
        args.append(rid)
        with db.db_lock:
            cur = db.db.execute("UPDATE %s SET %s WHERE id=?" % (kind, ",".join(sets)), args)
            db.db.commit()
            n = cur.rowcount
        if not n:
            return self.send_json({"ok": False, "error": "记录不存在"}, 404)
        self.send_json({"ok": True, "updated": n})

    def api_db_delete(self, qs):
        req = self.db_json_body()
        if req is None:
            return
        with db.db_lock:
            cur = db.db.cursor()
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
                db.db.commit()
            except Exception:
                db.db.rollback()
                raise
        log("[db] 删除 %d 条" % n)
        self.send_json({"ok": True, "deleted": n})

    # ---- 多地图 API ----

    def api_maps_list(self, qs):
        self.send_json({"ok": True, "maps": mapstore.list_maps()})

    def api_maps_create(self, qs):
        body = self.read_body(64 * 1024)
        if body is None:
            return self.send_json({"ok": False, "error": "数据过大"}, 413)
        try:
            req = json.loads(body.decode("utf-8") or "{}")
        except (ValueError, UnicodeDecodeError):
            req = {}
        name = str((req or {}).get("name") or "未命名地图").strip()[:40] or "未命名地图"
        mid = mapstore.create_map(name)
        log("[maps] 新建地图 %s「%s」" % (mid, name))
        self.send_json({"ok": True, "id": mid, "name": name})

    def api_map_data_get(self, mid, bump=False):
        if not mapstore.valid_map_id(mid):
            return self.send_json({"ok": False, "error": "地图不存在"}, 404)
        self.send_json(mapstore.map_data_response(mid, bump_opened=bump))

    def api_map_data_post(self, mid):
        if not mapstore.valid_map_id(mid):
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
        mapstore.save_map_data_file(mid, clean)
        cnts = mapstore.meta_counts(mid, clean)
        with mapstore.meta_lock:
            meta = mapstore.load_map_meta(mid) or {"id": mid}
            meta.update(cnts)
            meta["updated"] = now_str()
            mapstore.save_map_meta(mid, meta)
        self.send_json({"ok": True, "points": cnts["points"], "walls": cnts["walls"]})

    def api_map_image_get(self, mid):
        if not mapstore.valid_map_id(mid):
            return self.send_json({"ok": False, "error": "地图不存在"}, 404)
        fp = mapstore.map_image_file(mid)
        if fp:
            return self.send_file(fp)
        self.send_response(404)
        self.end_headers()

    def api_map_image_post(self, mid, qs):
        if not mapstore.valid_map_id(mid):
            return self.send_json({"ok": False, "error": "地图不存在"}, 404)
        body = self.read_body(MAX_IMAGE_BODY)
        if body is None:
            return self.send_json({"ok": False, "error": "图片超过 10MB"}, 413)
        _, _, _, ibase = mapstore.map_paths(mid)
        for old in glob.glob(ibase + ".*"):      # 扩展名可能变化, 清掉旧图
            try:
                os.remove(old)
            except OSError:
                pass
        if not body:                              # 空请求体 = 删除底图
            mapstore.touch_map_meta(mid, image=False, updated=now_str())
            return self.send_json({"ok": True, "image": False})
        name = (qs.get("name") or ["map.png"])[0]
        ext = os.path.splitext(name)[1].lower()
        if ext not in IMAGE_MIME:
            ext = ".png"
        with open(ibase + ext, "wb") as f:
            f.write(body)
        mapstore.touch_map_meta(mid, image=True, updated=now_str())
        log("[maps] %s 底图已更新 (%d bytes)" % (mid, len(body)))
        self.send_json({"ok": True, "image": True})

    def api_map_meta_post(self, mid, qs):
        if not mapstore.valid_map_id(mid):
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
            mapstore.touch_map_meta(mid, name=name, updated=now_str())
            self.send_json({"ok": True, "name": name})
        elif action == "duplicate":
            new_id = mapstore.duplicate_map(mid, name or None)
            log("[maps] 复制 %s → %s" % (mid, new_id))
            self.send_json({"ok": True, "id": new_id})
        elif action == "delete":
            mapstore.delete_map(mid)
            self.send_json({"ok": True})
        else:
            self.send_json({"ok": False, "error": "action 无效"}, 400)

    def api_map_export(self, mid):
        if not mapstore.valid_map_id(mid):
            return self.send_json({"ok": False, "error": "地图不存在"}, 404)
        meta = mapstore.load_map_meta(mid) or {}
        data = mapstore.read_map_data(mid)
        image_url = None
        fp = mapstore.map_image_file(mid)
        if fp:
            with open(fp, "rb") as f:
                b = f.read()
            ext = os.path.splitext(fp)[1].lower()
            image_url = "data:%s;base64,%s" % (IMAGE_MIME.get(ext, "application/octet-stream"),
                                               base64.b64encode(b).decode())
        payload = {"app": "sensor-view", "type": "map", "version": 1,
                   "name": meta.get("name") or "未命名地图", "exported": now_str(),
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
        mapstore.regen_point_ids(data)
        mid = mapstore.create_map(name, data)
        if isinstance(img, str) and img.startswith("data:"):
            try:
                head, b64 = img.split(",", 1)
                ext = ".png"
                for e, mime in IMAGE_MIME.items():
                    if mime in head:
                        ext = e
                        break
                _, _, _, ibase = mapstore.map_paths(mid)
                with open(ibase + ext, "wb") as f:
                    f.write(base64.b64decode(b64))
                mapstore.touch_map_meta(mid, image=True)
            except (ValueError, OSError):
                log("[maps] 导入地图 %s 的底图解码失败, 忽略底图" % mid)
        log("[maps] 导入地图 %s「%s」" % (mid, name))
        self.send_json({"ok": True, "id": mid, "name": name})

    # ---- 旧版单地图接口 → 作用于最近打开的地图 ----

    def api_map_info(self, qs):
        mid = mapstore.newest_map_id()
        if not mid:
            return self.send_json({"ok": False, "error": "没有地图"}, 404)
        self.send_json(mapstore.map_data_response(mid)["data"])

    def api_map_image(self, qs):
        mid = mapstore.newest_map_id()
        if not mid:
            self.send_response(404)
            return self.end_headers()
        fp = mapstore.map_image_file(mid)
        if fp:
            return self.send_file(fp)
        self.send_response(404)
        self.end_headers()

    def api_map_data_legacy(self, qs):
        mid = mapstore.newest_map_id()
        if not mid:
            return self.send_json({"ok": False, "error": "没有地图"}, 404)
        self.api_map_data_post(mid)

    def api_map_image_legacy(self, qs):
        mid = mapstore.newest_map_id()
        if not mid:
            return self.send_json({"ok": False, "error": "没有地图"}, 404)
        self.api_map_image_post(mid, qs)

    # ---- 绘图模板 ----

    def api_templates_list(self, qs):
        self.send_json(load_templates())

    def api_templates_post(self, qs):
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
            tpls.append(tpl_from_payload(name, req))
            tpls = tpls[-50:]                                   # 最多保留 50 个
        elif action == "del":
            tpls = [t for t in tpls if t.get("name") != name]
        else:
            return self.send_json({"ok": False, "error": "action 无效"}, 400)
        save_templates(tpls)
        self.send_json({"ok": True, "count": len(tpls)})

    # ---- 状态 / SSE ----

    def api_healthz(self, qs):
        with collector.hist_lock:
            body = json.dumps({
                "latest": dict(collector.latest),
                "counts": dict(collector.counts),
                "rates": dict(collector.rates),
                "last_ts": dict(collector.last_ts),
                "clients": len(collector.clients),
            }, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_sse(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        q = queue.Queue(maxsize=2000)
        with collector.clients_lock:
            collector.clients.add(q)
        try:
            with collector.hist_lock:
                snap = {
                    "imu": collector.latest["imu"],
                    "rssi": collector.latest["rssi"],
                    "stats": {
                        "counts": dict(collector.counts), "rates": dict(collector.rates),
                        "last_ts": dict(collector.last_ts),
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
            with collector.clients_lock:
                collector.clients.discard(q)
