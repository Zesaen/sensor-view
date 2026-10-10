# -*- coding: utf-8 -*-
"""全局配置: 路径与常量集中于此, 其余模块一律从这里取"""
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # 项目根(server.py 所在目录)
PUBLIC = os.path.join(ROOT, "public")
DATA = os.path.join(ROOT, "data")
WEB_PORT = 8888
IDLE_TIMEOUT = 300            # 连接静默 5 分钟后断开, 避免死连接占位

# ---- 旧版单地图文件(仅迁移时读) ----
MAP_FILE = os.path.join(DATA, "map.json")            # {points, walls, doors, tables, origin, gridSize}
LEGACY_POINTS_FILE = os.path.join(DATA, "map_points.json")
MAP_IMAGE_BASE = os.path.join(DATA, "map_image")     # 实际文件名带扩展名
TPL_FILE = os.path.join(DATA, "map_templates.json")  # 绘图模板列表

# ---- 多地图存储: data/maps/<mid>/ 每图一目录 ----
#   meta.json  {id,name,created,updated,opened,points,walls,…,image}
#   map.json   地图数据(与旧版 data/map.json 同构)
#   image.<ext> 该地图的底图(可选)
MAPS_DIR = os.path.join(DATA, "maps")
MAP_ID_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z_.-]{2,40}$")

# ---- 采集数据库 (SQLite) ----
# 地图按点采集的 IMU/WiFi 样本持久化; 前端 burst 采满/旧数据迁移时 POST /api/db/bulk 入库
DB_FILE = os.path.join(DATA, "sensors.db")
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

# ---- 采集源 ----
TCP_SOURCES = {
    "imu": 9001,
    "rssi": 9002,
}
HISTORY_CAP = 200000          # 每个数据源后台最多保留条数, 超出自动丢弃最旧

# ---- 请求体上限 ----
MAX_MAP_BODY = 8 * 1024 * 1024                       # 地图数据 JSON 上限
MAX_IMAGE_BODY = 12 * 1024 * 1024                    # 地图图片上限
MAX_IMPORT_BODY = 24 * 1024 * 1024                   # 导入 .svmap.json 上限(含内嵌底图)

IMAGE_MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
              ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp"}

STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    **IMAGE_MIME,
}
