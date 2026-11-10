// 台灣托育補助試算 — x402 API server
// Zero dependencies, plain node:http. Node >= 18 (uses global fetch).
// Data: public childcare subsidy rules only (rules version 2026-11-10,
// see subsidy-rules-data.json). No Easy2Baby user data, ever.
//
// Pricing: USDC $0.01 / call on Base (exact scheme).
//   amount "10000" (USDC has 6 decimals), payTo below, asset = USDC on Base.
// Free trial: 10 calls per wallet identifier (see README — the trial
//   identifier is self-asserted, it is NOT authentication).
// Paid flow: X-Payment (or PAYMENT-SIGNATURE) header -> POST /verify to the
//   facilitator -> if valid, POST /settle -> only then serve data.
//   If the facilitator is unreachable or settle fails, respond 502 and
//   NEVER serve paid data for free.
//
// Facilitator: Coinbase CDP (https://api.cdp.coinbase.com/platform/v2/x402).
//   The CDP API key (CDP_API_KEY_ID / CDP_API_KEY_SECRET) is read from the
//   environment only — never paste it into chat or commit it. See cdp-auth.js.
//   Without those env vars, paid verify/settle fails (502), free trials
//   still work, and /health reports facilitatorAuth "cdp-missing-credentials".
//
// Calculation: see calc.js. Amounts the rules table or spec draft do not
// give are returned as "unconfirmed" / "unsupported", never guessed.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 3000);
const FACILITATOR_URL = (process.env.FACILITATOR_URL || 'https://api.cdp.coinbase.com/platform/v2/x402').replace(/\/$/, '');
const TRIALS_FILE = path.join(__dirname, 'data', 'trials.json');
// CDP facilitator auth (only used when the facilitator is api.cdp.coinbase.com).
// Set as environment variables on the host (Render/Railway) — never paste the
// secret into chat or commit it. See cdp-auth.js for the JWT format.
const CDP_API_KEY_ID = process.env.CDP_API_KEY_ID || '';
const CDP_API_KEY_SECRET = process.env.CDP_API_KEY_SECRET || '';
const { cdpAuthHeaders } = require('./cdp-auth');
const IS_CDP_FACILITATOR = (() => {
  try { return new URL(FACILITATOR_URL).hostname === 'api.cdp.coinbase.com'; } catch (_) { return false; }
})();
const CDP_AUTH_CONFIGURED = IS_CDP_FACILITATOR && Boolean(CDP_API_KEY_ID && CDP_API_KEY_SECRET);

const { calculate, CITIES, CARE_TYPES, HOUSEHOLDS, RULES } = require('./calc');

const PAY_TO = '0xf56069ed9a60a477c52de3fa615ccabcd6b6dbf2';
const ASSET_USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bd029029';
const AMOUNT = '10000'; // $0.01 USDC, 6 decimals
const NETWORK = 'base';
const FREE_TRIAL_LIMIT = 10;
const SOURCE = RULES.source;
const DISCLAIMER = RULES.disclaimer;

// ---------------------------------------------------------------- data ----
// (calculation data lives in subsidy-rules-data.json, loaded by calc.js)

// ------------------------------------------------------- trial storage ----
function loadTrials() {
  try {
    const raw = JSON.parse(fs.readFileSync(TRIALS_FILE, 'utf8'));
    if (raw && typeof raw === 'object' && raw.counts && typeof raw.counts === 'object') {
      return raw;
    }
  } catch (_) {
    // missing / corrupt -> start fresh (a corrupt file is renamed, not deleted)
    try {
      if (fs.existsSync(TRIALS_FILE)) {
        fs.renameSync(TRIALS_FILE, TRIALS_FILE + '.corrupt-' + Date.now());
      }
    } catch (_) {}
  }
  return { counts: {} };
}

let trials = loadTrials();

function saveTrials() {
  fs.mkdirSync(path.dirname(TRIALS_FILE), { recursive: true });
  fs.writeFileSync(TRIALS_FILE, JSON.stringify(trials, null, 2) + '\n', 'utf8');
}

// ------------------------------------------------------------- helpers ----
function sendJson(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...(extraHeaders || {}),
  });
  res.end(body);
}

function isValidDateParts(y, m, d) {
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

function parseBirthdate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!isValidDateParts(y, mo, d)) return null;
  return new Date(y, mo - 1, d);
}

