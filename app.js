/*
 * Maker Margin Studio — 画面制御
 * 計算は calc.js（window.MarginCalc）に委譲する。
 * 入力内容は保存しない（localStorage・Cookie・サーバー送信を使わない）。
 */
(function () {
  'use strict';

  var C = window.MarginCalc;
  var U = C.DIGITS.unit, L = C.DIGITS.lot;
  var MAX_SCENARIOS = 5;

  var STATIC_FIELDS = {
    'product-name': ['product', 'name'],
    'product-quantity': ['product', 'quantity'],
    'product-price': ['product', 'price'],
    'product-channel': ['product', 'channel'],
    'labor-hours': ['labor', 'hours'],
    'labor-wage': ['labor', 'wage'],
    'overhead-variable': ['overhead', 'variableLot'],
    'overhead-fixed': ['overhead', 'fixedLot'],
    'sales-commission': ['sales', 'commissionRate'],
    'sales-base': ['sales', 'commissionBase'],
    'sales-tax': ['sales', 'taxRate'],
    'sales-shipping': ['sales', 'shipping'],
    'sales-other': ['sales', 'other'],
    'fixed-period': ['fixed', 'periodFixed'],
    'th-loss': ['thresholds', 'lossRate'],
    'th-packaging': ['thresholds', 'packagingShare'],
    'th-gross': ['thresholds', 'grossMargin'],
  };

  var ROW_KINDS = {
    material: { container: 'material-rows', template: 'tpl-material', prefix: 'mat', title: '材料', keys: ['name', 'usage', 'unit', 'unitPrice', 'lossRate'] },
    packaging: { container: 'packaging-rows', template: 'tpl-packaging', prefix: 'pkg', title: '包装資材', keys: ['name', 'qtyPerUnit', 'unitPrice'] },
    scenario: { container: 'scenario-rows', template: 'tpl-scenario', prefix: 'scenario', title: '比較価格', keys: ['price'] },
  };

  var state = { material: [], packaging: [], scenario: [] };
  var last = null; // 直近の { validation, result }

  function $(id) { return document.getElementById(id); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // ---- フォームの読み書き ----------------------------------------------

  function setForm(data) {
    Object.keys(STATIC_FIELDS).forEach(function (id) {
      var path = STATIC_FIELDS[id];
      var v = (data[path[0]] || {})[path[1]];
      $(id).value = v === undefined || v === null ? '' : v;
    });
    var laborType = (data.labor && data.labor.laborType) || 'variable';
    $('labor-type-' + (laborType === 'fixed' ? 'fixed' : 'variable')).checked = true;
    if (!$('product-channel').value) $('product-channel').value = 'direct';
    if (!$('sales-base').value) $('sales-base').value = 'excl';

    state.material = clone(data.materials || []);
    state.packaging = clone(data.packaging || []);
    state.scenario = (data.scenarios || []).map(function (p) { return { price: p }; });
    renderRows('material');
    renderRows('packaging');
    renderRows('scenario');
  }

  function readForm() {
    var input = { product: {}, labor: {}, overhead: {}, sales: {}, fixed: {}, thresholds: {} };
    Object.keys(STATIC_FIELDS).forEach(function (id) {
      var path = STATIC_FIELDS[id];
      input[path[0]][path[1]] = $(id).value;
    });
    input.labor.laborType = $('labor-type-fixed').checked ? 'fixed' : 'variable';
    input.materials = clone(state.material);
    input.packaging = clone(state.packaging);
    input.scenarios = state.scenario.map(function (s) { return s.price; });
    return input;
  }

  // ---- 行（材料・包装資材・比較価格）の描画 -----------------------------

  function renderRows(kind) {
    var cfg = ROW_KINDS[kind];
    var container = $(cfg.container);
    container.textContent = '';
    state[kind].forEach(function (row, i) {
      var node = $(cfg.template).content.firstElementChild.cloneNode(true);
      node.dataset.kind = kind;
      node.dataset.index = String(i);
      var title = node.querySelector('.row-title');
      if (title) title.textContent = cfg.title + ' ' + (i + 1);
      node.querySelectorAll('[data-key]').forEach(function (input) {
        var key = input.dataset.key;
        var id = cfg.prefix + '-' + i + '-' + key;
        input.id = id;
        input.value = row[key] === undefined || row[key] === null ? '' : row[key];
        var field = input.closest('.field');
        var label = field.querySelector('label');
        label.htmlFor = id;
        if (kind === 'scenario') label.textContent = cfg.title + ' ' + (i + 1) + '（税抜）';
        var err = field.querySelector('.field-error');
        if (err) {
          err.id = id + '-error';
          input.setAttribute('aria-describedby', err.id);
        }
      });
      container.appendChild(node);
    });
    if (kind === 'scenario') $('btn-add-scenario').disabled = state.scenario.length >= MAX_SCENARIOS;
  }

  function addRow(kind) {
    var row = {};
    ROW_KINDS[kind].keys.forEach(function (k) { row[k] = ''; });
    if (kind === 'material') row.unit = 'g';
    state[kind].push(row);
    renderRows(kind);
    var rows = $(ROW_KINDS[kind].container).querySelectorAll('[data-row]');
    var input = rows[rows.length - 1].querySelector('input');
    if (input) input.focus();
    recalc();
  }

  function removeRow(kind, index) {
    state[kind].splice(index, 1);
    renderRows(kind);
    recalc();
  }

  // ---- 再計算と描画 -----------------------------------------------------

  function recalc() {
    var input = readForm();
    var validation = C.validate(input);
    var result = validation.ok ? C.compute(validation.values) : null;
    last = { input: input, validation: validation, result: result };

    $('sales-tax-field').hidden = $('sales-base').value !== 'incl';
    var q = C.parseNumber($('product-quantity').value);
    $('allocation-qty').textContent = q.ok && q.value > 0 ? C.fmtNum(q.value, 0) : '—';
    var p = C.parseNumber($('product-price').value);
    $('scenario-base-price').textContent = p.ok && p.value > 0 ? C.fmtYen(p.value, U) : '未入力';

    showFieldErrors(validation.errors);
    renderStatus(validation, result);
    renderRowResults(result);

    var body = $('results-body');
    if (result) {
      body.classList.remove('is-invalid');
      renderResults(validation.values, result);
    } else {
      body.classList.add('is-invalid');
      clearResults();
    }
    renderChecklist(validation, result);
    $('btn-csv').disabled = !result;
    $('btn-csv-top').disabled = !result;
    $('csv-error').hidden = !!result;
    $('csv-error').textContent = result ? '' : '入力エラーを修正するとCSVを出力できます。';
  }

  function showFieldErrors(errors) {
    document.querySelectorAll('.field-error').forEach(function (el) {
      if (el.id === 'csv-error') return;
      el.hidden = true;
      el.textContent = '';
    });
    document.querySelectorAll('[aria-invalid]').forEach(function (el) { el.removeAttribute('aria-invalid'); });
    errors.forEach(function (e) {
      var input = $(e.field);
      if (input) input.setAttribute('aria-invalid', 'true');
      var el = $(e.field + '-error');
      if (el) {
        el.textContent = e.message;
        el.hidden = false;
      }
    });
  }

  function renderStatus(validation, result) {
    var box = $('status');
    box.textContent = '';
    if (!result) {
      box.className = 'status status-error';
      appendText(box, 'strong', '入力内容を確認してください（' + validation.errors.length + '件）');
      appendText(box, 'p', '必須項目の不足や不正な値があるため、計算結果は表示していません。');
      var ul = document.createElement('ul');
      validation.errors.forEach(function (e) {
        var li = document.createElement('li');
        var a = document.createElement('a');
        a.href = '#' + e.field;
        a.textContent = e.message;
        a.addEventListener('click', function (ev) {
          ev.preventDefault();
          var el = $(e.field);
          if (el) { el.focus(); el.scrollIntoView({ block: 'center' }); }
        });
        li.appendChild(a);
        ul.appendChild(li);
      });
      box.appendChild(ul);
      return;
    }
    var m = result.main;
    if (!(m.marginalProfit > 0)) {
      box.className = 'status status-error';
      appendText(box, 'strong', '計算しました：限界利益が0以下です');
      appendText(box, 'p', '現在の条件では固定費を回収できない可能性があります。下の注意点を確認してください。');
    } else if (m.grossProfit < 0) {
      box.className = 'status status-warn';
      appendText(box, 'strong', '計算しました：粗利がマイナスです');
      appendText(box, 'p', '下の注意点を確認してください。');
    } else {
      box.className = 'status status-ok';
      appendText(box, 'strong', '計算しました');
      appendText(box, 'p', '入力値はすべて有効です。数値を変更すると自動で再計算されます。');
    }
  }

  function appendText(parent, tag, text) {
    var el = document.createElement(tag);
    el.textContent = text;
    parent.appendChild(el);
    return el;
  }

  function out(key, text, cls) {
    document.querySelectorAll('[data-out="' + key + '"]').forEach(function (el) {
      el.textContent = text;
      el.classList.toggle('neg', cls === 'neg');
    });
  }

  function signCls(x) { return x < 0 ? 'neg' : ''; }

  function renderRowResults(result) {
    document.querySelectorAll('[data-row-result]').forEach(function (el) { el.textContent = ''; });
    if (!result) return;
    var v = last.validation.values;
    v.materials.forEach(function (m, k) {
      var r = result.materials[k];
      var el = rowResultEl('material', m.index);
      if (el) {
        el.textContent = '投入量 ' + C.fmtNum(r.inputQty, 2) + (r.unit || '') +
          '（ロス ' + C.fmtNum(r.lossQty, 2) + (r.unit || '') + '）／ 材料費 ' + C.fmtYen(r.costLot, L) + '/ロット・' + C.fmtYen(r.costUnit, U) + '/個';
      }
    });
    v.packaging.forEach(function (k, j) {
      var r = result.packaging[j];
      var el = rowResultEl('packaging', k.index);
      if (el) el.textContent = '1個あたり ' + C.fmtYen(r.costUnit, U) + ' ／ ロット ' + C.fmtYen(r.costLot, L);
    });
  }

  function rowResultEl(kind, index) {
    var node = $(ROW_KINDS[kind].container).querySelector('[data-row][data-index="' + index + '"]');
    return node ? node.querySelector('[data-row-result]') : null;
  }

  function renderResults(v, r) {
    var m = r.main;
    out('mfgUnit', C.fmtYen(r.mfgUnit, U));
    out('mfgUnit2', C.fmtYen(r.mfgUnit, U));
    out('mfgUnit3', C.fmtYen(r.mfgUnit, U));
    out('mfgLot', C.fmtYen(r.mfgLot, L));
    out('grossProfit', C.fmtYen(m.grossProfit, U), signCls(m.grossProfit));
    out('grossProfit2', C.fmtYen(m.grossProfit, U), signCls(m.grossProfit));
    out('grossMargin', C.fmtPct(m.grossMargin), signCls(m.grossMargin));
    out('grossMargin2', C.fmtPct(m.grossMargin), signCls(m.grossMargin));
    out('marginalProfit', C.fmtYen(m.marginalProfit, U), signCls(m.marginalProfit));
    out('marginalProfit2', C.fmtYen(m.marginalProfit, U), signCls(m.marginalProfit));
    out('marginalRatio', C.fmtPct(m.marginalRatio), signCls(m.marginalRatio));
    out('marginalRatio2', C.fmtPct(m.marginalRatio), signCls(m.marginalRatio));
    out('price', C.fmtYen(m.price, U));
    out('price2', C.fmtYen(m.price, U));
    out('variableMfgUnit', C.fmtYen(r.variableMfgUnit, U));
    out('commission', C.fmtYen(m.sales.commission, U));
    out('shipping', C.fmtYen(m.sales.shipping, U));
    out('otherSales', C.fmtYen(m.sales.other, U));
    out('fixedMfgNote', r.fixedMfgUnit > 0
      ? '製造原価のうち固定費に区分した ' + C.fmtYen(r.fixedMfgUnit, U) + '/個 は、限界利益の計算では差し引かず、期間固定費として扱います。'
      : '製造原価はすべて変動費として扱っています。');

    var be = m.breakEven;
    var detail = document.querySelector('[data-out="bepDetail"]');
    detail.textContent = '';
    if (be.available) {
      out('bepUnits', C.fmtNum(be.units, 0) + '個');
      out('bepSub', '売上高 ' + C.fmtYen(be.sales, L));
      appendText(detail, 'p', '期間固定費 ' + C.fmtYen(v.fixed.periodFixed, L) + ' ÷ 1個あたり限界利益 ' + C.fmtYen(m.marginalProfit, U) +
        ' ＝ ' + C.fmtNum(be.exactUnits, 2) + '個 → 切り上げて ' + C.fmtNum(be.units, 0) + '個').className = 'formula';
      appendText(detail, 'p', '損益分岐点売上高（税抜）：' + C.fmtYen(be.sales, L) + '。この数量を超えて販売すると、期間固定費を回収したうえで利益が出る試算です。');
      if (be.units > r.quantity) {
        appendText(detail, 'p', '参考：損益分岐点販売数量は1ロットの製造数量（' + C.fmtNum(r.quantity, 0) + '個）の ' + C.fmtNum(be.units / r.quantity, 1) + '倍です。').className = 'muted';
      }
    } else {
      out('bepUnits', '計算不可');
      out('bepSub', be.reason === 'no-fixed' ? '期間固定費が未入力' : '限界利益が0以下');
      var p = appendText(detail, 'p', C.breakEvenReasonText(be.reason) + '。');
      p.className = be.reason === 'no-fixed' ? 'note-info' : 'note-error';
    }

    renderBreakdown(r);
    renderScenarioTable(v, r);
  }

  function clearResults() {
    document.querySelectorAll('[data-out]').forEach(function (el) {
      el.textContent = el.dataset.out === 'bepDetail' || el.dataset.out === 'bepSub' || el.dataset.out === 'fixedMfgNote' ? '' : '—';
      el.classList.remove('neg');
    });
    $('cost-stack').textContent = '';
    $('breakdown-table').querySelector('tbody').textContent = '';
    $('scenario-table').querySelector('thead').textContent = '';
    $('scenario-table').querySelector('tbody').textContent = '';
  }

  function renderBreakdown(r) {
    var stack = $('cost-stack');
    stack.textContent = '';
    r.breakdown.forEach(function (b, i) {
      if (b.lot <= 0) return;
      var seg = document.createElement('div');
      seg.className = 'seg seg-' + (i + 1);
      seg.style.width = (b.share * 100) + '%';
      seg.title = b.label + '：' + C.fmtYen(b.unit, U) + '（' + C.fmtPct(b.share) + '）';
      stack.appendChild(seg);
    });
    var tbody = $('breakdown-table').querySelector('tbody');
    tbody.textContent = '';
    r.breakdown.forEach(function (b, i) {
      var tr = document.createElement('tr');
      var th = document.createElement('th');
      th.scope = 'row';
      var sw = document.createElement('span');
      sw.className = 'swatch seg-' + (i + 1);
      th.appendChild(sw);
      th.appendChild(document.createTextNode(b.label));
      var tag = appendText(th, 'span', C.LABOR_TYPES[b.behavior]);
      tag.className = 'tag tag-' + b.behavior;
      tr.appendChild(th);
      cell(tr, C.fmtYen(b.lot, L), 'num');
      cell(tr, C.fmtYen(b.unit, U), 'num');
      cell(tr, C.fmtPct(b.share), 'num');
      tbody.appendChild(tr);
    });
  }

  function cell(tr, text, cls) {
    var td = document.createElement('td');
    td.textContent = text;
    if (cls) td.className = cls;
    tr.appendChild(td);
    return td;
  }

  function renderScenarioTable(v, r) {
    var table = $('scenario-table');
    var thead = table.querySelector('thead');
    var tbody = table.querySelector('tbody');
    thead.textContent = '';
    tbody.textContent = '';
    var cols = [{ label: '現在の価格', s: r.main, base: true }].concat(r.scenarios.map(function (s, i) {
      return { label: '比較' + (i + 1), s: s };
    }));
    var hr = document.createElement('tr');
    appendText(hr, 'th', '項目').scope = 'col';
    cols.forEach(function (c) {
      var th = appendText(hr, 'th', c.label);
      th.scope = 'col';
      th.className = 'num' + (c.base ? ' col-base' : '');
    });
    thead.appendChild(hr);

    var rows = [
      ['販売価格（税抜）', function (s) { return C.fmtYen(s.price, U); }],
      ['1個あたり製造原価', function (s) { return C.fmtYen(s.mfgUnit, U); }],
      ['1個あたり粗利', function (s) { return C.fmtYen(s.grossProfit, U); }, 'grossProfit'],
      ['粗利率', function (s) { return C.fmtPct(s.grossMargin); }, 'grossMargin'],
      ['販売関連変動費', function (s) { return C.fmtYen(s.sales.total, U); }],
      ['限界利益（販売関連費用控除後）', function (s) { return C.fmtYen(s.marginalProfit, U); }, 'marginalProfit'],
      ['限界利益率', function (s) { return C.fmtPct(s.marginalRatio); }, 'marginalRatio'],
      ['粗利の差（現在比）', function (s, c) { return c.base ? '—' : signed(s.diffGross); }, 'diffGross'],
      ['限界利益の差（現在比）', function (s, c) { return c.base ? '—' : signed(s.diffMarginal); }, 'diffMarginal'],
      ['損益分岐点販売数量', function (s) {
        return s.breakEven.available ? C.fmtNum(s.breakEven.units, 0) + '個' : (s.breakEven.reason === 'no-fixed' ? '固定費未入力' : '計算不可');
      }],
    ];
    rows.forEach(function (row) {
      var tr = document.createElement('tr');
      appendText(tr, 'th', row[0]).scope = 'row';
      cols.forEach(function (c) {
        var td = cell(tr, row[1](c.s, c), 'num' + (c.base ? ' col-base' : ''));
        if (row[2] && !(c.base && row[2].indexOf('diff') === 0) && c.s[row[2]] < 0) td.classList.add('neg');
      });
      tbody.appendChild(tr);
    });
    if (!r.scenarios.length) {
      var tr = document.createElement('tr');
      var td = cell(tr, '比較価格を「G. 販売価格の比較」で追加すると、ここに並べて表示します。', 'muted');
      td.colSpan = 2;
      tbody.appendChild(tr);
    }
  }

  function signed(x) {
    var rx = C.round(x, U);
    return (rx > 0 ? '+' : '') + C.fmtYen(rx, U);
  }

  function renderChecklist(validation, result) {
    var ul = $('checklist');
    ul.textContent = '';
    var items = result
      ? C.buildChecklist(validation.values, result)
      : [{ level: 'error', title: '入力エラーがあります', body: '入力エラーを修正すると、計算結果に応じた確認事項を表示します。' }];
    var labels = { error: '要対応', warn: '注意', info: '確認' };
    items.forEach(function (it) {
      var li = document.createElement('li');
      li.className = 'check check-' + it.level;
      var badge = appendText(li, 'span', labels[it.level]);
      badge.className = 'badge badge-' + it.level;
      var div = document.createElement('div');
      appendText(div, 'strong', it.title);
      appendText(div, 'p', it.body);
      li.appendChild(div);
      ul.appendChild(li);
    });
  }

  // ---- CSV ダウンロード -------------------------------------------------

  function downloadCsv() {
    recalc();
    if (!last.result) {
      $('csv-error').hidden = false;
      $('status').scrollIntoView({ block: 'start' });
      return;
    }
    var now = new Date();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var stamp = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes());
    var csv = C.buildCsv(last.validation.values, last.result, stamp);
    // UTF-8 BOM を付けて Excel での文字化けを防ぐ
    var blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    // ファイル名は ASCII のみにする（日本語を含むと "download" という拡張子なしの名前に
    // 置き換えるブラウザがあるため）。商品名は CSV の中に出力している。
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'maker-margin-studio_' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '-' + pad(now.getHours()) + pad(now.getMinutes()) + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ---- イベント ---------------------------------------------------------

  function onRowInput(e) {
    var input = e.target;
    var row = input.closest('[data-row]');
    if (!row || !input.dataset.key) return;
    state[row.dataset.kind][Number(row.dataset.index)][input.dataset.key] = input.value;
  }

  function onRowClick(e) {
    var btn = e.target.closest('[data-remove]');
    if (!btn) return;
    var row = btn.closest('[data-row]');
    removeRow(row.dataset.kind, Number(row.dataset.index));
  }

  function init() {
    var form = $('calc-form');
    form.addEventListener('input', function (e) { onRowInput(e); recalc(); });
    form.addEventListener('change', recalc);
    form.addEventListener('submit', function (e) { e.preventDefault(); });
    form.addEventListener('click', onRowClick);

    $('btn-add-material').addEventListener('click', function () { addRow('material'); });
    $('btn-add-packaging').addEventListener('click', function () { addRow('packaging'); });
    $('btn-add-scenario').addEventListener('click', function () { addRow('scenario'); });
    $('btn-sample').addEventListener('click', function () {
      if (window.confirm('現在の入力内容をサンプルデータで置き換えます。よろしいですか？')) {
        setForm(C.SAMPLE);
        recalc();
      }
    });
    $('btn-clear').addEventListener('click', function () {
      if (window.confirm('入力内容をすべて消去します。よろしいですか？')) {
        setForm({
          product: { channel: 'direct' },
          materials: [{ name: '', usage: '', unit: 'g', unitPrice: '', lossRate: '' }],
          packaging: [{ name: '', qtyPerUnit: '', unitPrice: '' }],
          labor: { laborType: 'variable' },
          sales: { commissionBase: 'excl', taxRate: '' },
          scenarios: [],
          thresholds: C.DEFAULT_THRESHOLDS,
        });
        recalc();
        $('product-name').focus();
      }
    });
    $('btn-csv').addEventListener('click', downloadCsv);
    $('btn-csv-top').addEventListener('click', downloadCsv);

    setForm(C.SAMPLE);
    recalc();
  }

  init();
})();
