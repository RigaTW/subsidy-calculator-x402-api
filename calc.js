// 台灣托育補助試算 — 純計算邏輯（無 HTTP、無付款邏輯）
// 資料來源：subsidy-rules-data.json（規則版本 2026-11-10，依據
// childcare-subsidy-rules.md）。規則表或草稿沒寫的金額，一律回
// 「未確認」或「未支援」，絕不猜數字。
//
// calculate(input, today) -> result
//   input: {
//     age_months,            // 整數 0-72（已驗證）
//     birthdate: 'YYYY-MM-DD' | null,   // 有傳才有
//     birthdateObj: Date | null,        // 解析後的出生日期（server 傳入）
//     city, care_type, birth_order,     // birth_order >= 1 整數
//     household: 'general'|'mid_low'|'low',
//     twins: 0 | 2 | 3 ...    // 多胞胎胎數，0 = 單胞胎
//     income_tax_rate: number | null,
//     actual_fee: number | null,
//     residence_months: number | null,
//   }
//   today: Date（預設當天；測試時可傳入固定日期，例如驗新竹生育津貼
//     116-01-01 生效日判斷）
//
// 年齡段：0–未滿 2 歲（0–23 個月）、2–未滿 3 歲（24–35，延長托育）、
// 2–未滿 5 歲（36–59）、5 歲至入國小前（60–71）。72 個月以上視為入國小年齡。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RULES = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'subsidy-rules-data.json'), 'utf8')
);

const CITIES = Object.keys(RULES.cities);
const CARE_TYPES = [
  'self', 'public', 'quasi_nanny', 'quasi_center',
  'kindergarten_public', 'kindergarten_nonprofit', 'kindergarten_quasi',
  'kindergarten_private',
];
const HOUSEHOLDS = ['general', 'mid_low', 'low'];
const KINDERGARTEN_LABELS = {
  kindergarten_public: '公立幼兒園',
  kindergarten_nonprofit: '非營利幼兒園',
  kindergarten_quasi: '準公共幼兒園',
  kindergarten_private: '私立幼兒園',
};

function tierOf(birthOrder) {
  return Math.min(birthOrder, 3);
}

function startOfToday(d) {
  const t = d || new Date();
  return new Date(t.getFullYear(), t.getMonth(), t.getDate());
}

function addMonths(date, n) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}

// 只有 age_months 時，出生日期只能推得一個區間：
// completedMonths(birth, today) = m 代表 birth 在
// (today - (m+1) 個月, today - m 個月] 之間。
function birthWindow(ageMonths, today) {
  const latest = addMonths(today, -ageMonths);
  const earliest = addMonths(addMonths(today, -(ageMonths + 1)), 0);
  earliest.setDate(earliest.getDate() + 1);
  return { earliest, latest };
}

function fmtDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ------------------------------------------------------------ birth subsidy
// 一次性生育津貼，單獨列出，不加進月領總額。設籍是否符合須用
// residence_months 另算；未提供時只能回備註，不能說符合。
function calcBirthSubsidy(p, today) {
  const city = p.city;
  const cityData = RULES.cities[city];
  const b = cityData.birth;
  const order = p.birth_order;
  const tier = tierOf(order);
  const twinCount = p.twins || 0;
  const birthDate = p.birthdateObj || null;
  const window = birthDate ? null : birthWindow(p.age_months, today);

  let amount = null;
  const notes = [];
  const unconfirmed = [];

  if (city === '台北市') {
    amount = b.amounts[String(tier)];
  } else if (city === '新北市') {
    // 依出生年份分表：115-01-01（含）以後出生一表，114 年出生另一表。
    // 規則表未載明 114 年以前出生的金額。
    let year = null;
    if (birthDate) {
      year = birthDate.getFullYear();
    } else if (window) {
      year = window.earliest.getFullYear() === window.latest.getFullYear()
        ? window.earliest.getFullYear()
        : null;
    }
    if (year === null) {
      unconfirmed.push({
        name: '生育津貼（新北市）',
        reason: '金額依出生年份不同（115-01-01 以後出生與 114 年出生各一表），未傳 birthdate 且以月齡推算的出生年份橫跨 115-01-01，無法判斷適用哪一表。115 年表：第 1 名 40,000 元、第 2 名 45,000 元、第 3 名以上 50,000 元；114 年表：30,000／40,000／50,000 元。',
      });
    } else if (year >= 2026) {
      amount = b.by_birth_year['2026'][String(tier)];
    } else if (year === 2025) {
      amount = b.by_birth_year['2025'][String(tier)];
    } else {
      unconfirmed.push({
        name: '生育津貼（新北市）',
        reason: `規則表只載明 114 年與 115 年出生的生育獎勵金，${year} 年出生的金額未載明，無法計算。`,
      });
    }
  } else if (city === '桃園市') {
    amount = b.amounts[String(tier)];
    if (twinCount > 0) {
      amount += b.twins_add_per_newborn;
      notes.push(`多胞胎：每名新生兒再加發 ${b.twins_add_per_newborn.toLocaleString('en-US')} 元`);
    }
  } else if (city === '台中市') {
    if (twinCount > 0) {
      amount = b.twins_flat_per_newborn;
      notes.push('雙胞胎以上：每胎皆補助 20,000 元');
    } else if (order >= 4) {
      amount = b.amounts['3'] + (order - 3) * b.extra_per_birth_order_above_3;
      notes.push(`第 4 名起每多 1 名加 ${b.extra_per_birth_order_above_3.toLocaleString('en-US')} 元`);
    } else {
      amount = b.amounts[String(tier)];
    }
  } else if (city === '台南市') {
    amount = b.amounts[String(Math.min(order, 5))];
    if (order >= 5) notes.push('第 5 名（含）以上各 50,000 元');
  } else if (city === '高雄市') {
    amount = b.flat_per_newborn;
    notes.push('每名新生兒 30,000 元，不分胎次');
  } else if (city === '新竹市') {
    // 115-11-06 修正版：每名 60,000 元，116-01-01（2027-01-01）才施行。
    // 以出生日期判斷適用哪一版；只有月齡時看推算區間是否橫跨生效日。
    const effFrom = new Date(b.amended.effective_from + 'T00:00:00');
    let regime = null;
    if (birthDate) {
      regime = birthDate >= effFrom ? 'amended' : 'current';
    } else if (window) {
      if (window.latest < effFrom) regime = 'current';
      else if (window.earliest >= effFrom) regime = 'amended';
      else regime = null;
    }
    if (regime === 'current') {
      if (twinCount >= 3) amount = b.current.triplets_plus;
      else if (twinCount === 2) amount = b.current.twins;
      else amount = b.current.per_birth;
      notes.push('現行每胎 30,000 元；雙胞胎 60,000 元；三胞胎以上或第二次以上雙胞胎 100,000 元');
    } else if (regime === 'amended') {
      amount = b.amended.per_newborn * Math.max(1, twinCount || 1);
      notes.push('115-11-06 修正版：每名 60,000 元，116-01-01 起施行；多胞胎合計金額規則表未明載，依每名計算');
    } else {
      unconfirmed.push({
        name: '生育津貼（新竹市）',
        reason: '金額於 116-01-01 由每胎 30,000 元改為每名 60,000 元，未傳 birthdate 且以月齡推算的出生區間橫跨 116-01-01，無法判斷適用哪一版。',
      });
    }
  }

  // 設籍是否符合：只看提供的月數；未提供只能回備註，不能說符合。
  // 併計規則無法只憑月數判斷，一律寫進備註。
  let residenceStatus;
  if (p.residence_months === null || p.residence_months === undefined) {
    residenceStatus = 'unknown';
    notes.push(`設籍要求：父母一方連續設籍滿 ${b.residence_months} 個月以上；未提供 residence_months，無法判斷是否符合。併計：${b.merge}`);
  } else if (p.residence_months >= b.residence_months) {
    residenceStatus = 'eligible';
    notes.push(`設籍要求：父母一方連續設籍滿 ${b.residence_months} 個月以上；提供 ${p.residence_months} 個月，符合月數要求。併計：${b.merge}`);
  } else {
    residenceStatus = 'not_eligible';
    notes.push(`設籍要求：父母一方連續設籍滿 ${b.residence_months} 個月以上；提供 ${p.residence_months} 個月，未達月數要求。併計：${b.merge}`);
  }

  // 申請期限：以目前月齡推算是否已逾。
  if (p.age_months > b.deadline_months) {
    notes.push(`申請期限：${b.deadline}；以目前月齡推算可能已逾申請期限`);
  } else {
    notes.push(`申請期限：${b.deadline}`);
  }

  return {
    name: `${city}生育津貼（一次性）`,
    amount,
    residence_required_months: b.residence_months,
    residence_status: residenceStatus,
    note: notes.join('；'),
    unconfirmed,
  };
}

