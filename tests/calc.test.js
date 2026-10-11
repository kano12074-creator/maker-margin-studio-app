// 計算ロジックの単体テスト（依存パッケージなし）
// 実行: node --test tests/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../calc.js');

const close = (actual, expected, eps = 1e-9, msg) =>
  assert.ok(Math.abs(actual - expected) <= eps, `${msg || ''} expected ${expected}, got ${actual}`);

const clone = (o) => JSON.parse(JSON.stringify(o));

function run(input) {
  const v = C.validate(input);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  return { v: v.values, r: C.compute(v.values) };
}

// サンプルデータの期待値（README「使用例」と同じ値を手計算で求めたもの）
const EXP = {
  materialsLot: 4000 / 0.95 * 0.4 + 2000 / 0.98 * 2 + 1500 * 0.3 + 600 / 0.9 * 0.6,
};
EXP.mfgLot = EXP.materialsLot + 80 * 100 + 6 * 1100 + 1500 + 2000;
EXP.mfgUnit = EXP.mfgLot / 100;
EXP.variableMfgUnit = EXP.materialsLot / 100 + 80 + 66 + 15;

test('サンプル: 原価・粗利・限界利益・損益分岐点', () => {
  const { r } = run(C.SAMPLE);
  close(r.materialsLot, 6615.843179377, 1e-6, 'materialsLot');
  close(r.materialsLot, EXP.materialsLot);
  close(r.packagingUnit, 80);
  close(r.packagingLot, 8000);
  close(r.laborLot, 6600);
  close(r.laborUnit, 66);
  close(r.overheadLot, 3500);
  close(r.mfgUnit, EXP.mfgUnit);
  assert.equal(C.round(r.mfgUnit, 2), 247.16);
  close(r.main.grossProfit, 1200 - EXP.mfgUnit);
  assert.equal(C.round(r.main.grossProfit, 2), 952.84);
  assert.equal(C.round(r.main.grossMargin * 100, 1), 79.4);
  close(r.variableMfgUnit, EXP.variableMfgUnit);
  close(r.main.sales.commission, 120);
  close(r.main.sales.total, 290);
  close(r.main.marginalProfit, 1200 - EXP.variableMfgUnit - 290);
  assert.equal(C.round(r.main.marginalProfit, 2), 682.84);
  assert.equal(r.main.breakEven.available, true);
  assert.equal(r.main.breakEven.units, 293); // 200000 / 682.84 = 292.89 → 293
  assert.equal(r.main.breakEven.sales, 293 * 1200);
});

test('ロス率は良品率で割る方式（投入量 = 使用量 ÷ (1 − ロス率)）', () => {
  const input = clone(C.SAMPLE);
  input.materials = [{ name: 'X', usage: '1000', unit: 'g', unitPrice: '1', lossRate: '20' }];
  const { r } = run(input);
  close(r.materials[0].inputQty, 1250);
  close(r.materials[0].costLot, 1250);
  close(r.materials[0].lossQty, 250);
  assert.notEqual(Math.round(r.materials[0].costLot), 1200); // 単純増額方式（×1.2）ではない
  close(r.materials[0].yieldRate, 0.8);
});

test('ロス率 0% は使用量どおり、100% 以上はエラー', () => {
  const input = clone(C.SAMPLE);
  input.materials = [{ name: 'X', usage: '500', unitPrice: '2', lossRate: '' }];
  close(run(input).r.materialsLot, 1000);
  input.materials[0].lossRate = '100';
  const v = C.validate(input);
  assert.equal(v.ok, false);
  assert.equal(v.errors[0].field, 'mat-0-lossRate');
});

test('製造数量を変えると1個あたり原価が再配賦される', () => {
  const input = clone(C.SAMPLE);
  input.product.quantity = '200';
  input.materials = [{ name: 'X', usage: '1000', unitPrice: '1', lossRate: '0' }];
  input.packaging = [{ name: '箱', qtyPerUnit: '1', unitPrice: '50' }];
  const { r } = run(input);
  // 材料1000 + 包装50×200 + 人件費6600 + 経費3500 = 21100 / 200
  close(r.mfgLot, 1000 + 10000 + 6600 + 3500);
  close(r.mfgUnit, 21100 / 200);
  close(r.packagingUnit, 50); // 包装は1個あたり数量なので数量に依存しない
});

test('人件費の固定/変動区分は粗利に影響せず、限界利益にのみ影響する', () => {
  const a = run(C.SAMPLE).r;
  const input = clone(C.SAMPLE);
  input.labor.laborType = 'fixed';
  const b = run(input).r;
  close(a.main.grossProfit, b.main.grossProfit);
  close(b.main.marginalProfit - a.main.marginalProfit, 66);
  close(b.fixedMfgUnit, 66 + 20);
});

