# 台灣托育補助試算 — x402 API

台灣托育補助試算 API：傳寶寶出生日期（或月齡）、縣市、托育型態、胎次、家庭身份，回傳每月可領的育兒津貼／托育補助／縣市加碼（分項列出）、核實上限、自付額，以及一次性的生育津貼（單獨列出，不加進月領總額）。資料來源只有公開政府公告與規則表（`subsidy-rules-data.json`，規則版本 2026-11-10）。**絕不使用 Easy2Baby 用戶的任何寶寶紀錄。**

- 定價：每次查詢 **USDC $0.01**（Base，exact scheme，`amount: "10000"`，USDC 6 位小數）
- 收款地址（Base）：`0xf56069ed9a60a477c52de3fa615ccabcd6b6dbf2`
- USDC 合約（Base）：`0x833589fCD6eDb6E08f4c7C32D4f71b54bd029029`
- 免費試用：每個錢包 **10 次**
- Facilitator：Coinbase CDP `https://api.cdp.coinbase.com/platform/v2/x402`（`POST /verify`、`POST /settle`，需 CDP API key；見下）

## 本地執行

```bash
cd subsidy-api
node server.js
# 或指定 port：PORT=3000 node server.js
```

Node >= 18，無任何依賴。試用計數存在 `data/trials.json`，重啟後保留。
計算邏輯在 `calc.js`（純函式，可直接 `require('./calc')` 呼叫 `calculate(input, today)` 單元測試，不經 HTTP）。

## 端點

- `GET /health` — `{status:"ok", facilitatorAuth:"cdp"|"cdp-missing-credentials"|"none", rules_version:"2026-11-10", ...}`
- `GET /` — 服務說明、定價、端點、支援縣市與托育型態
- `GET /v1/childcare-subsidy?birthdate=YYYY-MM-DD&city=...&care_type=...` 或 `?age_months=N&city=...&care_type=...`

### 輸入欄位

| 欄位 | 必填 | 說明 |
|---|---|---|
| `birthdate` | 二選一 | `YYYY-MM-DD`，算已滿月齡；不可是未來日期 |
| `age_months` | 二選一 | 0–72 的整數；沒有出生日期時，生育津貼若依出生年份／生效日分表，可能無法判斷（回「未確認」） |
| `city` | 是 | 台北市、新北市、桃園市、台中市、台南市、高雄市、新竹市；其他縣市回 `unsupported: true`（HTTP 200，不扣試用） |
| `care_type` | 是 | `self` 自己帶、`public` 公共化托育（公托／家園）、`quasi_nanny` 準公共保母、`quasi_center` 準公共托嬰中心、`kindergarten_public` 公立幼兒園、`kindergarten_nonprofit` 非營利幼兒園、`kindergarten_quasi` 準公共幼兒園、`kindergarten_private` 私立幼兒園 |
| `birth_order` | 否（預設 1） | 整數 1 以上（1 = 第 1 名子女；3 代表第 3 名以上） |
| `household` | 否（預設 general） | `general` 一般家庭、`mid_low` 中低收入戶、`low` 低收入戶及弱勢家庭 |
| `twins` | 否 | `true`/`false`，或胎數（2 = 雙胞胎、3 = 三胞胎） |
| `income_tax_rate` | 否 | 父母綜合所得稅率（數字）；僅台中市平價托育加碼需要（須未達 20%） |
| `actual_fee` | 否 | 實際每月托育費用（數字）；用於核實上限與自付額 |
| `residence_months` | 否 | 父母一方在該市連續設籍月數（整數）；用來判斷生育津貼設籍是否符合，未提供時只能回備註 |

錯誤輸入回 `400`（缺參數、日期格式錯誤、未來出生日期、`age_months` 超出 0–72、無效的 `care_type`／`household`／`birth_order`／`twins`／`income_tax_rate`／`actual_fee`／`residence_months`）。400 不扣免費試用。

## 回傳形狀

