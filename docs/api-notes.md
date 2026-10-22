# Polymarket 公开行情接口核对记录

本项目只读取 NBA 比赛和市场行情，不需要钱包私钥或下单凭据。真实行情与演示数据必须明确区分，失败时不得自动用演示数据冒充真实行情。

以下协议依据当前官方 `Polymarket/ts-sdk` 源码核对。源码核对和本地模拟测试不等于真实接口联调；实际连接状态以程序显示的行情来源、连接状态和数据更新时间为准。

## 比赛与盘口发现

- `GET https://gamma-api.polymarket.com/sports` 返回体育项目数组，以 `sport === "nba"` 识别 NBA，使用其 `series` 字段查询比赛，避免硬编码赛季 ID。
- `GET /events/keyset` 支持 `series_id`、`start_time_min`、`start_time_max`、`closed`、`limit`，后续页面使用 `after_cursor`。响应为 `{ events: [...], next_cursor?: string }`。
- `closed=false` 查询未关闭比赛；`closed=any` 可包含已关闭比赛。已结算市场通常没有可用订单簿，过去比赛的范围查询不代表能够恢复过去的订单深度。
- 比赛开赛时间使用事件 `startTime` 或市场 `gameStartTime`。`startDate` 是其他时间元数据，不能代替开赛时间。
- 常见 `sportsMarketType` 为 `moneyline`（胜负）、`spreads`（让分）和 `totals`（大小分）。
- `outcomes`、`outcomePrices`、`clobTokenIds` 可能是 JSON 编码的字符串数组。新协议市场也可提供 `positionIds`；同一订单簿接口可使用其作为资产标识。

来源：[sports.ts](https://github.com/Polymarket/ts-sdk/blob/main/packages/client/src/actions/sports.ts)、[events.ts](https://github.com/Polymarket/ts-sdk/blob/main/packages/client/src/actions/events.ts)、[Gamma 事件字段](https://github.com/Polymarket/ts-sdk/blob/main/packages/bindings/src/gamma/event.ts)、[Gamma 市场字段](https://github.com/Polymarket/ts-sdk/blob/main/packages/bindings/src/gamma/market.ts)。

## 订单簿快照

- 单资产：`GET https://clob.polymarket.com/book?token_id=...`。
- 多资产：`POST https://clob.polymarket.com/books`，JSON 请求为 `[{"token_id":"..."}]`。
- `bids` / `asks` 是聚合的价格档位，每档为 `{price, size}`。价格范围为 0～1，`size` 是份额数量；`price * size` 为该档名义金额。
- 买盘按价格降序、卖盘按价格升序排列，买一和卖一形成价差。Gamma 的参考价格不能替代当前订单簿的可成交报价。

来源：[CLOB HTTP 方法](https://github.com/Polymarket/ts-sdk/blob/main/packages/client/src/actions/clob.ts)。

## 市场 WebSocket

地址为 `wss://ws-subscriptions-clob.polymarket.com/ws/market`。公开市场频道不需要用户认证。

初始订阅：

```json
{"assets_ids":["资产标识"],"type":"market","custom_feature_enabled":false}
```

动态增减订阅使用 `operation: "subscribe"` 或 `"unsubscribe"` 和 `assets_ids`。

- `event_type: "book"` 是完整订单簿快照，包含 `asset_id`、`bids`、`asks`。
- `event_type: "price_change"` 的 `price_changes` 数组包含 `asset_id`、`price`、`size`、`side`；BUY 更新买盘，SELL 更新卖盘。数量替换该价格档位的总量，零数量删除该档。
- 订单簿消息的 `timestamp` 是毫秒时间戳字符串。
- 每 10 秒发送文本 `PING` 并处理 `PONG`；官方 SDK 超过 30 秒未收到 pong 即视为失效。重连需重建快照后再接收增量，避免遗漏更新导致深度失真。
- 单条逐笔成交和最优报价不能用于重建完整深度。

来源：[订阅协议](https://github.com/Polymarket/ts-sdk/blob/main/packages/client/src/websockets/clob/protocol.ts)、[消息结构](https://github.com/Polymarket/ts-sdk/blob/main/packages/bindings/src/subscriptions/clob.ts)、[心跳](https://github.com/Polymarket/ts-sdk/blob/main/packages/client/src/websockets/heartbeat.ts)、[官方服务地址](https://github.com/Polymarket/ts-sdk/blob/main/packages/client/src/environments.ts)。

旧的 [`clob-client`](https://github.com/Polymarket/clob-client) 和 [`py-clob-client`](https://github.com/Polymarket/py-clob-client) 官方仓库已标记归档并建议迁移；新开发应以当前统一 SDK 源码和官方 API 文档为准。
