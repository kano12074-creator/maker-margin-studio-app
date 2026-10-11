/*
 * Maker Margin Studio — 計算ロジック（DOM 非依存）
 *
 * ブラウザでは window.MarginCalc、Node.js では module.exports として使う。
 * 内部計算は丸めずに倍精度で行い、表示・CSV 出力の直前でのみ丸める。
 * 計算式の詳細は README.md「計算式と前提条件」を参照。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MarginCalc = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- 入力の上限値（極端な値の検証用） ---------------------------------
  var LIMITS = {
    money: 1e9,        // 金額（円）の上限
    quantity: 1e7,     // 製造数量・使用量・資材数量の上限
    hours: 1e5,        // 作業時間（h）の上限
  };

  var CHANNELS = { direct: '直販', wholesale: '卸売', other: 'その他' };
  var COMMISSION_BASES = { excl: '税抜販売価格', incl: '税込販売価格' };
  var LABOR_TYPES = { variable: '変動費', fixed: '固定費' };

  // 注意表示の初期基準。業界標準値ではなく、このツールの初期設定値。
  var DEFAULT_THRESHOLDS = { lossRate: '10', packagingShare: '30', grossMargin: '30' };

  // ---- 架空のサンプルデータ（実在の企業・商品とは無関係） -----------------
  var SAMPLE = {
    product: { name: 'サンプル焼き菓子 バターサブレ 8枚入', quantity: '100', price: '1200', channel: 'direct' },
    materials: [
      { name: '薄力粉', usage: '4000', unit: 'g', unitPrice: '0.4', lossRate: '5' },
      { name: '無塩バター', usage: '2000', unit: 'g', unitPrice: '2', lossRate: '2' },
      { name: 'グラニュー糖', usage: '1500', unit: 'g', unitPrice: '0.3', lossRate: '0' },
      { name: '全卵', usage: '600', unit: 'g', unitPrice: '0.6', lossRate: '10' },
    ],
    packaging: [
      { name: '化粧箱', qtyPerUnit: '1', unitPrice: '45' },
      { name: '個包装袋', qtyPerUnit: '8', unitPrice: '3' },
      { name: '商品ラベル', qtyPerUnit: '1', unitPrice: '8' },
      { name: '封緘シール', qtyPerUnit: '1', unitPrice: '3' },
    ],
    labor: { hours: '6', wage: '1100', laborType: 'variable' },
    overhead: { variableLot: '1500', fixedLot: '2000' },
    sales: { commissionRate: '10', commissionBase: 'excl', taxRate: '8', shipping: '150', other: '20' },
    fixed: { periodFixed: '200000' },
    scenarios: ['1080', '1300'],
    thresholds: { lossRate: '10', packagingShare: '30', grossMargin: '30' },
  };

  // ---- 数値の解析 -------------------------------------------------------

  /**
   * 文字列を数値に変換する。全角数字・全角記号・桁区切りカンマを許容する。
   * 戻り値: { empty: true } | { ok: true, value } | { ok: false, reason: 'nan' }
   */
  function parseNumber(raw) {
    if (raw === null || raw === undefined) return { empty: true };
    if (typeof raw === 'number') {
      return Number.isFinite(raw) ? { ok: true, value: raw } : { ok: false, reason: 'nan' };
    }
    var s = String(raw)
      .replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xfee0); })
      .replace(/[．。]/g, '.')
      .replace(/[－−ー‐]/g, '-')
      .replace(/[，,]/g, '')
      .replace(/[\s　]/g, '');
    if (s === '') return { empty: true };
    if (!/^-?(\d+(\.\d*)?|\.\d+)$/.test(s)) return { ok: false, reason: 'nan' };
    var v = Number(s);
    if (!Number.isFinite(v)) return { ok: false, reason: 'nan' };
    return { ok: true, value: v };
  }

  /**
   * フィールドを検証して数値を返す。エラーは errors 配列に追加する。
   * opts: { required, min, minExclusive, max, maxExclusive, integer, defaultValue }
   */
  function readField(raw, field, label, opts, errors) {
    var p = parseNumber(raw);
    if (p.empty) {
      if (opts.required) {
        errors.push({ field: field, message: label + 'を入力してください。' });
        return null;
      }
      return opts.defaultValue === undefined ? 0 : opts.defaultValue;
    }
    if (!p.ok) {
      errors.push({ field: field, message: label + 'は数値で入力してください。' });
      return null;
    }
    var v = p.value;
    if (v < 0 && (opts.min === undefined || opts.min >= 0)) {
      errors.push({ field: field, message: label + 'に負の値は入力できません。' });
      return null;
    }
    if (opts.minExclusive !== undefined && !(v > opts.minExclusive)) {
      errors.push({ field: field, message: label + 'は' + opts.minExclusive + 'より大きい値を入力してください。' });
      return null;
    }
    if (opts.min !== undefined && v < opts.min) {
      errors.push({ field: field, message: label + 'は' + opts.min + '以上を入力してください。' });
      return null;
    }
    if (opts.maxExclusive !== undefined && !(v < opts.maxExclusive)) {
      errors.push({ field: field, message: label + 'は' + opts.maxExclusive + '未満を入力してください。' });
      return null;
    }
    if (opts.max !== undefined && v > opts.max) {
      errors.push({ field: field, message: label + 'が大きすぎます（上限 ' + opts.max.toLocaleString('ja-JP') + '）。' });
      return null;
    }
    if (opts.integer && !Number.isInteger(v)) {
      errors.push({ field: field, message: label + 'は整数で入力してください。' });
      return null;
    }
    return v;
  }

  function isBlank(v) {
    return v === undefined || v === null || String(v).replace(/[\s　]/g, '') === '';
  }

  function str(v) {
    return v === undefined || v === null ? '' : String(v).trim();
  }

  // ---- 入力の検証 -------------------------------------------------------

  /**
   * 画面の生入力（文字列）を検証し、計算用の数値に変換する。
   * 戻り値: { ok, values, errors }
   *   errors: [{ field, message }]  field は画面の入力要素 id と対応する
   */
  function validate(input) {
    var errors = [];
    var M = LIMITS.money;
    var p = input.product || {};
    var values = {};

    var name = str(p.name);
    if (name === '') errors.push({ field: 'product-name', message: '商品名を入力してください。' });
    if (name.length > 100) errors.push({ field: 'product-name', message: '商品名は100文字以内で入力してください。' });
    var channel = CHANNELS[p.channel] ? p.channel : 'direct';
    values.product = {
      name: name,
      quantity: readField(p.quantity, 'product-quantity', '製造数量', { required: true, min: 1, max: LIMITS.quantity, integer: true }, errors),
      price: readField(p.price, 'product-price', '販売価格（税抜）', { required: true, minExclusive: 0, max: M }, errors),
      channel: channel,
      channelLabel: CHANNELS[channel],
    };

    // 材料：単位以外がすべて空欄の行は無視する（追加直後の行で結果が消えないように）
    values.materials = [];
    (input.materials || []).forEach(function (m, i) {
      if (isBlank(m.name) && isBlank(m.usage) && isBlank(m.unitPrice) && isBlank(m.lossRate)) return;
      var n = i + 1;
      var label = '材料' + n + '（' + (str(m.name) || '名称未入力') + '）の';
      values.materials.push({
        index: i,
        name: str(m.name) || '材料' + n,
        unit: str(m.unit),
        usage: readField(m.usage, 'mat-' + i + '-usage', label + '使用量', { required: true, min: 0, max: LIMITS.quantity }, errors),
        unitPrice: readField(m.unitPrice, 'mat-' + i + '-unitPrice', label + '単価', { required: true, min: 0, max: M }, errors),
        lossRate: readField(m.lossRate, 'mat-' + i + '-lossRate', label + 'ロス率', { min: 0, maxExclusive: 100 }, errors),
      });
    });

    values.packaging = [];
    (input.packaging || []).forEach(function (k, i) {
      if (isBlank(k.name) && isBlank(k.qtyPerUnit) && isBlank(k.unitPrice)) return;
      var n = i + 1;
      var label = '包装資材' + n + '（' + (str(k.name) || '名称未入力') + '）の';
      values.packaging.push({
        index: i,
        name: str(k.name) || '包装資材' + n,
        qtyPerUnit: readField(k.qtyPerUnit, 'pkg-' + i + '-qtyPerUnit', label + '数量', { required: true, min: 0, max: LIMITS.quantity }, errors),
        unitPrice: readField(k.unitPrice, 'pkg-' + i + '-unitPrice', label + '単価', { required: true, min: 0, max: M }, errors),
      });
    });

    var l = input.labor || {};
    values.labor = {
      hours: readField(l.hours, 'labor-hours', '製造作業時間', { min: 0, max: LIMITS.hours }, errors),
      wage: readField(l.wage, 'labor-wage', '1時間あたりの人件費', { min: 0, max: M }, errors),
      laborType: LABOR_TYPES[l.laborType] ? l.laborType : 'variable',
    };

    var o = input.overhead || {};
    values.overhead = {
      variableLot: readField(o.variableLot, 'overhead-variable', '変動製造経費', { min: 0, max: M }, errors),
      fixedLot: readField(o.fixedLot, 'overhead-fixed', '固定製造経費（配賦額）', { min: 0, max: M }, errors),
    };

    var s = input.sales || {};
    var base = COMMISSION_BASES[s.commissionBase] ? s.commissionBase : 'excl';
    values.sales = {
      commissionRate: readField(s.commissionRate, 'sales-commission', '販売手数料率', { min: 0, maxExclusive: 100 }, errors),
      commissionBase: base,
      taxRate: base === 'incl'
        ? readField(s.taxRate, 'sales-tax', '消費税率', { required: true, min: 0, max: 100 }, errors)
        : (parseNumber(s.taxRate).ok ? parseNumber(s.taxRate).value : 0),
      shipping: readField(s.shipping, 'sales-shipping', '送料負担額', { min: 0, max: M }, errors),
      other: readField(s.other, 'sales-other', 'その他の販売関連変動費', { min: 0, max: M }, errors),
    };

    var f = input.fixed || {};
    values.fixed = {
      // 空欄は「未入力」として null を保持し、0 と区別する
      periodFixed: isBlank(f.periodFixed)
        ? null
        : readField(f.periodFixed, 'fixed-period', '期間固定費', { min: 0, max: M * 100 }, errors),
      entered: !isBlank(f.periodFixed),
    };

    values.scenarios = [];
    (input.scenarios || []).forEach(function (sc, i) {
      if (isBlank(sc)) return;
      var v = readField(sc, 'scenario-' + i, '比較価格' + (i + 1), { required: true, minExclusive: 0, max: M }, errors);
      values.scenarios.push({ index: i, price: v });
    });

    var t = input.thresholds || {};
    var dt = DEFAULT_THRESHOLDS;
    values.thresholds = {
      lossRate: readField(isBlank(t.lossRate) ? dt.lossRate : t.lossRate, 'th-loss', '注意基準（ロス率）', { min: 0, max: 100 }, errors),
      packagingShare: readField(isBlank(t.packagingShare) ? dt.packagingShare : t.packagingShare, 'th-packaging', '注意基準（包装資材費の割合）', { min: 0, max: 100 }, errors),
      grossMargin: readField(isBlank(t.grossMargin) ? dt.grossMargin : t.grossMargin, 'th-gross', '注意基準（粗利率）', { min: 0, max: 100 }, errors),
    };

    return { ok: errors.length === 0, values: values, errors: errors };
  }

  // ---- 計算 -------------------------------------------------------------

  var EPS = 1e-9;

  /** 販売関連変動費（1個あたり）。手数料は価格に連動するため価格を引数に取る。 */
  function salesCostsFor(price, sales) {
    var base = sales.commissionBase === 'incl' ? price * (1 + sales.taxRate / 100) : price;
    var commission = base * sales.commissionRate / 100;
    return {
      commissionBaseAmount: base,
      commission: commission,
      shipping: sales.shipping,
      other: sales.other,
      total: commission + sales.shipping + sales.other,
    };
  }

  /** 損益分岐点販売数量。計算できない場合は reason を返す。 */
  function breakEven(fixedCost, marginalProfit, price) {
    if (fixedCost === null || fixedCost === undefined) {
      return { available: false, reason: 'no-fixed' };
    }
    if (!(marginalProfit > EPS)) {
      return { available: false, reason: 'non-positive-margin' };
    }
    var exact = fixedCost / marginalProfit;
    // 浮動小数点誤差で 100.0000000001 → 101 とならないよう許容誤差を引いて切り上げる
    var units = Math.max(0, Math.ceil(exact - 1e-7));
    return { available: true, exactUnits: exact, units: units, sales: units * price };
  }

  /** 検証済みの値から計算結果を作る。validate() が ok の値のみ渡すこと。 */
  function compute(v) {
    var qty = v.product.quantity;
    var price = v.product.price;

    // 材料費：必要な良品量（使用量）÷ 良品率（1 − ロス率）＝ 投入量
    var materials = v.materials.map(function (m) {
      var yieldRate = 1 - m.lossRate / 100;
      var inputQty = m.usage / yieldRate;
      var cost = inputQty * m.unitPrice;
      return {
        name: m.name, unit: m.unit, usage: m.usage, unitPrice: m.unitPrice, lossRate: m.lossRate,
        yieldRate: yieldRate, inputQty: inputQty, lossQty: inputQty - m.usage,
        costLot: cost, lossCostLot: (inputQty - m.usage) * m.unitPrice, costUnit: cost / qty,
      };
    });
    var materialsLot = sum(materials, 'costLot');

    var packaging = v.packaging.map(function (k) {
      var unitCost = k.qtyPerUnit * k.unitPrice;
      return { name: k.name, qtyPerUnit: k.qtyPerUnit, unitPrice: k.unitPrice, costUnit: unitCost, costLot: unitCost * qty };
    });
    var packagingUnit = sum(packaging, 'costUnit');
    var packagingLot = packagingUnit * qty;

    var laborLot = v.labor.hours * v.labor.wage;
    var varOverheadLot = v.overhead.variableLot;
    var fixedOverheadLot = v.overhead.fixedLot;

    var mfgLot = materialsLot + packagingLot + laborLot + varOverheadLot + fixedOverheadLot;
    var mfgUnit = mfgLot / qty;

    var breakdown = [
      { key: 'materials', label: '材料費', lot: materialsLot, behavior: 'variable' },
      { key: 'packaging', label: '包装資材費', lot: packagingLot, behavior: 'variable' },
      { key: 'labor', label: '製造人件費', lot: laborLot, behavior: v.labor.laborType },
      { key: 'varOverhead', label: '変動製造経費', lot: varOverheadLot, behavior: 'variable' },
      { key: 'fixedOverhead', label: '固定製造経費（配賦）', lot: fixedOverheadLot, behavior: 'fixed' },
    ].map(function (b) {
      b.unit = b.lot / qty;
      b.share = mfgLot > 0 ? b.lot / mfgLot : 0;
      return b;
    });

    var variableMfgUnit = breakdown.reduce(function (a, b) { return a + (b.behavior === 'variable' ? b.unit : 0); }, 0);
    var fixedMfgUnit = mfgUnit - variableMfgUnit;

    var main = scenario(price, v, mfgUnit, variableMfgUnit);
    var scenarios = v.scenarios.map(function (s) {
      var r = scenario(s.price, v, mfgUnit, variableMfgUnit);
      r.diffGross = r.grossProfit - main.grossProfit;
      r.diffMarginal = r.marginalProfit - main.marginalProfit;
      return r;
    });

    return {
      quantity: qty,
      materials: materials,
      packaging: packaging,
      materialsLot: materialsLot,
      materialsUnit: materialsLot / qty,
      packagingLot: packagingLot,
      packagingUnit: packagingUnit,
      laborLot: laborLot,
      laborUnit: laborLot / qty,
      varOverheadLot: varOverheadLot,
      fixedOverheadLot: fixedOverheadLot,
      overheadLot: varOverheadLot + fixedOverheadLot,
      overheadUnit: (varOverheadLot + fixedOverheadLot) / qty,
      mfgLot: mfgLot,
      mfgUnit: mfgUnit,
      breakdown: breakdown,
      variableMfgUnit: variableMfgUnit,
      fixedMfgUnit: fixedMfgUnit,
      main: main,
      scenarios: scenarios,
    };
  }

  function scenario(price, v, mfgUnit, variableMfgUnit) {
    var sales = salesCostsFor(price, v.sales);
    var gross = price - mfgUnit;
    var variableUnit = variableMfgUnit + sales.total;
    var marginal = price - variableUnit;
    return {
      price: price,
      mfgUnit: mfgUnit,
      grossProfit: gross,
      grossMargin: gross / price,
      sales: sales,
      variableUnit: variableUnit,
      marginalProfit: marginal,
      marginalRatio: marginal / price,
      breakEven: breakEven(v.fixed.periodFixed, marginal, price),
    };
  }

  function sum(arr, key) {
    return arr.reduce(function (a, x) { return a + x[key]; }, 0);
  }

  // ---- 注意点・改善チェックリスト ---------------------------------------

  /**
   * 入力条件に応じた確認事項を返す。level: 'error' | 'warn' | 'info'
   * 基準値は利用者が画面で設定した値であり、業界標準値ではない。
   */
  function buildChecklist(v, r) {
    var items = [];
    var t = v.thresholds;
    var m = r.main;

    if (v.materials.length === 0) {
      items.push({ level: 'warn', title: '材料が登録されていません', body: '材料費が0円として計算されています。材料を追加してください。' });
    }

    if (!(m.marginalProfit > EPS)) {
      items.push({
        level: 'error',
        title: '限界利益が0以下です',
        body: '現在の条件では、1個売るごとに変動費を回収できていません。販売数量を増やしても固定費を回収できない可能性があります。販売価格・変動費・販売手数料を確認してください。損益分岐点は計算していません。',
      });
    }

    if (m.grossProfit < 0) {
      items.push({ level: 'error', title: '粗利がマイナスです', body: '税抜販売価格が1個あたり製造原価を下回っています。販売価格と原価構成を確認してください。' });
    } else if (m.grossMargin * 100 < t.grossMargin) {
      items.push({
        level: 'warn',
        title: '粗利率が設定基準（' + t.grossMargin + '%）を下回っています',
        body: '販売価格、原価構成（材料・包装・人件費）、販売手数料の条件を確認してください。',
      });
    }

    var highLoss = r.materials.filter(function (x) { return x.lossRate >= t.lossRate && x.lossRate > 0; });
    if (highLoss.length) {
      items.push({
        level: 'warn',
        title: 'ロス率が設定基準（' + t.lossRate + '%）以上の材料があります',
        body: highLoss.map(function (x) { return x.name + '（' + round(x.lossRate, 1) + '%）'; }).join('、') +
          '。ロスの測定方法（計量のタイミング、廃棄・付着・試作分の扱い）と歩留まりを確認してください。',
      });
    }

    var pkgShare = r.mfgLot > 0 ? (r.packagingLot / r.mfgLot) * 100 : 0;
    if (r.packagingLot > 0 && pkgShare >= t.packagingShare) {
      items.push({
        level: 'warn',
        title: '包装資材費の割合が設定基準（' + t.packagingShare + '%）以上です',
        body: '製造原価に占める包装資材費は ' + round(pkgShare, 1) + '% です。資材仕様、発注単位、仕入先の見積を比較してください。',
      });
    }

    if (v.labor.hours > 0 && v.labor.wage === 0) {
      items.push({ level: 'warn', title: '人件費単価が0円です', body: '作業時間が入力されていますが、1時間あたりの人件費が0円です。自身の作業時間も原価に含めるか確認してください。' });
    }

    if (!v.fixed.entered) {
      items.push({ level: 'info', title: '期間固定費が未入力です', body: '損益分岐点販売数量は計算できません。家賃・設備費・固定給など、期間中に販売数量と関係なく発生する費用を入力すると計算されます。' });
    } else if (m.breakEven.available && m.breakEven.units > 0) {
      items.push({
        level: 'info',
        title: '損益分岐点の前提',
        body: '期間固定費 ' + fmtYen(v.fixed.periodFixed, 0) + ' を、1個あたり限界利益で回収する数量です。固定費に区分した人件費・製造経費をこの期間固定費に含めているか確認してください。',
      });
    }

    if (v.sales.commissionRate > 0) {
      items.push({
        level: 'info',
        title: '販売手数料の計算対象',
        body: '手数料率 ' + round(v.sales.commissionRate, 2) + '% を「' + COMMISSION_BASES[v.sales.commissionBase] + '」に適用しています。契約上の計算対象（税込／税抜、送料を含むか等）と一致しているか確認してください。',
      });
    }

    return items;
  }

  // ---- 丸め・表示 -------------------------------------------------------

  /** 四捨五入（負数は絶対値で丸める）。浮動小数点の 1.005 問題を避ける。 */
  function round(x, digits) {
    if (!Number.isFinite(x)) return x;
    var sign = x < 0 ? -1 : 1;
    var r = sign * Number(Math.round(Number(Math.abs(x) + 'e' + digits)) + 'e-' + digits);
    return r === 0 ? 0 : r; // -0 を 0 にする
  }

  function fmtNum(x, digits) {
    return round(x, digits).toLocaleString('ja-JP', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function fmtYen(x, digits) {
    return fmtNum(x, digits) + '円';
  }

  function fmtPct(ratio, digits) {
    return fmtNum(ratio * 100, digits === undefined ? 1 : digits) + '%';
  }

  // 表示桁数：1個あたり金額は小数第2位、ロット合計・期間金額は円単位、率は小数第1位
  var DIGITS = { unit: 2, lot: 0, pct: 1 };

  // ---- CSV --------------------------------------------------------------

  /** 数式として解釈されうる文字列の先頭に ' を付ける（CSV インジェクション対策）。 */
  function sanitizeText(s) {
    s = String(s);
    if (/^[=+\-@\t\r＝＋－＠]/.test(s)) return "'" + s;
    return s;
  }

  function csvCell(value) {
    var s;
    if (typeof value === 'number') {
      s = Number.isFinite(value) ? String(value) : '';
    } else {
      s = sanitizeText(value === null || value === undefined ? '' : value);
    }
    return '"' + s.replace(/"/g, '""') + '"';
  }

  /**
   * CSV 文字列を作る（BOM なし。ダウンロード時に BOM を付与する）。
   * 数値は画面と同じ桁数で丸めて出力する。
   */
  function buildCsv(v, r, generatedAt) {
    var U = DIGITS.unit, L = DIGITS.lot, P = DIGITS.pct;
    var rows = [];
    var pct = function (ratio) { return round(ratio * 100, P); };
    var push = function () { rows.push(Array.prototype.slice.call(arguments)); };

    push('区分', '項目', '値', '単位', '備考');
    push('出力情報', 'ツール', 'Maker Margin Studio', '', '入力値に基づく試算。税務・会計上の最終判断ではありません');
    push('出力情報', '出力日時', generatedAt || '', '', '');

    push('商品情報', '商品名', v.product.name, '', '');
    push('商品情報', '製造数量', v.product.quantity, '個', '製造原価の配賦数量');
    push('商品情報', '販売価格（税抜）', v.product.price, '円', '');
    push('商品情報', '販売先', v.product.channelLabel, '', '');

    r.materials.forEach(function (m) {
      push('材料', m.name, round(m.costLot, L), '円/ロット',
        '使用量 ' + m.usage + (m.unit || '') + ' / 単価 ' + m.unitPrice + '円 / ロス率 ' + m.lossRate + '% / 投入量 ' + round(m.inputQty, 2) + (m.unit || ''));
    });
    r.packaging.forEach(function (k) {
      push('包装資材', k.name, round(k.costUnit, U), '円/個', '数量 ' + k.qtyPerUnit + ' / 単価 ' + k.unitPrice + '円');
    });

    r.breakdown.forEach(function (b) {
      push('原価内訳（ロット）', b.label, round(b.lot, L), '円', LABOR_TYPES[b.behavior] + ' / 構成比 ' + pct(b.share) + '%');
    });
    push('原価内訳（ロット）', '製造原価合計', round(r.mfgLot, L), '円', '');
    r.breakdown.forEach(function (b) {
      push('原価内訳（1個あたり）', b.label, round(b.unit, U), '円', LABOR_TYPES[b.behavior]);
    });
    push('原価内訳（1個あたり）', '1個あたり製造原価', round(r.mfgUnit, U), '円', '');

    var m = r.main;
    push('利益', '粗利（1個あたり）', round(m.grossProfit, U), '円', '税抜販売価格 − 1個あたり製造原価');
    push('利益', '粗利率', pct(m.grossMargin), '%', '粗利 ÷ 税抜販売価格');
    push('販売関連費用', '販売手数料（1個あたり）', round(m.sales.commission, U), '円', '');
    push('販売関連費用', '送料負担額（1個あたり）', round(m.sales.shipping, U), '円', '');
    push('販売関連費用', 'その他販売変動費（1個あたり）', round(m.sales.other, U), '円', '');
    push('利益', '変動費合計（1個あたり）', round(m.variableUnit, U), '円', '変動製造原価 + 販売関連変動費');
    push('利益', '限界利益（1個あたり）', round(m.marginalProfit, U), '円', '税抜販売価格 − 変動費合計');
    push('利益', '限界利益率', pct(m.marginalRatio), '%', '');

    push('損益分岐点', '期間固定費', v.fixed.entered ? round(v.fixed.periodFixed, L) : '', '円', v.fixed.entered ? '' : '未入力');
    if (m.breakEven.available) {
      push('損益分岐点', '損益分岐点販売数量', m.breakEven.units, '個', '期間固定費 ÷ 限界利益（切り上げ）');
      push('損益分岐点', '損益分岐点売上高', round(m.breakEven.sales, L), '円', '損益分岐点販売数量 × 税抜販売価格');
    } else {
      push('損益分岐点', '損益分岐点販売数量', '', '個', breakEvenReasonText(m.breakEven.reason));
    }

    r.scenarios.forEach(function (s, i) {
      var label = '比較価格' + (i + 1);
      push('価格比較', label + ' 販売価格', s.price, '円', '');
      push('価格比較', label + ' 粗利', round(s.grossProfit, U), '円', '差額 ' + round(s.diffGross, U) + '円');
      push('価格比較', label + ' 粗利率', pct(s.grossMargin), '%', '');
      push('価格比較', label + ' 限界利益', round(s.marginalProfit, U), '円', '差額 ' + round(s.diffMarginal, U) + '円');
      push('価格比較', label + ' 損益分岐点販売数量', s.breakEven.available ? s.breakEven.units : '', '個',
        s.breakEven.available ? '' : breakEvenReasonText(s.breakEven.reason));
    });

    push('前提条件', '材料ロス率の扱い', '投入量 = 使用量 ÷ (1 − ロス率)', '', '必要な良品量を確保するための投入量で計算');
    push('前提条件', '人件費の区分', LABOR_TYPES[v.labor.laborType], '', '');
    push('前提条件', '製造作業時間', v.labor.hours, '時間/ロット', '');
    push('前提条件', '1時間あたり人件費', v.labor.wage, '円', '');
    push('前提条件', '販売手数料率', v.sales.commissionRate, '%', '計算対象: ' + COMMISSION_BASES[v.sales.commissionBase]);
    if (v.sales.commissionBase === 'incl') push('前提条件', '消費税率（手数料計算用）', v.sales.taxRate, '%', '');
    push('前提条件', '端数処理', '内部計算は丸めない', '', '表示・CSV: 1個あたり小数第2位、ロット・期間金額は円単位、率は小数第1位で四捨五入');

    return rows.map(function (row) { return row.map(csvCell).join(','); }).join('\r\n') + '\r\n';
  }

  function breakEvenReasonText(reason) {
    if (reason === 'no-fixed') return '期間固定費が未入力のため計算していません';
    if (reason === 'non-positive-margin') return '限界利益が0以下のため計算していません';
    return '';
  }

  return {
    LIMITS: LIMITS,
    CHANNELS: CHANNELS,
    COMMISSION_BASES: COMMISSION_BASES,
    LABOR_TYPES: LABOR_TYPES,
    DEFAULT_THRESHOLDS: DEFAULT_THRESHOLDS,
    SAMPLE: SAMPLE,
    DIGITS: DIGITS,
    parseNumber: parseNumber,
    validate: validate,
    compute: compute,
    salesCostsFor: salesCostsFor,
    breakEven: breakEven,
    buildChecklist: buildChecklist,
    buildCsv: buildCsv,
    breakEvenReasonText: breakEvenReasonText,
    sanitizeText: sanitizeText,
    csvCell: csvCell,
    round: round,
    fmtNum: fmtNum,
    fmtYen: fmtYen,
    fmtPct: fmtPct,
  };
});
