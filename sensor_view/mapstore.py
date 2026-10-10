# -*- coding: utf-8 -*-
"""多地图存储: data/maps/<mid>/ 的全部文件 IO 与地图生命周期操作"""
import os
import shutil
import threading
import time

from . import db
from .config import (IMAGE_MIME, MAP_FILE, MAP_IMAGE_BASE, MAPS_DIR,
                     LEGACY_POINTS_FILE, MAP_ID_RE)
from .schema import empty_map_data, merge_map_saved
from .util import log, now_str, read_json, write_json_atomic

meta_lock = threading.Lock()


def new_map_id():
    return time.strftime("%Y%m%d-%H%M%S-") + os.urandom(3).hex()


def map_paths(mid):
    d = os.path.join(MAPS_DIR, mid)
    return d, os.path.join(d, "meta.json"), os.path.join(d, "map.json"), os.path.join(d, "image")


def valid_map_id(mid):
    return bool(mid) and bool(MAP_ID_RE.match(mid)) and os.path.isdir(os.path.join(MAPS_DIR, mid))


def load_map_meta(mid):
    _, mfp, _, _ = map_paths(mid)
    meta = read_json(mfp, None)
    if isinstance(meta, dict):
        meta["id"] = mid
        return meta
    return None


def save_map_meta(mid, meta):
    _, mfp, _, _ = map_paths(mid)
    write_json_atomic(mfp, meta)


def touch_map_meta(mid, **fields):
    with meta_lock:
        meta = load_map_meta(mid)
        if meta is None:
            return None
        meta.update(fields)
        save_map_meta(mid, meta)
        return meta


def read_map_data(mid):
    """读 maps/<mid>/map.json, 按 schema 补默认值"""
    _, _, jfp, _ = map_paths(mid)
    return merge_map_saved(read_json(jfp, None))


def load_map_data():
    """旧版单地图 data/map.json(仅迁移与兜底读取用)"""
    saved = read_json(MAP_FILE, None)
    data = merge_map_saved(saved)
    if saved is None:                               # 兼容旧版仅存坐标点的文件
        points = read_json(LEGACY_POINTS_FILE, None)
        if isinstance(points, list):
            data["points"] = points
    return data


def map_image_file(mid):
    _, _, _, ibase = map_paths(mid)
    for ext in IMAGE_MIME:
        fp = ibase + ext
        if os.path.isfile(fp):
            return fp
    return None


def meta_counts(mid, data):
    return {"points": len(data.get("points") or []),
            "walls": len(data.get("walls") or []),
            "doors": len(data.get("doors") or []),
            "tables": len(data.get("tables") or []),
            "routers": len(data.get("routers") or []),
            "image": bool(map_image_file(mid))}


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


def save_map_data_file(mid, data):
    _, _, jfp, _ = map_paths(mid)
    write_json_atomic(jfp, data)


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


def create_map(name, data=None):
    mid = new_map_id()
    d, _, _, _ = map_paths(mid)
    os.makedirs(d, exist_ok=True)
    data = empty_map_data() if data is None else data   # 新建 = 空白地图
    save_map_data_file(mid, data)
    meta = {"id": mid, "name": name, "created": now_str(), "updated": now_str(),
            "opened": now_str()}
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
    _, _, jfp, _ = map_paths(mid)
    ids = []
    d = read_json(jfp, None)
    if isinstance(d, dict):
        for p in (d.get("points") or []):
            if isinstance(p, dict) and p.get("id"):
                ids.append(str(p["id"]))
        for fl in (d.get("floors") or []):        # 多楼层: 各层测点采样一并清理
            if isinstance(fl, dict):
                for p in (fl.get("points") or []):
                    if isinstance(p, dict) and p.get("id"):
                        ids.append(str(p["id"]))
    shutil.rmtree(os.path.join(MAPS_DIR, mid), ignore_errors=True)
    n = db.db_delete_points(ids)
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
        touch_map_meta(mid, opened=now_str())
    return {"ok": True, "id": mid, "name": meta.get("name") or "未命名地图", "data": data}


def point_name_map():
    """point_id → 测点名 与测点顺序, 遍历全部地图(含各楼层)。

    多地图架构后测点分属各图, 不再从旧版冻结的 data/map.json 取名。
    order 按地图最近打开顺序→图中顺序排, 供导出编号。
    """
    names, order = {}, []
    for meta in list_maps():
        d = read_map_data(meta["id"])
        pts = list(d.get("points") or [])
        for f in d.get("floors") or []:
            if isinstance(f, dict):
                pts.extend(f.get("points") or [])   # 顶层是当前层镜像, 按 id 去重
        for p in pts:
            if isinstance(p, dict) and p.get("id") is not None:
                pid = str(p.get("id"))
                if pid not in names:
                    names[pid] = str(p.get("name") or pid)
                    order.append(pid)
    return names, order