function startOfToday() {
  const t = new Date();
  return new Date(t.getFullYear(), t.getMonth(), t.getDate());
}

// Completed months between birthdate and today.
function completedMonths(birth, today) {
  let months = (today.getFullYear() - birth.getFullYear()) * 12
    + (today.getMonth() - birth.getMonth());
  if (today.getDate() < birth.getDate()) months -= 1;
  return months;
}

function formatDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) {
    return fwd.split(',')[0].trim();
  }
  const raw = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'unknown';
  return raw.replace(/^::ffff:/, '');
}

// ---------------------------------------------------------- x402 payment --
function paymentRequirements() {
  return {
    scheme: 'exact',
    network: NETWORK,
    amount: AMOUNT,
    asset: ASSET_USDC_BASE,
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: { name: 'USDC', version: '2' },
  };
}

function paymentRequiredBody(extra) {
  return {
    x402Version: 2,
    error: 'Payment Required',
    accepts: [paymentRequirements()],
    ...(extra || {}),
  };
}

function send402(res, extra) {
  const body = paymentRequiredBody(extra);
  sendJson(res, 402, body, {
    'X-Payment-Required': JSON.stringify(body),
  });
  return body;
}

function decodePaymentHeader(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  try {
    if (s.startsWith('{')) return JSON.parse(s);
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch (_) {
    return null;
  }
}

function extractPayer(paymentPayload) {
  if (!paymentPayload || typeof paymentPayload !== 'object') return null;
  const candidates = [
    paymentPayload?.payload?.authorization?.from,
    paymentPayload?.payload?.from,
    paymentPayload?.authorization?.from,
    paymentPayload?.payload?.payer,
    paymentPayload?.payer,
    paymentPayload?.payload?.authorization?.payer,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && /^0x[0-9a-fA-F]{40}$/.test(c)) return c.toLowerCase();
  }
  return null;
}

async function facilitatorCall(pathSuffix, body) {
  // CDP facilitator calls need a fresh JWT per request, bound to this exact
  // method + host + path (see cdp-auth.js). The public x402.org facilitator
  // needs no auth. If CDP auth is misconfigured, fail loudly here so
  // verifyAndSettle turns it into a 502 — never serve paid data.
  let headers = { 'Content-Type': 'application/json' };
  if (IS_CDP_FACILITATOR) {
    if (!CDP_AUTH_CONFIGURED) {
      throw new Error('CDP facilitator is configured but CDP_API_KEY_ID / CDP_API_KEY_SECRET are not set');
    }
    const u = new URL(FACILITATOR_URL + pathSuffix);
    headers = {
      ...headers,
      ...cdpAuthHeaders({
        apiKeyId: CDP_API_KEY_ID,
        apiKeySecret: CDP_API_KEY_SECRET,
        method: 'POST',
        host: u.hostname,
        path: u.pathname,
      }),
    };
  }
  const res = await fetch(FACILITATOR_URL + pathSuffix, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, ok: res.ok, json, text };
}

// Returns { ok: true, settlement } on success, or { ok: false, status, body }
// where status is 402 (invalid payment) or 502 (facilitator / settle failure).
async function verifyAndSettle(paymentPayload) {
  const requirements = paymentRequirements();
  const body = { x402Version: 2, paymentPayload, paymentRequirements: requirements };

  let verify;
  try {
    verify = await facilitatorCall('/verify', body);
  } catch (e) {
    return {
      ok: false,
      status: 502,
      body: {
        error: 'Facilitator unreachable',
        detail: `Could not reach ${FACILITATOR_URL}/verify (${e && e.name ? e.name : 'fetch failed'}). No data was served and no payment was settled.`,
      },
    };
  }
  if (verify.json && typeof verify.json.isValid === 'boolean') {
    if (!verify.json.isValid) {
      return {
        ok: false,
        status: 402,
        body: paymentRequiredBody({
          invalidReason: verify.json.invalidReason || 'invalid_payment',
          payer: verify.json.payer || undefined,
        }),
      };
    }
  } else if (verify.status >= 500) {
    return {
      ok: false,
      status: 502,
      body: {
        error: 'Facilitator error',
        detail: `Facilitator /verify returned HTTP ${verify.status}. No data was served and no payment was settled.`,
      },
    };
  } else if (!verify.ok) {
    // 4xx without an isValid flag: the payload was rejected by the facilitator.
    return {
      ok: false,
      status: 402,
      body: paymentRequiredBody({
        invalidReason: (verify.json && (verify.json.invalidReason || verify.json.error)) || 'invalid_payment',
      }),
    };
  }

  // Verify passed: settle. Never serve paid data if settle does not succeed.
  let settle;
  try {
    settle = await facilitatorCall('/settle', body);
  } catch (e) {
    return {
      ok: false,
      status: 502,
      body: {
        error: 'Facilitator unreachable',
        detail: `Verification passed but ${FACILITATOR_URL}/settle could not be reached (${e && e.name ? e.name : 'fetch failed'}). No data was served.`,
      },
    };
  }
  if (!settle.json || settle.json.success !== true) {
    return {
      ok: false,
      status: 502,
      body: {
        error: 'Settlement failed',
        detail: `Verification passed but settlement did not succeed (facilitator HTTP ${settle.status}). No data was served.`,
        errorReason: settle.json ? (settle.json.errorReason || settle.json.error || undefined) : undefined,
      },
    };
  }
  return { ok: true, settlement: settle.json };
}