test('販売手数料の計算対象（税抜／税込）', () => {
  const input = clone(C.SAMPLE);
  input.sales.commissionBase = 'incl';
  input.sales.taxRate = '8';
  const { r } = run(input);
  close(r.main.sales.commissionBaseAmount, 1296);
  close(r.main.sales.commission, 129.6);
  input.sales.taxRate = '';
  const v = C.validate(input);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.field === 'sales-tax'));
});

test('価格シミュレーション：手数料は価格に連動し、原価は一定', () => {
  const { r } = run(C.SAMPLE);
  const [s1, s2] = r.scenarios;
  close(s1.price, 1080);
  close(s1.mfgUnit, EXP.mfgUnit);
  close(s1.sales.commission, 108);
  close(s1.grossProfit, 1080 - EXP.mfgUnit);
  close(s1.marginalProfit, 1080 - EXP.variableMfgUnit - 108 - 170);
  close(s1.diffGross, -120);
  close(s1.diffMarginal, -120 + 12);
  assert.equal(s1.breakEven.units, Math.ceil(200000 / s1.marginalProfit));
  close(s2.marginalProfit, 1300 - EXP.variableMfgUnit - 130 - 170);
  close(s2.diffMarginal, 90);
});

test('限界利益が0以下なら損益分岐点を計算せず警告する', () => {
  const input = clone(C.SAMPLE);
  input.product.price = '300';
  const { v, r } = run(input);
  assert.ok(r.main.marginalProfit <= 0);
  assert.equal(r.main.breakEven.available, false);
  assert.equal(r.main.breakEven.reason, 'non-positive-margin');
  const items = C.buildChecklist(v, r);
  assert.ok(items.some((i) => i.level === 'error' && i.title.includes('限界利益が0以下')));
});

test('限界利益がちょうど0でも損益分岐点を計算しない', () => {
  const be = C.breakEven(1000, 0, 100);
  assert.equal(be.available, false);
  assert.equal(C.breakEven(1000, -5, 100).reason, 'non-positive-margin');
});

test('期間固定費が未入力なら損益分岐点は計算不可、0は0個', () => {
  const input = clone(C.SAMPLE);
  input.fixed.periodFixed = '';
  const { v, r } = run(input);
  assert.equal(r.main.breakEven.reason, 'no-fixed');
  assert.ok(C.buildChecklist(v, r).some((i) => i.title.includes('期間固定費が未入力')));
  input.fixed.periodFixed = '0';
  assert.equal(run(input).r.main.breakEven.units, 0);
});

test('損益分岐点の切り上げは浮動小数点誤差で1個増えない', () => {
  assert.equal(C.breakEven(30000, 300, 1000).units, 100);
  assert.equal(C.breakEven(0.3 * 1000, 0.1 + 0.2, 1).units, 1000); // 0.1+0.2 = 0.30000000000000004
  assert.equal(C.breakEven(1000, 3, 10).units, 334);
});

test('必須入力の不足・不正値・負の値・0除算・極端な値を検出する', () => {
  const cases = [
    [(i) => { i.product.name = '  '; }, 'product-name'],
    [(i) => { i.product.quantity = ''; }, 'product-quantity'],
    [(i) => { i.product.quantity = '0'; }, 'product-quantity'],      // 0除算
    [(i) => { i.product.quantity = '10.5'; }, 'product-quantity'],
    [(i) => { i.product.price = ''; }, 'product-price'],
    [(i) => { i.product.price = '0'; }, 'product-price'],            // 粗利率の0除算
    [(i) => { i.product.price = 'abc'; }, 'product-price'],
    [(i) => { i.product.price = '1e5'; }, 'product-price'],
    [(i) => { i.product.price = '-100'; }, 'product-price'],
    [(i) => { i.product.price = '99999999999'; }, 'product-price'],
    [(i) => { i.materials[0].usage = ''; }, 'mat-0-usage'],
    [(i) => { i.materials[1].unitPrice = '-1'; }, 'mat-1-unitPrice'],
    [(i) => { i.packaging[0].unitPrice = '１２円'; }, 'pkg-0-unitPrice'],
    [(i) => { i.labor.hours = 'Infinity'; }, 'labor-hours'],
    [(i) => { i.sales.commissionRate = '100'; }, 'sales-commission'],
    [(i) => { i.fixed.periodFixed = '-1'; }, 'fixed-period'],
    [(i) => { i.scenarios = ['0']; }, 'scenario-0'],
  ];
  for (const [mutate, field] of cases) {
    const input = clone(C.SAMPLE);
    mutate(input);
    const v = C.validate(input);
    assert.equal(v.ok, false, `should fail: ${field}`);
    assert.ok(v.errors.some((e) => e.field === field), `${field}: ${JSON.stringify(v.errors)}`);
  }
});

