#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
传感器实时展示服务 (入口; 实现在 sensor_view/ 包)
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
from sensor_view.main import main

if __name__ == "__main__":
    main()