// ------------------------------------------------------------------ monthly
function calcMonthly(p, today) {
  const age = p.age_months;
  const city = p.city;
  const care = p.care_type;
  const tier = tierOf(p.birth_order);
  const household = p.household;
  const twinCount = p.twins || 0;
  const cityData = RULES.cities[city];
  const items = [];
  const notes = [];
  const unconfirmed = [];
  const notEligible = [];
  const alternatives = [];

  const householdAdd = RULES.central.household_add[household] || 0;
  const householdLabel = household === 'mid_low'
    ? '中低收入戶加發'
    : household === 'low' ? '低收入戶及弱勢家庭加發' : null;

  // 72 個月以上：入國小年齡，無對應補助。
  if (age >= 72) {
    notEligible.push({
      name: '育兒津貼／托育補助／就學補助',
      reason: '已滿 6 歲，入國小年齡，無對應補助項目',
    });
    return { items, total: null, self_pay: null, capped_by_actual_fee: null, notes, unconfirmed, notEligible, alternatives, monthly: null };
  }

  // ---- 自己帶或親屬帶：育兒津貼（中央）＋縣市育兒津貼加碼 ----
  if (care === 'self') {
    if (age >= 60) {
      notEligible.push({
        name: '育兒津貼',
        reason: '已滿 5 歲，育兒津貼僅發至未滿 5 歲；未就讀幼兒園者無就學補助',
      });
      notEligible.push({ name: '托育補助', reason: '未送托公共化或準公共托育' });
      return { items, total: null, self_pay: null, capped_by_actual_fee: null, notes, unconfirmed, notEligible, alternatives, monthly: null };
    }
    items.push({ name: '育兒津貼（中央）', amount: RULES.central.allowance[String(tier)] });
    if (city === '新竹市' && age >= 24) {
      items.push({ name: '新竹市育兒津貼加碼（115 年 3 月起）', amount: cityData.allowance_add });
    }
    notEligible.push({
      name: '托育補助',
      reason: '未送托公共化或準公共托育；同一名孩子同一段時間不能同時領育兒津貼與托育補助',
    });
    const total = items.reduce((s, i) => s + i.amount, 0);
    return { items, total, self_pay: null, capped_by_actual_fee: null, notes, unconfirmed, notEligible, alternatives, monthly: { items, total } };
  }

  // ---- 就讀幼兒園：就學補助（家長月繳上限）----
  if (care.startsWith('kindergarten_')) {
    if (age < 24) {
      notEligible.push({
        name: '就學補助',
        reason: '就學補助適用 2 歲以上就讀幼兒園者；未滿 2 歲無對應補助項目',
      });
      return { items, total: null, self_pay: null, capped_by_actual_fee: null, notes, unconfirmed, notEligible, alternatives, monthly: null };
    }
    if (care === 'kindergarten_private') {
      if (age < 60) {
        // 私立幼兒園不適用就學補助，改領育兒津貼（2 至未滿 5 歲教育部版）。
        items.push({ name: '育兒津貼（中央・2 至未滿 5 歲）', amount: RULES.central.allowance[String(tier)] });
        if (city === '新竹市') {
          items.push({ name: '新竹市育兒津貼加碼（115 年 3 月起）', amount: cityData.allowance_add });
        }
        notEligible.push({
          name: '就學補助',
          reason: '私立幼兒園不適用就學補助，改領育兒津貼',
        });
        const total = items.reduce((s, i) => s + i.amount, 0);
        return { items, total, self_pay: null, capped_by_actual_fee: null, notes, unconfirmed, notEligible, alternatives, monthly: { items, total } };
      }
      // 5 歲至入國小前就讀一般私立幼兒園適用就學補助，但規則表未載明金額。
      unconfirmed.push({
        name: '就學補助（5 歲至入國小前・一般私立幼兒園）',
        reason: '規則表僅載明 5 歲至入國小前就讀一般私立幼兒園適用就學補助，未載明金額，無法計算。',
      });
      return { items, total: null, self_pay: null, capped_by_actual_fee: null, notes, unconfirmed, notEligible, alternatives, monthly: null };
    }
    // 公立／非營利／準公共幼兒園：家長月繳上限。
    const kindKey = care === 'kindergarten_public' ? 'public'
      : care === 'kindergarten_nonprofit' ? 'nonprofit' : 'quasi';
    let cap = RULES.central.kindergarten_cap[kindKey][String(tier)];
    if (household === 'mid_low' || household === 'low') cap = 0;
    items.push({
      name: `就學補助（${KINDERGARTEN_LABELS[care]}家長月繳上限）`,
      amount: cap,
      kind: 'parent_payment_cap',
    });
    if (household === 'mid_low' || household === 'low') {
      notes.push('低收入戶及中低收入戶就讀公立、非營利或準公共幼兒園，學費全免');
    }
    notes.push('此為家長每月繳費上限，非領取金額');
    notEligible.push({
      name: '育兒津貼',
      reason: '2 歲以上就讀公立、非營利、準公共幼兒園者改領就學補助，不再領育兒津貼',
    });
    const total = cap;
    const selfPay = p.actual_fee !== null && p.actual_fee !== undefined
      ? Math.min(cap, p.actual_fee)
      : cap;
    return { items, total, self_pay: selfPay, capped_by_actual_fee: null, notes, unconfirmed, notEligible, alternatives, monthly: { items, total, self_pay: selfPay } };
  }

  // ---- 送托（公共化／準公共）：托育補助 ----
  if (age >= 36) {
    notEligible.push({
      name: '托育補助',
      reason: '托育補助僅至未滿 3 歲（含 2–3 歲延長）；3 歲以上送托公共化或準公共托育無對應補助項目',
    });
    return { items, total: null, self_pay: null, capped_by_actual_fee: null, notes, unconfirmed, notEligible, alternatives, monthly: null };
  }
  if (age >= 24 && !RULES.extension_confirmed[city]) {
    // 第 12 項部分確認：這四市的 2–3 歲延長程序未確認，不得推定與中央相同。
    unconfirmed.push({
      name: '托育補助（2–3 歲延長）',
      reason: `${city}的 2–3 歲延長程序未確認（未找到官方明文），不得推定與中央相同，請洽縣市社會局。中央規則：滿 2 歲未滿 3 歲續留原公共化或準公共合作對象者延長至滿 3 歲生日前一日，總額不變。`,
    });
    return { items, total: null, self_pay: null, capped_by_actual_fee: null, notes, unconfirmed, notEligible, alternatives, monthly: null };
  }

  const isPublic = care === 'public';
  const baseKey = isPublic ? 'public' : 'quasi';
  const baseName = isPublic ? '托育補助（中央・公共化）' : '托育補助（中央・準公共）';
  items.push({ name: baseName, amount: RULES.central.subsidy[baseKey][String(tier)] });
  if (householdAdd > 0) {
    items.push({ name: householdLabel, amount: householdAdd });
  }
  notEligible.push({
    name: '育兒津貼',
    reason: '已送托公共化或準公共托育，同一名孩子同一段時間不能同時領育兒津貼',
  });
  if (age >= 24) {
    notes.push('2–3 歲延長：費用由教育部 2 歲至未滿 5 歲育兒津貼與衛福部托育補助差額共同支付，家長每月受補助總額不變');
  }

  // 縣市加碼。
  let subtotal = null;

  if (city === '台北市') {
    if (isPublic) {
      // care_type=public 未區分公辦民營托嬰中心與社區公共托育家園，兩者加碼不同。
      unconfirmed.push({
        name: '臺北市友善托育補助加碼（公共化）',
        reason: 'care_type=public 未區分公辦民營托嬰中心（第 1 名 2,500 元、第 2 名以上 3,000 元）與社區公共托育家園（第 1 名 6,000 元、第 2 名以上 8,000 元），無法擇一計入總額；下方總額僅含中央補助。',
      });
    } else if (tier === 1) {
      items.push({ name: '臺北市友善托育補助加碼（準公共）', amount: cityData.friendly.quasi['1'] });
    } else {
      items.push({ name: '臺北市友善托育補助加碼（準公共・第 2 名以上）', amount: cityData.friendly.quasi['2'] });
      notes.push('計畫第七點：準公共加碼最高 8,000 元，有其他兄姊者加發 2,000 元，合計上限 10,000 元；實際收費低於補助總額者依實際繳交費用補助。市府稱第二胎以上全面免負擔，但計畫原文給的是上限 10,000 元，非無上限。');
    }
    // 協力照顧是獨立計畫，不疊加，只列為替代選項。
    alternatives.push({
      name: '臺北市協力照顧補助（獨立計畫）',
      note: cityData.cooperative_care.note,
      tiers: cityData.cooperative_care.tiers,
    });
  } else if (city === '新北市') {
    if (care === 'quasi_center') {
      items.push({ name: '新北市公共托育合作聯盟增額補助（私立托嬰中心）', amount: cityData.alliance.center });
      notes.push(cityData.alliance.note);
    } else if (care === 'quasi_nanny') {
      items.push({ name: '新北市公共托育合作聯盟增額補助（居家托育人員）', amount: cityData.alliance.nanny });
      notes.push(cityData.alliance.note);
    }
  } else if (city === '桃園市') {
    if (care === 'quasi_nanny') {
      items.push({ name: '桃園市友善托育補助 2.0 加碼（準公共居家托育人員）', amount: cityData.quasi_nanny });
    } else if (care === 'quasi_center') {
      items.push({ name: '桃園市友善托育補助 2.0 加碼（準公共托嬰中心）', amount: cityData.quasi_center });
    }
    if ((household === 'low' || household === 'mid_low') && twinCount === 0) {
      notes.push(cityData.vulnerable_note + '；上方金額未計入增額，請洽婦幼局確認。');
    }
  } else if (city === '台中市') {
    if (care === 'quasi_center') {
      if (p.income_tax_rate === null || p.income_tax_rate === undefined) {
        notes.push('台中市平價托育加碼（準公共托嬰中心每月 1,400 元）須父母綜合所得稅率未達 20%，未提供 income_tax_rate，無法確認是否符合，未計入總額。');
      } else if (p.income_tax_rate < 20) {
        items.push({ name: '台中市平價托育加碼（準公共托嬰中心）', amount: cityData.quasi_center });
        notes.push(cityData.quasi_center_conditions);
      } else {
        notes.push('台中市平價托育加碼須父母綜合所得稅率未達 20%，提供稅率已達 20%，不符加碼資格。');
      }
    } else if (care === 'quasi_nanny') {
      notes.push('台中市平價托育加碼僅適用準公共托嬰中心，不適用準公共保母。');
    }
  } else if (city === '高雄市') {
    if (care === 'quasi_center') {
      items.push({ name: '高雄市加碼準公共托育補助（準公共托嬰中心）', amount: cityData.quasi_center });
    } else if (care === 'quasi_nanny') {
      // 日間與全日金額不同，API 未區分，無法擇一計入總額。
      unconfirmed.push({
        name: '高雄市加碼準公共托育補助（準公共居家托育人員）',
        reason: '日間托育每月 1,600 元、全日托育每月 1,840 元，API 未區分日間／全日，無法擇一計入總額；下方總額僅含中央補助。',
      });
    }
  } else if (city === '新竹市') {
    if (care === 'quasi_nanny' || care === 'quasi_center') {
      items.push({ name: '新竹市托育補助加碼（準公共托育服務提供者）', amount: cityData.quasi });
    } else if (isPublic) {
      items.push({ name: '新竹市托育補助加碼（社區公共托育家園或公共托嬰中心）', amount: cityData.public });
    }
    notes.push('新竹市托育加碼期限至滿 3 歲前一日止');
  }
  // 台南市：無中央以外地方加碼。

  // 桃園雙胞胎優惠：改以自付額計算（只適用準公共托嬰中心，規則表明確給數字的情形）。
  if (city === '桃園市' && twinCount > 0 && care === 'quasi_center') {
    const selfPay = cityData.twins_self_pay.quasi_center[String(tier)];
    subtotal = items.reduce((s, i) => s + (typeof i.amount === 'number' ? i.amount : 0), 0);
    notes.push('桃園市雙胞胎優惠（115-02-01 起）：家長負擔比照公托，第 1 名自付 2,000 元、第 2 名 1,000 元，第 3 名以上全額補助；上方分項為未計優惠的標準金額，總額已改以自付額計算。');
    if (p.actual_fee !== null && p.actual_fee !== undefined) {
      return {
        items, total: p.actual_fee - selfPay, self_pay: selfPay,
        capped_by_actual_fee: null, notes, unconfirmed, notEligible, alternatives,
        monthly: { items, subtotal, total: p.actual_fee - selfPay, self_pay: selfPay },
      };
    }
    return {
      items, total: null, self_pay: selfPay,
      capped_by_actual_fee: null, notes, unconfirmed, notEligible, alternatives,
      monthly: { items, subtotal, total: null, self_pay: selfPay },
    };
  }
  if (city === '桃園市' && twinCount > 0 && care === 'quasi_nanny') {
    notes.push('桃園市雙胞胎優惠：家長負擔比照公托；準公共保母的雙胞胎自付額規則表未明載數字，上方金額未計入優惠，請洽婦幼局確認。');
  }

  // 一般情形：分項加總，核實上限為實際費用。
  subtotal = items.reduce((s, i) => s + (typeof i.amount === 'number' ? i.amount : 0), 0);
  let total = subtotal;
  let cappedBy = null;
  let selfPay = null;
  if (p.actual_fee !== null && p.actual_fee !== undefined) {
    if (total > p.actual_fee) {
      cappedBy = p.actual_fee;
      total = p.actual_fee;
    }
    selfPay = p.actual_fee - total;
  } else {
    notes.push('補助金額為上限，實際以繳費為準（核實補助：實際支付費用低於補助金額時，按實際費用核實）。');
  }
  return {
    items, total, self_pay: selfPay, capped_by_actual_fee: cappedBy,
    notes, unconfirmed, notEligible, alternatives,
    monthly: {
      items, subtotal, total, self_pay: selfPay,
      ...(cappedBy !== null ? { capped_by_actual_fee: cappedBy } : {}),
    },
  };
}

