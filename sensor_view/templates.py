# -*- coding: utf-8 -*-
"""绘图模板的读写(data/map_templates.json, 最多保留 50 个)"""
import time

from .config import TPL_FILE
from .schema import TPL_KEYS
from .util import read_json, write_json_atomic


def load_templates():
    tpls = read_json(TPL_FILE, [])
    return tpls if isinstance(tpls, list) else []


def save_templates(tpls):
    write_json_atomic(TPL_FILE, tpls)


def tpl_from_payload(name, req):
    """由前端提交构造模板条目(图形键走 TPL_KEYS 白名单)"""
    tpl = {"name": name}
    for k in TPL_KEYS:
        tpl[k] = req.get(k) if isinstance(req.get(k), list) else []
    tpl["time"] = time.strftime("%Y-%m-%d %H:%M:%S")
    return tpl