// ------------------------------------------------------------ trial id ----
function trialIdentifier(req, payer) {
  if (payer) return { key: 'wallet:' + payer, type: 'wallet', wallet: payer };
  const headerWallet = req.headers['x-trial-wallet'];
  const url = new URL(req.url, 'http://localhost');
  const paramWallet = url.searchParams.get('trial_wallet');
  const raw = String(headerWallet || paramWallet || '').trim();
  if (raw) {
    const norm = /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw.toLowerCase() : raw.toLowerCase();
    return { key: 'wallet:' + norm, type: 'wallet', wallet: norm };
  }
  const ip = clientIp(req);
  return { key: 'ip:' + ip, type: 'ip', wallet: null };
}

// -------------------------------------------------------- input parsing ---
// twins: "true"/"false" or an integer count (2 = twins, 3 = triplets...).
// Returns { count } or { error }.
function parseTwins(raw) {
  if (raw === null || raw === undefined || raw === '') return { count: 0 };
  const s = String(raw).trim().toLowerCase();
  if (s === 'true' || s === 'yes' || s === '1') return { count: 2 };
  if (s === 'false' || s === 'no' || s === '0') return { count: 0 };
  if (!/^\d+$/.test(s)) return { error: 'Invalid twins. Use true/false, or a number of babies (2 = twins, 3 = triplets).' };
  const n = Number(s);
  if (n > 5) return { error: 'Invalid twins. Number of babies must be 5 or fewer.' };
  return { count: n <= 1 ? 0 : n };
}

function parseOptionalNumber(raw, name, min, max) {
  if (raw === null || raw === undefined || raw === '') return { value: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    return { error: `Invalid ${name}. Use a number between ${min} and ${max}.` };
  }
  return { value: n };
}

function parseOptionalInt(raw, name, min) {
  if (raw === null || raw === undefined || raw === '') return { value: null };
  if (!/^\d+$/.test(String(raw).trim())) {
    return { error: `Invalid ${name}. Use a whole number, e.g. ${name}=12.` };
  }
  const n = Number(raw);
  if (n < min) return { error: `Invalid ${name}. Must be ${min} or more.` };
  return { value: n };
}

