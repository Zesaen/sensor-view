# -*- coding: utf-8 -*-
"""通用小工具: 日志 / JSON 读写 / 数值转换 / 时间格式化

命名沿用单文件时代的 _num/_int/_fmt_ts 等, 便于与历史代码对照。
"""
import json
import os
import time


def log(msg):
    print(time.strftime("[%H:%M:%S] ") + msg, flush=True)


def now_str():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def read_json(path, default):
    """读 JSON 文件, 任何读/解析失败返回 default"""
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json_atomic(path, obj):
    """原子写 JSON(.tmp + replace), 避免半截文件"""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    os.replace(tmp, path)


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


def _fmt_ts(ts):
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts)) + ".%03d" % int(ts % 1 * 1000)


def _fmt_ms(ts):
    ts = _num(ts, 0.0)
    return _fmt_ts(ts / 1000.0 if ts > 1e11 else ts)


def _cell(v):
    return "" if v is None else str(v)
