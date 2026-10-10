#!/bin/bash
# 采集 GET 接口金样: tests/capture_golden.sh <输出目录>
# 用法: 重构前 capture_golden.sh tests/golden ; 重构后 capture_golden.sh /tmp/golden2 再 diff -r
# 注意: CDP 测试会真实打开/保存地图 → maps.json 的 updated/opened 时间戳随之变化。
# 金样对比应在跑 CDP 之前进行, 或忽略这两字段; 图形/测点数量等实质内容不应有差异。
set -e
BASE=http://127.0.0.1:8888
OUT="${1:-tests/golden}"
mkdir -p "$OUT"

fetch() { # fetch <name> <path>
  curl -sf "$BASE$2" -o "$OUT/$1" || echo "FAIL $1 ($2)" >&2
}

fetch maps.json /api/maps
fetch legacy_map.json /api/map
fetch templates.json /api/map/templates
fetch db_stats.json /api/db/stats
fetch db_list_imu.json "/api/db/list?kind=imu&page=1&size=50"
fetch db_list_wifi.json "/api/db/list?kind=wifi&page=1&size=50"
fetch db_export_imu_csv.csv "/api/db/export?kind=imu&fmt=csv"
fetch db_export_wifi_csv.csv "/api/db/export?kind=wifi&fmt=csv"
fetch db_export_imu_json.json "/api/db/export?kind=imu&fmt=json"

# 每张地图的数据与导出(导出的 exported 时间戳做归一化, 其余逐字节比)
for mid in $(python3 -c "import json;print(' '.join(m['id'] for m in json.load(open('$OUT/maps.json'))['maps']))"); do
  fetch "map_${mid}_data.json" "/api/maps/$mid/data"
  curl -sf "$BASE/api/maps/$mid/export" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); d['exported']='<TS>'; json.dump(d,sys.stdout,ensure_ascii=False,indent=1)" \
    > "$OUT/map_${mid}_export.json" || echo "FAIL map_$mid export" >&2
done

echo "金样已写入 $OUT ($(ls "$OUT" | wc -l) 个文件)"
