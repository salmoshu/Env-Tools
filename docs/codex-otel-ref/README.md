# Codex 速率参考实现(方法二:OTEL 遥测)

看板对 Codex 会话的速率展示采用 **方法一**:解析 rollout 文件里
`token_usage_record` 与边界事件(工具产出/用户消息/上一响应完成)的时间差,
累计 `gen_seconds` 得到 TPOT 口径 `gen_rate`(纯生成速率,实现见
`app/backend-rs/src/analytics.rs` 的 `parse_codex_usage_record`)。

本目录是 **方法二**:利用 Codex 内置 OpenTelemetry 导出做交叉验证的参考工具。
它不参与看板数据链路,只用于核对方法一的数值是否合理。

## 启用步骤

1. 启动参考接收端(零依赖,仅标准库):

   ```
   python docs/codex-otel-ref/otlp_receiver.py [端口,默认 4319]
   ```

2. 在 `~/.codex/config.toml` 追加(语法来自 codex 官方集成测试):

   ```toml
   [otel]
   metrics_exporter = { otlp-http = { endpoint = "http://127.0.0.1:4319/v1/metrics", protocol = "json" } }
   ```

3. 重启 codex(配置只在新进程生效),正常干活即可;接收端每 15 秒打印一次汇总。

4. 验证完**删掉 `[otel]` 段**再重启 codex,避免无谓的本地推送。

## 关键指标(源码 codex-rs/otel/src/metrics/names.rs)

| 指标 | 语义 | 与方法一的关系 |
|---|---|---|
| `codex.api_request.duration_ms` | 客户端请求墙钟时长 | 方法一 span 的官方对应物(方法一 ≈ 该值减请求准备耗时) |
| `codex.responses_api_inference_time.duration_ms` | 服务端推理时长 | 不含网络与排队,推出的是服务端速率 |
| `codex.responses_api_engine_*_tbt.duration_ms` | token 间隔 | `1000/均值` ≈ 纯解码速率(理论上限) |
| `codex.turn.e2e_duration_ms` | 整轮端到端(含工具执行) | 旧"寿命口径"的近亲,仅作对照 |
| `codex.turn.token_usage` | 逐轮 token 用量 | 分子来源 |

## 数值关系预期(核对方法一)

```
纯解码速率(1/TBT) ≥ 服务端速率(output/inference) ≥ 方法一 gen_rate ≈ 客户端速率(output/api_request) >> 会话寿命吞吐(旧口径)
```

方法一的 span 含 TTFT/prefill 与少量网络排队,因此**略低于**服务端速率、
明显低于纯解码速率,属于正常;若方法一数值低于"客户端速率"的一半,
或高于服务端速率,则说明边界配对有失真,需要检查。

已知差异来源:方法一按 `token_usage_record → token_count` 转赠配对,
个别响应的时长可能错位一段(上限 1h 的段已丢弃);OTEL 侧为直方图,
逐请求对应关系缺失(openai/codex #15965:metrics 无会话属性),
两者只在**统计均值**层面可比,不能逐请求对齐。

## 局限

- OTEL 默认关闭,且只对启用后的新会话生效(历史无法回溯);方法一可全量回填。
- gRPC 导出变体(`otlp-grpc`)本脚本不支持,JSON over HTTP 已覆盖本地参考场景。