// ------------------------------------------------------------------ main ----
function calculate(input, todayArg) {
  const today = startOfToday(todayArg || new Date());
  const p = {
    age_months: input.age_months,
    birthdate: input.birthdate || null,
    birthdateObj: input.birthdateObj || null,
    city: input.city,
    care_type: input.care_type,
    birth_order: input.birth_order || 1,
    household: input.household || 'general',
    twins: typeof input.twins === 'number' ? input.twins : (input.twins ? 2 : 0),
    income_tax_rate: input.income_tax_rate ?? null,
    actual_fee: input.actual_fee ?? null,
    residence_months: input.residence_months ?? null,
  };

  const result = {
    age_months: p.age_months,
    ...(p.birthdate ? { birthdate: p.birthdate } : {}),
    city: p.city,
    care_type: p.care_type,
    birth_order: p.birth_order,
    household: p.household,
    twins: p.twins,
    monthly: null,
    unconfirmed: [],
    alternatives: [],
    not_eligible: [],
    birth_subsidy: null,
    rules_version: RULES.rules_version,
    source: RULES.source,
    disclaimer: RULES.disclaimer,
  };

  if (!CITIES.includes(p.city)) {
    return {
      ...result,
      unsupported: true,
      message: `本 API 目前僅支援七市（台北市、新北市、桃園市、台中市、台南市、高雄市、新竹市），${p.city}尚未支援。`,
    };
  }

  const birth = calcBirthSubsidy(p, today);
  result.birth_subsidy = {
    name: birth.name,
    amount: birth.amount,
    residence_required_months: birth.residence_required_months,
    residence_status: birth.residence_status,
    note: birth.note,
  };
  result.unconfirmed.push(...birth.unconfirmed);

  const m = calcMonthly(p, today);
  result.monthly = m.monthly;
  if (m.monthly && m.notes.length) result.monthly.notes = m.notes;
  result.unconfirmed.push(...m.unconfirmed);
  result.alternatives.push(...m.alternatives);
  result.not_eligible.push(...m.notEligible);
  if (m.monthly === null && m.items.length === 0 && result.unconfirmed.length === 0 && result.not_eligible.length === 0) {
    result.monthly = null;
  }

  return result;
}

module.exports = {
  RULES,
  CITIES,
  CARE_TYPES,
  HOUSEHOLDS,
  calculate,
  calcMonthly,
  calcBirthSubsidy,
  birthWindow,
  tierOf,
};
