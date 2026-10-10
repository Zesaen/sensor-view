# -*- coding: utf-8 -*-
"""地图数据 schema: 默认值 / 白名单 / 校验的唯一权威定义

此前同一份"17 键默认 dict"在 server.py 里重复了 5 处(load_map_data /
read_map_data / clean_map_payload / empty_map_data / 模板白名单), 且
empty_map_data 缺 floors/curFloor 两键——全部收敛到这里。
"""
# 8 个图形列表键: 读取默认值、提交白名单、模板白名单共用同一顺序
# (顺序即 JSON 落盘/响应的键序, 勿改)
LIST_KEYS = ("points", "walls", "doors", "tables", "chairs", "stairs", "lifts", "routers")

# 模板允许携带的图形键(save 白名单, 顺序同上)
TPL_KEYS = LIST_KEYS[1:]


def empty_map_data():
    """空白地图数据(含多楼层键)"""
    data = {k: [] for k in LIST_KEYS}
    data.update({
        "floors": [], "curFloor": "",
        "origin": {"x": 0, "y": 0}, "gridSize": 50,
        "wallThick": 10, "thickUnit": "m", "pxPerM": 50, "gridOn": True,
        "gridMinorOn": True})
    return data


def merge_map_saved(saved):
    """读取侧合并: 已存 dict 中存在的键覆盖默认值, 不存在的补默认(不校验类型)"""
    data = empty_map_data()
    if isinstance(saved, dict):
        for k in data:
            if k in saved:
                data[k] = saved[k]
    return data


def clean_map_payload(saved):
    """提交侧清洗: 白名单 + 类型校验 + 钳制(旧 /api/map/data 同款逻辑)"""
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
    data = {k: saved.get(k) if isinstance(saved.get(k), list) else [] for k in LIST_KEYS}
    data.update({
        "floors": floors,
        "curFloor": saved.get("curFloor") if isinstance(saved.get("curFloor"), str) else "",
        "origin": saved.get("origin") if isinstance(saved.get("origin"), dict) else {"x": 0, "y": 0},
        "gridSize": saved.get("gridSize") if isinstance(saved.get("gridSize"), (int, float)) else 50,
        "wallThick": max(1.0, wall_thick),
        "thickUnit": saved.get("thickUnit") if saved.get("thickUnit") in ("px", "m") else "m",
        "pxPerM": max(1.0, px_per_m),
        "gridOn": bool(saved.get("gridOn", True)),
        "gridMinorOn": bool(saved.get("gridMinorOn", True)),
    })
    return data
