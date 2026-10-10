# -*- coding: utf-8 -*-
"""启动编排: 建目录 → 旧版迁移 → 初始化数据库 → 采集线程 → Web 服务"""
import os
import threading

from . import collector, db
from .config import DATA, TCP_SOURCES, WEB_PORT
from .mapstore import ensure_maps_migrated
from .util import log
from .web import Handler

from http.server import ThreadingHTTPServer


def main():
    os.makedirs(DATA, exist_ok=True)
    ensure_maps_migrated()
    db.init_db()
    for name, port in TCP_SOURCES.items():
        threading.Thread(target=collector.tcp_source, args=(name, port), daemon=True).start()
    threading.Thread(target=collector.rate_counter, daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", WEB_PORT), Handler)
    server.daemon_threads = True
    log("sensor-view 启动: web=0.0.0.0:%d, tcp=%s" % (WEB_PORT, TCP_SOURCES))
    server.serve_forever()
