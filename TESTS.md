# TESTS — subsidy-calculator x402 API

Test date: 2026-11-10 (server date). Node v24.22.1. Main server run locally on
port 3105 (default env: CDP facilitator, no CDP keys, so `/health` reports
`"facilitatorAuth":"cdp-missing-credentials"`); the 502-path server ran on
port 3106 with `FACILITATOR_URL=http://127.0.0.1:9`; the public-facilitator
server ran on port 3107 with `FACILITATOR_URL=https://x402.org/facilitator`;
the CDP live-test server ran on port 3108 with an ephemeral EC test key
(generated in memory, deleted after). No real funds were spent, no real
mainnet payment was settled, no private key was used at any point.
After testing, `data/trials.json` was reset to `{"counts": {}}`.

HTTP test script: `/tmp/test-subsidy.js` (100 assertions).
CDP live test script: `/tmp/test-cdp-live.js`.

Patch re-test 2026-11-10 (`/tmp/test-patch.js`, 11/11 pass): Taipei quasi 2nd child now caps at 10,000 (fee 20000→20000/0, fee 25000→24000/1000, no fee→24000 cap/null), 3rd child 25000→25000/0, spec examples 1–2 unchanged, 2–3yo Taipei still unconfirmed, invalid 400, unsupported city, trials 10×200 then 402.

Extension patch re-test 2026-11-11 (`/tmp/test-extension-patch.js` + local server port 3121): rules_version 2026-11-11, `extension_confirmed` all seven cities true (item 12 fully confirmed, central rule §21 nationwide; Taipei via 109-year notice + Q6, Kaohsiung via city Social Affairs Bureau page, Tainan/Hsinchu via central rule only). 30-month quasi_center 1st child, no fee: Taipei 21000 (13000+8000), Tainan 13000, Kaohsiung 15500 (13000+2500), Hsinchu 14500 (13000+1500), all `unconfirmed: []`; controls unchanged (Taoyuan 17500, New Taipei public 7000, Taipei 18-month spec example 20000/0). After testing, `data/trials.json` was reset to `{"counts": {}}`. Not deployed — live Render service still runs the pre-patch version until the user approves deployment.

## 1. Health / root — PASS

```
GET /health
{"status":"ok","time":"2026-11-10T04:37:24.685Z","facilitator":"https://api.cdp.coinbase.com/platform/v2/x402","facilitatorAuth":"cdp-missing-credentials","rules_version":"2026-11-10"}  HTTP 200

GET /
{"service":"台灣托育補助試算 x402 API","version":"1.0.0","price":"USDC $0.01 / call on Base (exact scheme)","free_trial":"10 calls per wallet","payTo":"0xf56069ed9a60a477c52de3fa615ccabcd6b6dbf2","asset":"0x833589fCD6eDb6E08f4c7C32D4f71b54bd029029","network":"base","facilitator":"https://api.cdp.coinbase.com/platform/v2/x402","facilitatorAuth":"cdp-missing-credentials","rules_version":"2026-11-10", ...}  HTTP 200
```

## 2. 草稿兩個例子 — PASS（逐項核對）

**例子 1** — `birthdate=2025-05-10`（2026-11-10 為 18 個月）、台北市、準公共托嬰中心、第 1 胎、一般家庭、實際月費 20,000 元：

```
items: [托育補助（中央・準公共） 13000, 臺北市友善托育補助加碼（準公共） 8000]
subtotal 21000, capped_by_actual_fee 20000, total 20000, self_pay 0
birth_subsidy: 台北市生育津貼 40000（一次性）, residence_status unknown（未提供 residence_months）
not_eligible: [育兒津貼（已送托準公共托育，不能同時領）]
```

**例子 2** — `age_months=36`、新竹市、自己帶、第 1 胎、一般家庭：

```
items: [育兒津貼（中央） 5000, 新竹市育兒津貼加碼 1000]
total 6000
birth_subsidy: 新竹市生育津貼 30000（一次性，現行每胎 30,000 元）
```

## 3. 年齡邊界 — PASS

| age_months | 條件 | 結果 |
|---|---|---|
| 24 | 新北市、準公共托嬰中心 | 13000 + 新北聯盟 3000 = 16000（延長已確認） |
| 24 | 台北市、準公共托嬰中心 | 13000 + 台北加碼 8000 = 21000（延長已確認，2026-11-11 補丁） |
| 36 | 台北市、自己帶 | 育兒津貼 5000（無台北加碼） |
| 36 | 台北市、準公共托嬰中心 | `monthly: null`，`not_eligible`：托育補助僅至未滿 3 歲 |
| 60 | 台北市、自己帶 | `monthly: null`，`not_eligible`：已滿 5 歲，育兒津貼僅至未滿 5 歲 |
| 60 | 台北市、公立幼兒園、第 1 胎 | 家長月繳上限 1000，`total` 1000，`self_pay` 1000，`kind: parent_payment_cap` |
| 60 | 台北市、私立幼兒園 | `monthly: null`，`unconfirmed`：5 歲私立就學補助金額規則表未載明 |
| 72 | 台北市、自己帶 | `monthly: null`，`not_eligible`：已滿 6 歲，入國小年齡 |