// ---------------------------------------------------------------- server --
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed. This API only serves GET.' });
    return;
  }

  if (pathname === '/health') {
    sendJson(res, 200, { status: 'ok', time: new Date().toISOString(), facilitator: FACILITATOR_URL, facilitatorAuth: IS_CDP_FACILITATOR ? (CDP_AUTH_CONFIGURED ? 'cdp' : 'cdp-missing-credentials') : 'none', rules_version: RULES.rules_version });
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    sendJson(res, 200, {
      service: '台灣托育補助試算 x402 API',
      version: '1.0.0',
      price: 'USDC $0.01 / call on Base (exact scheme)',
      free_trial: '10 calls per wallet',
      payTo: PAY_TO,
      asset: ASSET_USDC_BASE,
      network: NETWORK,
      facilitator: FACILITATOR_URL,
      facilitatorAuth: IS_CDP_FACILITATOR ? (CDP_AUTH_CONFIGURED ? 'cdp' : 'cdp-missing-credentials') : 'none',
      rules_version: RULES.rules_version,
      endpoints: {
        health: 'GET /health',
        subsidy: 'GET /v1/childcare-subsidy?birthdate=YYYY-MM-DD&city=...&care_type=... or ?age_months=N&city=...&care_type=...',
      },
      cities_supported: CITIES,
      care_types: CARE_TYPES,
      source: SOURCE,
      disclaimer: DISCLAIMER,
    });
    return;
  }

  if (pathname !== '/v1/childcare-subsidy') {
    sendJson(res, 404, { error: 'Not found. See GET / for endpoints.' });
    return;
  }

  // ---- validate input (no trial consumed, no payment needed for a 400) ----
  const birthdateParam = url.searchParams.get('birthdate');
  const ageParam = url.searchParams.get('age_months');
  let ageMonths;
  let birthdate = null;
  let birthdateObj = null;

  if (birthdateParam) {
    birthdateObj = parseBirthdate(birthdateParam);
    if (!birthdateObj) {
      sendJson(res, 400, { error: 'Invalid birthdate. Use YYYY-MM-DD with a real calendar date, e.g. birthdate=2025-05-10.' });
      return;
    }
    const today = startOfToday();
    if (birthdateObj > today) {
      sendJson(res, 400, { error: 'Invalid birthdate. Birthdate must not be in the future.' });
      return;
    }
    birthdate = formatDate(birthdateObj);
    ageMonths = completedMonths(birthdateObj, today);
  } else if (ageParam !== null) {
    if (!/^\d+$/.test(ageParam)) {
      sendJson(res, 400, { error: 'Invalid age_months. Use a whole number of months, e.g. age_months=18.' });
      return;
    }
    ageMonths = Number(ageParam);
    if (ageMonths < 0 || ageMonths > 72) {
      sendJson(res, 400, { error: 'Invalid age_months. Must be between 0 and 72.' });
      return;
    }
  } else {
    sendJson(res, 400, { error: 'Missing parameter. Provide ?birthdate=YYYY-MM-DD or ?age_months=N, plus city and care_type.' });
    return;
  }

  const city = url.searchParams.get('city');
  if (!city) {
    sendJson(res, 400, { error: 'Missing parameter city. Supported cities: 台北市、新北市、桃園市、台中市、台南市、高雄市、新竹市.' });
    return;
  }

  const careType = url.searchParams.get('care_type');
  if (!careType) {
    sendJson(res, 400, { error: 'Missing parameter care_type. Use self, public, quasi_nanny, quasi_center, kindergarten_public, kindergarten_nonprofit, kindergarten_quasi or kindergarten_private.' });
    return;
  }
  if (!CARE_TYPES.includes(careType)) {
    sendJson(res, 400, { error: `Invalid care_type "${careType}". Use self, public, quasi_nanny, quasi_center, kindergarten_public, kindergarten_nonprofit, kindergarten_quasi or kindergarten_private.` });
    return;
  }

  const birthOrderParam = url.searchParams.get('birth_order');
  let birthOrder = 1;
  if (birthOrderParam !== null) {
    if (!/^\d+$/.test(birthOrderParam) || Number(birthOrderParam) < 1) {
      sendJson(res, 400, { error: 'Invalid birth_order. Use a whole number of 1 or more (1 = first child, 2 = second, 3 = third or above).' });
      return;
    }
    birthOrder = Number(birthOrderParam);
    if (birthOrder > 10) {
      sendJson(res, 400, { error: 'Invalid birth_order. Must be 10 or less.' });
      return;
    }
  }

  const household = url.searchParams.get('household') || 'general';
  if (!HOUSEHOLDS.includes(household)) {
    sendJson(res, 400, { error: `Invalid household "${household}". Use general, mid_low or low.` });
    return;
  }

  const twinsParsed = parseTwins(url.searchParams.get('twins'));
  if (twinsParsed.error) {
    sendJson(res, 400, { error: twinsParsed.error });
    return;
  }

  const taxParsed = parseOptionalNumber(url.searchParams.get('income_tax_rate'), 'income_tax_rate', 0, 100);
  if (taxParsed.error) {
    sendJson(res, 400, { error: taxParsed.error });
    return;
  }

  const feeParsed = parseOptionalNumber(url.searchParams.get('actual_fee'), 'actual_fee', 0, 1000000);
  if (feeParsed.error) {
    sendJson(res, 400, { error: feeParsed.error });
    return;
  }

  const residenceParsed = parseOptionalInt(url.searchParams.get('residence_months'), 'residence_months', 0);
  if (residenceParsed.error) {
    sendJson(res, 400, { error: residenceParsed.error });
    return;
  }

  const result = calculate({
    age_months: ageMonths,
    birthdate,
    birthdateObj,
    city,
    care_type: careType,
    birth_order: birthOrder,
    household,
    twins: twinsParsed.count,
    income_tax_rate: taxParsed.value,
    actual_fee: feeParsed.value,
    residence_months: residenceParsed.value,
  });

  // Unsupported city: informational only, no priced data — no trial
  // consumed, no payment needed.
  if (result.unsupported) {
    sendJson(res, 200, result);
    return;
  }

  const base = result;

  // ---- payment present? verify + settle, then serve. ----
  const paymentHeader = req.headers['x-payment'] || req.headers['payment-signature'];
  if (paymentHeader) {
    const paymentPayload = decodePaymentHeader(paymentHeader);
    if (!paymentPayload || typeof paymentPayload !== 'object') {
      send402(res, { invalidReason: 'invalid_payment_header' });
      return;
    }
    const outcome = await verifyAndSettle(paymentPayload);
    if (!outcome.ok) {
      if (outcome.status === 402) {
        // 402 body already shaped by verifyAndSettle.
        sendJson(res, 402, outcome.body, {
          'X-Payment-Required': JSON.stringify(outcome.body),
        });
      } else {
        sendJson(res, outcome.status, outcome.body);
      }
      return;
    }
    const settlement = outcome.settlement;
    const payer = extractPayer(paymentPayload) || settlement.payer || null;
    const paidBody = {
      ...base,
      settlement: {
        success: settlement.success,
        transaction: settlement.transaction || null,
        network: settlement.network || NETWORK,
        payer: payer,
      },
    };
    const settlementB64 = Buffer.from(JSON.stringify(settlement), 'utf8').toString('base64');
    sendJson(res, 200, paidBody, {
      'PAYMENT-RESPONSE': settlementB64,
      'X-Payment-Response': settlementB64,
    });
    console.log(`${new Date().toISOString()} PAID ${pathname} age=${ageMonths} city=${city} care=${careType} payer=${payer}`);
    return;
  }

  // ---- no payment: free trial ----
  const trial = trialIdentifier(req, null);
  const used = trials.counts[trial.key] || 0;
  if (used >= FREE_TRIAL_LIMIT) {
    send402(res, {
      trial: { limit: FREE_TRIAL_LIMIT, used, remaining: 0 },
    });
    console.log(`${new Date().toISOString()} 402 trial-exhausted ${trial.key} age=${ageMonths}`);
    return;
  }
  trials.counts[trial.key] = used + 1;
  try {
    saveTrials();
  } catch (e) {
    console.error('Failed to persist trials.json:', e);
  }
  const remaining = FREE_TRIAL_LIMIT - trials.counts[trial.key];
  const freeBody = {
    ...base,
    trial: {
      type: trial.type,
      ...(trial.wallet ? { wallet: trial.wallet } : {}),
      used: trials.counts[trial.key],
      remaining,
      limit: FREE_TRIAL_LIMIT,
    },
  };
  sendJson(res, 200, freeBody);
  console.log(`${new Date().toISOString()} FREE ${pathname} age=${ageMonths} city=${city} care=${careType} ${trial.key} used=${trials.counts[trial.key]}`);
});

server.listen(PORT, () => {
  console.log(`childcare-subsidy x402 API listening on port ${PORT}`);
  console.log(`Facilitator: ${FACILITATOR_URL}`);
  if (IS_CDP_FACILITATOR) {
    console.log(CDP_AUTH_CONFIGURED
      ? 'Facilitator auth: CDP JWT enabled (CDP_API_KEY_ID set, secret present)'
      : 'WARNING: CDP facilitator configured but CDP_API_KEY_ID / CDP_API_KEY_SECRET are NOT set — paid verify/settle will fail');
  }
  console.log(`PayTo (Base USDC): ${PAY_TO}`);
  console.log(`Rules version: ${RULES.rules_version}`);
});