```json
{
  "age_months": 18,
  "birthdate": "2025-05-10",
  "city": "台北市",
  "care_type": "quasi_center",
  "birth_order": 1,
  "household": "general",
  "twins": 0,
  "monthly": {
    "items": [
      { "name": "托育補助（中央・準公共）", "amount": 13000 },
      { "name": "臺北市友善托育補助加碼（準公共）", "amount": 8000 }
    ],
    "subtotal": 21000,
    "capped_by_actual_fee": 20000,
    "total": 20000,
    "self_pay": 0,
    "notes": ["補助金額為上限，實際以繳費為準……"]
  },
  "unconfirmed": [],
  "alternatives": [
    { "name": "臺北市協力照顧補助（獨立計畫）", "note": "……不得與友善托育補助重複請領", "tiers": { "...": { "certificate": 2000, "license": 3000, "center": 3000 } } }
  ],
  "not_eligible": [
    { "name": "育兒津貼", "reason": "已送托公共化或準公共托育，同一名孩子同一段時間不能同時領育兒津貼" }
  ],
  "birth_subsidy": {
    "name": "台北市生育津貼（一次性）",
    "amount": 40000,
    "residence_required_months": 10,
    "residence_status": "unknown",
    "note": "設籍要求：父母一方連續設籍滿 10 個月以上；未提供 residence_months，無法判斷是否符合。併計：可併計新北市、基隆市設籍時間，不含桃園；申請期限：出生次日起 60 天內；以目前月齡推算可能已逾申請期限"
  },
  "rules_version": "2026-11-10",
  "source": "衛福部社會及家庭署、教育部、各縣市政府社會局；逐項來源網址與查證日見 childcare-subsidy-rules.md",
  "disclaimer": "試算結果僅供參考，實際請領資格與金額以各縣市政府公告及審核結果為準。"
}
```

- `monthly.total`：每月補助總額（分項加總，核實上限為 `actual_fee`）。就學補助的 `total` 是**家長月繳上限**，不是領取金額（`items[].kind: "parent_payment_cap"`，此時 `self_pay` 為家長實際月繳）。
- `monthly` 為 `null` 時表示該組合算不出每月金額，原因在 `unconfirmed`（規則未確認）或 `not_eligible`（年齡／型態不適用）。
- `unconfirmed`：規則表或草稿沒寫、無法判斷的項目（例如 2–3 歲延長程序未確認的四市、台北公托／家園未區分、高雄保母日間／全日未區分），絕不猜數字。
- `birth_subsidy`：一次性，單獨列出，不加進月領總額。`residence_status` 為 `eligible`／`not_eligible`／`unknown`（未提供設籍月數）。

## 算式邏輯（摘要，完整見 calc.js 與規則表）

1. 由 `birthdate` 算年齡，分段：0–未滿 2 歲、2–未滿 3 歲（延長托育）、2–未滿 5 歲、5 歲至入國小前。
2. `self` → 育兒津貼（中央 5,000／6,000／7,000 元）＋新竹市加碼 1,000 元（僅 2–6 歲、未領托育補助者）。
3. `public`／`quasi_nanny`／`quasi_center` → 托育補助（中央：公共化 7,000／8,000／9,000 元；準公共 13,000／14,000／15,000 元）＋中低收加 2,000 元／低收弱勢加 4,000 元＋縣市加碼。**不得同時計入育兒津貼**。
4. `kindergarten_public`／`nonprofit`／`quasi` → 就學補助（家長月繳上限：公立 1,000／0／0 元、非營利 2,000／1,000／0 元、準公共 3,000／2,000／1,000 元；低收／中低收全免）。**不得同時計入育兒津貼**。
5. `kindergarten_private` → 育兒津貼（2–未滿 5 歲教育部版）；5 歲至入國小前就讀一般私立幼兒園的就學補助金額規則表未載明，回「未確認」。
6. 核實上限：有提供 `actual_fee` 時，補助總額不得超過實際費用；自付額 = 實際費用 − 補助總額。

## 不能亂算的地方（規則表第 12 項部分確認，2026-11-10）