## 4. 胎次 — PASS

- 台北市準公共托嬰中心第 2 名、`actual_fee=20000` → `total` 20000、`self_pay` 0（加碼 10000，中央 14000＋加碼 10000＝24000，核實上限 20000）。
- 台北市準公共托嬰中心第 2 名、無 `actual_fee` → `total` 24000（上限，`self_pay: null`，備註「補助金額為上限，實際以繳費為準」）。
- 台北市準公共托嬰中心第 2 名、`actual_fee=25000` → `total` 24000、`self_pay` 1000（2026-11-10 改：舊版 total 25000、self_pay 0）。
- 台北市準公共托嬰中心第 3 名、`actual_fee=25000` → `total` 25000、`self_pay` 0（中央 15000＋加碼 10000＝25000）。
- 台北市公共化第 2 名 → `total` 8000（僅中央），加碼列入 `unconfirmed`（公托／家園未區分）。
- 桃園市準公共托嬰中心第 2 名 → 18500；第 3 名 → 19500（與規則表「合計」一致）。
- 高雄市準公共托嬰中心第 2 名 → 16500（14000 + 2500）。
- 高雄市準公共保母第 1 名 → `total` 13000（僅中央），加碼列入 `unconfirmed`（日間 1600／全日 1840 未區分）。

## 5. 台中市平價托育加碼（所得稅率）— PASS

- 稅率 10 → 13000 + 1400 = 14400。
- 稅率 25 → 13000（不符加碼，備註說明）。
- 未提供稅率 → 13000（未計入，備註說明須未達 20%）。
- 準公共保母 → 13000（加碼僅適用托嬰中心，備註說明）。

## 6. 家庭身份 — PASS

- 中低收入戶、台北市準公共第 1 名 → 23000（13000 + 2000 + 8000）。
- 低收入戶、高雄市準公共第 1 名 → 19500（13000 + 4000 + 2500）。
- 低收入戶、公立幼兒園第 1 名 → 上限 0（學費全免），`total` 0、`self_pay` 0。
- 非營利幼兒園第 2 名 → 上限 1000；準公共幼兒園第 3 名 → 上限 1000。
- 私立幼兒園第 2 名（36 個月）→ 育兒津貼 6000。

## 7. 雙胞胎 — PASS

- 桃園市準公共托嬰中心第 1 名、雙胞胎、`actual_fee=20000` → `self_pay` 2000、`total` 18000。
- 桃園市準公共托嬰中心第 2 名、雙胞胎、`actual_fee=20000` → `self_pay` 1000、`total` 19000。
- 桃園市準公共托嬰中心第 1 名、雙胞胎、無 `actual_fee` → `total: null`、`self_pay` 2000。
- 桃園市雙胞胎生育津貼第 1 胎 → 40000（30000 + 10000）。
- 台中市雙胞胎生育津貼 → 20000（每胎皆 20000 元）。
- 新竹市雙胞胎生育津貼（現行）→ 60000。

## 8. 核實上限 — PASS

- 台南市準公共托嬰中心第 1 名、`actual_fee=10000` → `total` 10000、`capped_by_actual_fee` 10000、`self_pay` 0。
- 台南市準公共托嬰中心第 1 名、無 `actual_fee` → `total` 13000（無地方加碼）。

## 9. 2–3 歲延長（七市皆已確認，2026-11-11 補丁）— PASS

- 30 個月、台北市／台南市／高雄市／新竹市、準公共托嬰中心 → 台北 21000、台南 13000、高雄 15500、新竹 14500，`unconfirmed: []`（舊版：全部 `monthly: null`，2–3 歲延長程序未確認）。
- 30 個月、桃園市準公共托嬰中心 → 17500。
- 30 個月、台中市準公共托嬰中心（稅率 5）→ 14400。
- 30 個月、新北市公共化 → 7000（延長已確認，公共化無聯盟加碼）。

## 10. 設籍與生育津貼 — PASS

- 台北市、提供設籍 10 個月 → `residence_status: eligible`；提供 5 個月 → `not_eligible`。
- 未提供 `residence_months` → `residence_status: unknown`，備註寫明設籍要求與併計規則，不說符合。
- 高雄市生育津貼 → 30000（不分胎次）；台南市第 3 胎 → 30000；台中市第 4 胎 → 40000。

## 11. 新竹生育津貼日期判斷、新北出生年份 — PASS（calc.js 直接呼叫，注入固定 today）

