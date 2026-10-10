# -*- coding: utf-8 -*-
"""sensor-view 后端包

模块划分:
  config     常量与路径
  util       日志 / JSON 读写 / 数值与时间格式化
  schema     地图数据默认值/白名单/校验(唯一权威)
  mapstore   多地图文件 IO 与地图生命周期
  templates  绘图模板读写
  db         SQLite 采集样本库
  collector  TCP 采集 + 后台缓冲 + SSE 广播
  web        HTTP 路由与处理
  main       启动编排
"""