- **2–3 歲延長托育**：中央規則已確認，新北市、桃園市、台中市程序已確認；**台北市、台南市、高雄市、新竹市的延長程序仍未確認**。這四市在 2–3 歲段回 `monthly: null`＋`unconfirmed`，**不得推定跟中央一樣**。
- **台北市準公共第 2 名以上**：加碼上限 10,000 元（計畫第七點：準公共最高 8,000 元，有其他兄姊者加發 2,000 元）。中央 14,000＋加碼 10,000＝24,000，再依實際收費核實上限。沒有 `actual_fee` 時回 `total` 24000（上限，`self_pay: null`）。市府「全面免負擔」為宣傳說法，計畫原文給的是上限，非無上限（2026-11-10 改，見 TAIPEI-10000-PATCH.md）。
- **台北市公共化（`care_type=public`）**：未區分公辦民營托嬰中心與社區公共托育家園，兩者加碼不同（公托第 1 名 2,500／第 2 名以上 3,000 元；家園第 1 名 6,000／第 2 名以上 8,000 元），加碼列入 `unconfirmed`，總額僅含中央補助。
- **台北市協力照顧**：獨立計畫（每月 2,000–5,000 元），列在 `alternatives`，不疊加進總額，不得與友善托育補助重複請領。
- **桃園市弱勢／雙胞胎**：無固定每月增額數字，補差額、家長負擔比照公托。雙胞胎送托準公共托嬰中心回自付額（第 1 名 2,000 元、第 2 名 1,000 元、第 3 名以上全額補助）；弱勢增額只寫備註，不硬編金額。
- **台南市**：沒有地方托育加碼，托育補助就是中央金額。
- **高雄市準公共保母**：日間 1,600 元／全日 1,840 元，API 未區分日間／全日，列入 `unconfirmed`，總額僅含中央補助。
- **新竹市生育津貼**：現行每胎 30,000 元；115-11-06 修正版每名 60,000 元是 **116-01-01 才施行**，依出生日期判斷適用哪一版（只有月齡時看推算區間是否橫跨生效日）。
- **新北市生育獎勵金**：依出生年份不同（115-01-01 以後出生：40,000／45,000／50,000 元；114 年出生：30,000／40,000／50,000 元）。
- **台中市平價托育加碼**：僅準公共托嬰中心每月 1,400 元，須所得稅率未達 20%（未提供 `income_tax_rate` 時不計入）；不適用準公共保母。
- **半個月計費**：台北市友善托育補助送托日數半個月以下以半個月計，API 無出勤日數輸入，一律按整月計算。

## curl 範例

```bash
# 健康檢查
curl -s http://localhost:3000/health

# 草稿例子 1：18 個月、台北市、準公共托嬰中心、第 1 胎、一般家庭、月費 20,000 元
curl -s "http://localhost:3000/v1/childcare-subsidy?birthdate=2025-05-10&city=%E5%8F%B0%E5%8C%97%E5%B8%82&care_type=quasi_center&birth_order=1&household=general&actual_fee=20000&trial_wallet=0xYOUR_WALLET"

# 草稿例子 2：3 歲、自己帶、第 1 胎、新竹市
curl -s "http://localhost:3000/v1/childcare-subsidy?age_months=36&city=%E6%96%B0%E7%AB%B9%E5%B8%82&care_type=self&birth_order=1&household=general&trial_wallet=0xYOUR_WALLET"

# 免費試用也可以用 header：-H "X-Trial-Wallet: 0xYOUR_WALLET"
```

## 免費試用規則（請先讀這段）

- 識別方式：有付費簽名時用簽名裡的付款人地址；沒付費時用 `X-Trial-Wallet` header 或 `?trial_wallet=` 參數；兩者都沒有時，用呼叫者的 IP 當識別。
- **這個 trial 識別是呼叫者自己報的，不是身分驗證。** 同一個人換個 `trial_wallet` 值就能再拿 10 次，IP 也可能多人共用。這是刻意的取捨：x402 本來就不要求註冊，試用額度只是擋隨便刷的門檻，不是防濫用的鐵牆。
- 每個識別 10 次免費，第 11 次起回 `402`，要付費才能繼續。
- 計數存在 `data/trials.json`，重啟保留；刪掉該檔案就重算。
- 不支援的縣市（`unsupported: true`）與 400 錯誤不扣試用。

## 402 回應長什麼樣子

免費試用用完後，第 11 次呼叫回 HTTP 402，body：