- 新竹市、出生 2027-01-15（today 2027-02-01）→ 60000（修正版，每名 60,000 元）。
- 新竹市、出生 2026-05-01（today 2026-11-10）→ 30000（現行）。
- 新竹市、出生 2027-01-15、雙胞胎 → 120000（每名 60000 × 2；多胞胎合計金額規則表未明載，依每名計算，備註有寫）。
- 新北市、月齡 10（today 2026-11-10，出生區間 2025-12-11 至 2026-01-10 橫跨 115-01-01）→ 生育津貼 `amount: null`，`unconfirmed`（無法判斷適用哪一表）。
- 新北市、月齡 11（出生 2025 年）→ 30000（114 年表）。
- 新北市、出生 2026-06-01 → 40000（115 年表）。

## 12. 不支援縣市 — PASS

- `city=基隆市` → HTTP 200，`unsupported: true`，不含 `trial`（不扣試用）。
- 同一 `trial_wallet` 隨後正常呼叫台北市 → `trial.used=1`。

## 13. 無效輸入 — 全部 PASS（HTTP 400，不扣試用）

缺參數、`birthdate=2025-02-30`、未來出生日期、`age_months=73`、`age_months=abc`、
無效 `care_type`、缺 `care_type`、缺 `city`、`birth_order=0`、`birth_order=abc`、
無效 `household`、`actual_fee=-1`、`income_tax_rate=150`、`twins=maybe`、
`residence_months=-1`。`GET /nope` → 404。

## 14. 免費試用計數 — PASS

錢包 `trial-count-1`、`age_months=18`，連續 11 次呼叫：

```
call 1–10 -> HTTP 200, trial.used=1..10
call 11   -> HTTP 402
```

11th call, full response verified: `x402Version` 2, `accepts[0].scheme` `exact`,
`network` `base`, `amount` `"10000"`, `asset` USDC-on-Base contract,
`payTo` `0xf56069ed9a60a477c52de3fa615ccabcd6b6dbf2`, `maxTimeoutSeconds` 60,
`extra` `{name:"USDC", version:"2"}`, plus `X-Payment-Required` header,
`trial: {limit:10, used:10, remaining:0}`.

## 15. 重啟留存 — PASS

伺服器停止再啟動後：
- `trial-count-1`（已用 10 次）仍回 HTTP 402。
- 新錢包 `post-restart-1` 回 HTTP 200，`trial.used=1`。

## 16. 匿名 IP 備援 — PASS

無 `trial_wallet`、無 `X-Trial-Wallet` header：
`{"trial":{"type":"ip","used":1,"remaining":9,"limit":10}, ...}` HTTP 200。

## 17. 付費流程：假付款（公開 facilitator）— PASS

Port 3107（`FACILITATOR_URL=https://x402.org/facilitator`），結構完整的假 v1
付款 payload 作 base64 `X-Payment` header：回 HTTP 402，未給任何資料。

## 18. 付費流程：facilitator 不可達 — PASS（502，未給資料）

Port 3106（`FACILITATOR_URL=http://127.0.0.1:9`），同一個假 `X-Payment` header：

```
HTTP/1.1 502 Bad Gateway
{"error":"Facilitator unreachable","detail":"Could not reach http://127.0.0.1:9/verify (TypeError). No data was served and no payment was settled."}
```

## 19. CDP facilitator — PASS（JWT 自測＋實測）

`node test-cdp-auth.js`：EC PEM（ES256）與 Ed25519 base64（EdDSA）皆 PASS，
header／payload 與簽名驗證無誤；錯誤密鑰被拒絕。

實測（臨時測試 key，本機產生、用完即丟；port 3108）：
- `/health` 回 `"facilitatorAuth":"cdp"`，免費試用回 HTTP 200。
- 假付款打真的 CDP `/verify`：第一次呼叫逾時（10 秒，`TimeoutError`，當下
  CDP 直連探測隨後 0.44 秒回 401，判定為偶發），重試一次回 HTTP 402，
  `invalidReason: "invalid_payment"`——CDP 接受了 JWT 認證、結構化擋下假
  付款、沒有給資料。備註：疫苗 API 同款測試拿到的是 `policy_denied`，
  拒絕理由字串會隨付款 payload 形狀而異；關鍵是 JWT 被接受（不是 401）
  且回 402、未給資料。

## NOT tested

- **真實 Base 主網付款，端到端。** 沒有花真錢、沒有結算任何主網付款、
  沒有用任何私鑰。`POST /settle` 的程式碼有寫、但沒有用真實有效簽名跑過。
- **真實 x402 客戶端簽名流程。** 測試用的是手造假 payload，不是錢包簽署的
  EIP-3009 授權。
- **正式部署。** 沒有公開網址；伺服器只在 localhost 跑過。
