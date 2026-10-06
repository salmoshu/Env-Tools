#!/usr/bin/env python3
"""Codex 速率参考接收端(方法二):OTLP/HTTP + JSON 协议的零依赖接收器。

用途:与看板 TPOT 口径(方法一,rollout 文件推导的 gen_rate)交叉验证。
Codex 原生支持把指标以 OTLP JSON 推到任意 HTTP 端点,在 ~/.codex/config.toml 追加:

    [otel]
    metrics_exporter = { otlp-http = { endpoint = "http://127.0.0.1:4319/v1/metrics", protocol = "json" } }

然后正常运行 codex(新会话),本脚本每 15 秒打印一次各口径的速率估算:

  - codex.api_request.duration_ms            客户端请求墙钟时长 —— 方法一 span 的官方对应物
  - codex.responses_api_inference_time.duration_ms  服务端推理时长(不含网络/排队)
  - codex.responses_api_engine_*_tbt.duration_ms    token 间隔,1000/均值 ≈ 纯解码速率
  - codex.turn.token_usage                   逐轮 token 用量

预期关系(用于核对方法一是否合理):
  纯解码速率(1/TBT) ≥ 服务端速率(output/inference) ≥ 方法一 gen_rate ≈ 客户端速率(output/api_request)
  三者都应远大于"会话寿命吞吐"旧口径(输出/会话首末差)。

用法: python otlp_receiver.py [端口,默认 4319]
注意:修改 config.toml 后需重启 codex 进程才会生效;用完记得删掉 [otel] 段。
"""

import json
import sys
import threading
import time
from collections import defaultdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# 指标名 → (口径说明, 是否是我们关心的)
INTERESTING = {
    "codex.api_request.duration_ms": "客户端请求墙钟(≈方法一 span)",
    "codex.responses_api_inference_time.duration_ms": "服务端推理",
    "codex.responses_api_engine_iapi_tbt.duration_ms": "TBT(引擎 iapi)",
    "codex.responses_api_engine_service_tbt.duration_ms": "TBT(引擎 service)",
    "codex.turn.e2e_duration_ms": "整轮端到端(含工具)",
    "codex.turn.ttft.duration_ms": "整轮 TTFT",
}

# name → {"count": n, "sum": x}   histogram/gauge 通用累积
stats = defaultdict(lambda: {"count": 0, "sum": 0.0, "attrs": {}})
# token_usage 的属性快照(属性里带 output/input token 细分)
token_attrs = {}
lock = threading.Lock()


def absorb(payload: dict) -> None:
    for rm in payload.get("resourceMetrics", []):
        for sm in rm.get("scopeMetrics", []):
            for m in sm.get("metrics", []):
                name = m.get("name", "")
                for kind in ("histogram", "gauge", "sum"):
                    if kind not in m:
                        continue
                    points = m[kind].get("dataPoints", [])
                    with lock:
                        if kind == "histogram":
                            for dp in points:
                                st = stats[name]
                                st["count"] += int(dp.get("count", 0) or 0)
                                st["sum"] += float(dp.get("sum", 0) or 0)
                                if dp.get("attributes"):
                                    st["attrs"].update(
                                        {a["key"]: a.get("value", {}).get("stringValue", "")
                                         for a in dp["attributes"]}
                                    )
                        elif kind == "gauge" or kind == "sum":
                            for dp in points:
                                val = dp.get("value", {})
                                v = val.get("asDouble", val.get("asInt", 0))
                                st = stats[name]
                                st["count"] += 1
                                st["sum"] += float(v or 0)
                                if dp.get("attributes"):
                                    token_attrs[name] = {
                                        a["key"]: a.get("value", {}).get("stringValue",
                                         a.get("value", {}).get("intValue", ""))
                                        for a in dp["attributes"]
                                    }


def report() -> None:
    with lock:
        snapshot = {k: dict(v) for k, v in stats.items()}
    if not snapshot:
        return
    print("\n" + "=" * 78)
    for name, label in INTERESTING.items():
        st = snapshot.get(name)
        if st and st["count"]:
            mean = st["sum"] / st["count"]
            extra = ""
            if "_tbt" in name and mean > 0:
                extra = f"  → 纯解码 ≈ {1000.0 / mean:6.1f} tok/s"
            print(f"{label:<28} {name}")
            print(f"{'':28} n={st['count']:5d}  mean={mean:9.1f} ms{extra}")
    ta = token_attrs.get("codex.turn.token_usage") or {}
    if ta:
        print(f"{'token_usage 最近属性':<28} {json.dumps(ta, ensure_ascii=False)}")
    # 方法一 vs 方法二 对照
    api = snapshot.get("codex.api_request.duration_ms")
    inf = snapshot.get("codex.responses_api_inference_time.duration_ms")
    if api and inf and api["count"] and inf["count"]:
        print(f"\n客户端/服务端时长比 = {(api['sum'] / api['count']) / (inf['sum'] / inf['count']):.2f}"
              f"(方法一 gen_rate 应介于两者推出的速率之间)")
    sys.stdout.flush()


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):  # /v1/metrics 与 /metrics 都收
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length)
        try:
            absorb(json.loads(body))
            self.send_response(200)
        except Exception as exc:  # 解析失败也回 200,避免 codex 侧重试风暴
            print(f"[warn] decode failed: {exc}", file=sys.stderr)
            self.send_response(200)
        self.end_headers()

    def do_GET(self):  # 健康检查
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *_):
        pass


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4319
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f"OTLP/JSON 参考接收端已启动: http://127.0.0.1:{port}/v1/metrics")
    print("等待 codex 指标推送(记得在 ~/.codex/config.toml 配置 [otel] 并重启 codex)…")
    try:
        while True:
            time.sleep(15)
            report()
    except KeyboardInterrupt:
        report()
        server.shutdown()


if __name__ == "__main__":
    main()