```json
{
  "x402Version": 2,
  "error": "Payment Required",
  "accepts": [
    {
      "scheme": "exact",
      "network": "base",
      "amount": "10000",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bd029029",
      "payTo": "0xf56069ed9a60a477c52de3fa615ccabcd6b6dbf2",
      "maxTimeoutSeconds": 60,
      "extra": { "name": "USDC", "version": "2" }
    }
  ],
  "trial": { "limit": 10, "used": 10, "remaining": 0 }
}
```

同時帶 `X-Payment-Required` header（值就是上面這份 JSON）。

付費呼叫：照 402 的條件簽名後，帶著 `X-Payment` header（base64 編碼的付款 payload，v2 客戶端也可用 `PAYMENT-SIGNATURE`）重發同一個請求。伺服器會先 `POST /verify`，驗證通過才 `POST /settle`，成功才回 200 並在 body 附 `settlement`（`success`、`transaction`、`network`、`payer`），header 附 `PAYMENT-RESPONSE` / `X-Payment-Response`（base64 的 settlement 結果）。驗證失敗回 402；facilitator 連不上或結算失敗回 502，**絕不會在沒驗證成功前免費給資料**。

## 部署（Render / Railway）

1. 把 `subsidy-api/` 整個資料夾推到一個 Git repo（`server.js`、`package.json`、`calc.js`、`subsidy-rules-data.json`、`cdp-auth.js`、`data/` 都要包含；`data/trials.json` 會跟著走，部署後重啟計數保留在同一台機器上——注意：免費方案重啟或換機時可能遺失，正式上線後應改用資料庫）。
2. 在 Render 建一個 Web Service（或 Railway 建一個 Service），Start Command：`node server.js`，環境變數 `PORT` 由平台自動給（程式會讀 `PORT`）。
3. **收 Base 主網 USDC 一定要設這兩個環境變數**（在 Render / Railway 的 Environment 設定裡填，不要貼在聊天室、不要寫進程式碼）：
   - `CDP_API_KEY_ID=` 建 key 時給的那串（像 `organizations/.../apiKeys/...`）
   - `CDP_API_KEY_SECRET=` 建 key 時下載的私鑰（EC PEM 或 Ed25519 base64，只顯示一次，遺失要重建）
   `FACILITATOR_URL` 預設就是 CDP（`https://api.cdp.coinbase.com/platform/v2/x402`），不用另外設。伺服器每次呼叫 facilitator 都會用這組 key 現簽一張 120 秒有效的 JWT（見 `cdp-auth.js`），不需要 CDP wallet secret，也沒有私鑰會被拿去轉帳——這組 key 只能問「這筆付款是不是真的」。
   沒設這兩個時，伺服器啟動會警告，付費驗證會失敗（不會免費給資料）。
4. 部署完會有一個公開網址（例如 `https://xxx.onrender.com`），先打 `GET https://xxx.onrender.com/health`，看到 `"facilitatorAuth":"cdp"` 才表示 CDP 接好了；再把 `GET https://xxx.onrender.com/v1/childcare-subsidy?...` 拿去上架到 x402 探索市集。

## 重要限制（誠實說明）

- **目前沒有公開網址。** 這份程式只在本地跑過、本地測過（見 `TESTS.md`）。一定要部署到 Render / Railway（或任何能跑 Node 的主機）才會有公開 URL。
- **真實 Base 主網付款尚未實測。** 測試時沒有花真錢、沒有結算任何主網付款、沒有用任何私鑰。`POST /settle` 的程式碼有寫、但沒有用真實有效簽名跑過。
- **公開 facilitator（x402.org）不支援 Base 主網。** 實測（疫苗 API，2026-11-09）`GET https://x402.org/facilitator/supported` 回傳的 v2 `exact` 只支援 Base Sepolia 測試網，沒有 Base 主網。所以本服務預設直接用 Coinbase CDP facilitator。
- **第 12 項（2–3 歲延長程序）只有部分確認**：台北、台南、高雄、新竹四市的延長程序未確認，該年齡段回「未確認」，不是 bug，是刻意不猜。
- **有兩三個來源是轉載／摘要交叉核對的**（規則表 1.7 節註：社家署要點公告頁開啟失敗，第 21 點原文以苗栗縣、基隆市轉載 PDF 交叉核對），正式上線前最好再覆核一次。
- `data/trials.json` 是本機檔案計數，不適合多台機器或頻繁重啟的免費方案，正式上線請換資料庫。