test('全角数字・桁区切りカンマ・任意項目の空欄を受け付ける', () => {
  assert.deepEqual(C.parseNumber('１，２００'), { ok: true, value: 1200 });
  assert.deepEqual(C.parseNumber(' 1,200.5 '), { ok: true, value: 1200.5 });
  assert.deepEqual(C.parseNumber(''), { empty: true });
  const input = clone(C.SAMPLE);
  input.sales = { commissionRate: '', commissionBase: 'excl', shipping: '', other: '' };
  input.labor = { hours: '', wage: '', laborType: 'variable' };
  const { r } = run(input);
  close(r.main.sales.total, 0);
  close(r.laborLot, 0);
});

test('材料・包装資材の空行は無視、行の追加・削除が計算に反映される', () => {
  const input = clone(C.SAMPLE);
  input.materials.push({ name: '', usage: '', unit: 'g', unitPrice: '', lossRate: '' });
  close(run(input).r.materialsLot, EXP.materialsLot);
  input.materials.push({ name: '塩', usage: '10', unit: 'g', unitPrice: '0.5', lossRate: '' });
  close(run(input).r.materialsLot, EXP.materialsLot + 5);
  input.materials = input.materials.slice(1); // 薄力粉を削除
  close(run(input).r.materialsLot, EXP.materialsLot + 5 - 4000 / 0.95 * 0.4);
  input.packaging = [];
  close(run(input).r.packagingUnit, 0);
});

test('四捨五入（1.005 問題・負数）', () => {
  assert.equal(C.round(1.005, 2), 1.01);
  assert.equal(C.round(-1.005, 2), -1.01);
  assert.equal(C.round(-0.001, 2), 0);
  assert.equal(C.fmtYen(1234.5, 0), '1,235円');
  assert.equal(C.fmtPct(0.79403, 1), '79.4%');
});

test('CSV：数式インジェクション対策とエスケープ', () => {
  assert.equal(C.csvCell('=SUM(A1)'), '"\'=SUM(A1)"');
  assert.equal(C.csvCell('+81'), '"\'+81"');
  assert.equal(C.csvCell('-x'), '"\'-x"');
  assert.equal(C.csvCell('@cmd'), '"\'@cmd"');
  assert.equal(C.csvCell('＝1+1'), '"\'＝1+1"');
  assert.equal(C.csvCell('a"b,c\nd'), '"a""b,c\nd"');
  assert.equal(C.csvCell(-12.5), '"-12.5"'); // 数値はそのまま
});

test('CSV：画面と同じ丸めで主要値を出力する', () => {
  const input = clone(C.SAMPLE);
  input.product.name = '=HYPERLINK("x")';
  const { v, r } = run(input);
  const csv = C.buildCsv(v, r, '2026-01-01 00:00');
  assert.ok(csv.endsWith('\r\n'));
  const rows = csv.trim().split('\r\n').map((l) => l.split('","').map((s) => s.replace(/^"|"$/g, '')));
  const get = (cat, item) => rows.find((x) => x[0] === cat && x[1] === item);
  assert.equal(get('商品情報', '商品名')[2], '\'=HYPERLINK(""x"")');
  assert.equal(get('原価内訳（1個あたり）', '1個あたり製造原価')[2], '247.16');
  assert.equal(get('利益', '粗利（1個あたり）')[2], '952.84');
  assert.equal(get('利益', '粗利率')[2], '79.4');
  assert.equal(get('利益', '限界利益（1個あたり）')[2], '682.84');
  assert.equal(get('損益分岐点', '損益分岐点販売数量')[2], '293');
  assert.equal(get('損益分岐点', '損益分岐点売上高')[2], '351600');
  assert.equal(get('価格比較', '比較価格1 販売価格')[2], '1080');
  assert.ok(get('前提条件', '材料ロス率の扱い'));
});

test('チェックリスト：基準値は利用者設定に従う', () => {
  const input = clone(C.SAMPLE);
  let { v, r } = run(input);
  let items = C.buildChecklist(v, r);
  assert.ok(items.some((i) => i.title.includes('ロス率')));        // 全卵 10% ≥ 10%
  assert.ok(items.some((i) => i.title.includes('包装資材費の割合'))); // 32.4% ≥ 30%
  assert.ok(!items.some((i) => i.title.includes('粗利率')));
  input.thresholds = { lossRate: '50', packagingShare: '50', grossMargin: '90' };
  ({ v, r } = run(input));
  items = C.buildChecklist(v, r);
  assert.ok(!items.some((i) => i.title.includes('ロス率')));
  assert.ok(!items.some((i) => i.title.includes('包装資材費の割合')));
  assert.ok(items.some((i) => i.title.includes('粗利率')));
});
