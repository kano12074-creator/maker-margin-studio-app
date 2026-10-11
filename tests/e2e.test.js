// ブラウザ E2E テスト（Playwright）
// 実行: node --test tests/e2e.test.js
// Playwright はプロジェクトの依存に含めていない。グローバル導入（npm i -g playwright）か
// NODE_PATH で解決できる環境で実行する。見つからない場合はスキップする。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

function loadPlaywright() {
  try { return require('playwright'); } catch (_) { /* fallthrough */ }
  try {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return require(path.join(root, 'playwright'));
  } catch (_) { return null; }
}
const pw = loadPlaywright();
const ROOT = path.join(__dirname, '..');
const OUT = process.env.E2E_OUT || path.join(__dirname, 'output');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const file = path.join(ROOT, p === '/' ? 'index.html' : p);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end(); return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const skip = pw ? false : 'playwright が見つからないためスキップ';

test.describe('E2E', { skip }, () => {
  let server, browser, base;
  test.before(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    server = await startServer();
    base = `http://127.0.0.1:${server.address().port}/`;
    browser = await pw.chromium.launch();
  });
  test.after(async () => { await browser?.close(); server?.close(); });

  async function open(viewport = { width: 1280, height: 900 }) {
    const context = await browser.newContext({ viewport, acceptDownloads: true });
    const page = await context.newPage();
    const requests = [];
    const consoleErrors = [];
    page.on('request', (r) => requests.push(r.url()));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
    page.on('dialog', (d) => d.accept());
    await page.goto(base);
    return { context, page, requests, consoleErrors };
  }
  const text = (page, sel) => page.locator(sel).first().innerText();
  const kpi = (page, key) => text(page, `.kpi [data-out="${key}"]`);

  test('サンプルデータで正しい結果が表示される', async () => {
    const { context, page, consoleErrors } = await open();
    assert.equal(await kpi(page, 'mfgUnit'), '247.16円');
    assert.equal(await kpi(page, 'grossProfit'), '952.84円');
    assert.equal(await kpi(page, 'grossMargin'), '79.4%');
    assert.equal(await kpi(page, 'marginalProfit'), '682.84円');
    assert.equal(await kpi(page, 'bepUnits'), '293個');
    assert.match(await text(page, '#status'), /計算しました/);
    assert.match(await text(page, '#material-rows [data-row]:nth-child(4) [data-row-result]'), /投入量 666\.67g/);
    await page.screenshot({ path: path.join(OUT, 'desktop.png'), fullPage: true });
    assert.deepEqual(consoleErrors, []);
    await context.close();
  });

  test('材料・包装資材の追加と削除、数量変更で再計算', async () => {
    const { context, page } = await open();
    const mats = page.locator('#material-rows [data-row]');
    assert.equal(await mats.count(), 4);
    await page.click('#btn-add-material');
    assert.equal(await mats.count(), 5);
    await page.fill('#mat-4-name', '塩');
    await page.fill('#mat-4-usage', '1000');
    await page.fill('#mat-4-unitPrice', '1');
    await page.fill('#mat-4-lossRate', '20');
    assert.match(await text(page, '#material-rows [data-row]:nth-child(5) [data-row-result]'), /投入量 1,250\.00g（ロス 250\.00g）／ 材料費 1,250円/);
    assert.equal(await kpi(page, 'mfgUnit'), '259.66円'); // +1250/100
    await mats.nth(4).locator('[data-remove]').click();
    assert.equal(await mats.count(), 4);
    assert.equal(await kpi(page, 'mfgUnit'), '247.16円');

    const pkgs = page.locator('#packaging-rows [data-row]');
    await page.click('#btn-add-packaging');
    assert.equal(await pkgs.count(), 5);
    await page.fill('#pkg-4-qtyPerUnit', '2');
    await page.fill('#pkg-4-unitPrice', '5');
    assert.equal(await kpi(page, 'mfgUnit'), '257.16円');
    await pkgs.nth(0).locator('[data-remove]').click(); // 化粧箱 45円 を削除
    assert.equal(await pkgs.count(), 4);
    assert.equal(await kpi(page, 'mfgUnit'), '212.16円');
    assert.equal(await page.inputValue('#pkg-0-unitPrice'), '3'); // 行番号が詰め直される

    await page.fill('#product-quantity', '200');
    // 材料 6615.84 + 包装 (24+8+3+10)×200 + 人件費 6600 + 経費 3500 = 25715.84 → /200
    assert.equal(await kpi(page, 'mfgUnit'), '128.58円');
    assert.equal(await text(page, '#allocation-qty'), '200');
    await context.close();
  });

  test('価格比較の表', async () => {
    const { context, page } = await open();
    const rows = await page.$$eval('#scenario-table tbody tr', (trs) =>
      trs.map((tr) => [...tr.children].map((c) => c.innerText)));
    const row = (label) => rows.find((r) => r[0] === label);
    assert.deepEqual(row('販売価格（税抜）'), ['販売価格（税抜）', '1,200.00円', '1,080.00円', '1,300.00円']);
    assert.deepEqual(row('1個あたり粗利'), ['1個あたり粗利', '952.84円', '832.84円', '1,052.84円']);
    assert.deepEqual(row('限界利益（販売関連費用控除後）'), ['限界利益（販売関連費用控除後）', '682.84円', '574.84円', '772.84円']);
    assert.deepEqual(row('限界利益の差（現在比）'), ['限界利益の差（現在比）', '—', '-108.00円', '+90.00円']);
    assert.deepEqual(row('損益分岐点販売数量'), ['損益分岐点販売数量', '293個', '348個', '259個']);
    await page.fill('#scenario-1-price', '900');
    assert.match((await page.$$eval('#scenario-table thead th', (t) => t.map((x) => x.innerText))).join(), /比較2/);
    assert.match(await text(page, '#scenario-table tbody tr:nth-child(1) td:nth-child(4)'), /900\.00円/);
    await context.close();
  });

  test('限界利益が0以下で警告、損益分岐点は計算しない', async () => {
    const { context, page } = await open();
    await page.fill('#product-price', '300');
    assert.match(await text(page, '#status'), /限界利益が0以下/);
    assert.equal(await kpi(page, 'bepUnits'), '計算不可');
    assert.match(await text(page, '#checklist'), /要対応[\s\S]*限界利益が0以下です/);
    assert.equal(await page.locator('#status.status-error').count(), 1);
    await context.close();
  });

  test('必須入力の不足・不正値でエラー表示、結果とCSVを無効化', async () => {
    const { context, page } = await open();
    await page.fill('#product-name', '');
    await page.fill('#product-price', 'abc');
    assert.match(await text(page, '#status'), /入力内容を確認してください（2件）/);
    assert.equal(await kpi(page, 'mfgUnit'), '—');
    assert.equal(await page.getAttribute('#product-price', 'aria-invalid'), 'true');
    assert.match(await text(page, '#product-price-error'), /数値で入力/);
    assert.equal(await page.isDisabled('#btn-csv'), true);
    await page.fill('#product-name', 'テスト');
    await page.fill('#product-price', '１，２００'); // 全角＋カンマ
    assert.equal(await kpi(page, 'grossProfit'), '952.84円');
    assert.equal(await page.isDisabled('#btn-csv'), false);
    await page.fill('#fixed-period', '');
    assert.equal(await kpi(page, 'bepUnits'), '計算不可');
    assert.match(await text(page, '#checklist'), /期間固定費が未入力です/);
    await context.close();
  });

  test('CSVの内容が画面の計算結果と一致する', async () => {
    const { context, page } = await open();
    await page.fill('#product-name', '=1+1 テスト');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-csv')]);
    // 日本語の商品名でも拡張子 .csv 付きの ASCII ファイル名になる
    assert.match(dl.suggestedFilename(), /^maker-margin-studio_\d{8}-\d{4}\.csv$/);
    const file = path.join(OUT, 'export.csv');
    await dl.saveAs(file);
    const buf = fs.readFileSync(file);
    assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM');
    const csv = buf.toString('utf8').slice(1);
    const rows = csv.trim().split('\r\n').map((l) => l.slice(1, -1).split('","'));
    const val = (cat, item) => rows.find((r) => r[0] === cat && r[1] === item)[2];
    const num = (s) => s.replace(/[,円%個]/g, '');
    assert.equal(val('商品情報', '商品名'), "'=1+1 テスト");
    assert.equal(val('原価内訳（1個あたり）', '1個あたり製造原価'), num(await kpi(page, 'mfgUnit')));
    assert.equal(val('利益', '粗利（1個あたり）'), num(await kpi(page, 'grossProfit')));
    assert.equal(val('利益', '粗利率'), num(await kpi(page, 'grossMargin')));
    assert.equal(val('利益', '限界利益（1個あたり）'), num(await kpi(page, 'marginalProfit')));
    assert.equal(val('損益分岐点', '損益分岐点販売数量'), num(await kpi(page, 'bepUnits')));
    assert.equal(val('原価内訳（ロット）', '製造原価合計'), num(await text(page, '[data-out="mfgLot"]')));
    assert.equal(val('価格比較', '比較価格2 限界利益'), '772.84');
    await context.close();
  });

  test('スマートフォン幅で横スクロールが発生しない', async () => {
    for (const width of [320, 375, 414]) {
      const { context, page } = await open({ width, height: 800 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, `width ${width}: overflow ${overflow}px`);
      // 主要ボタンのタップ領域（高さ 44px 以上）
      const h = await page.locator('#btn-add-material').evaluate((b) => b.getBoundingClientRect().height);
      assert.ok(h >= 44, `tap height ${h}`);
      if (width === 375) await page.screenshot({ path: path.join(OUT, 'mobile-375.png'), fullPage: true });
      await context.close();
    }
  });

  test('外部通信・データ保存がない', async () => {
    const { context, page, requests } = await open();
    await page.fill('#product-name', '保存されないこと');
    await page.click('#btn-add-material'); // 空行は計算から除外される
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-csv')]);
    await dl.path();
    const external = requests.filter((u) => !u.startsWith(base) && !u.startsWith('blob:') && !u.startsWith('data:'));
    assert.deepEqual(external, []);
    const storage = await page.evaluate(() => ({ ls: localStorage.length, ss: sessionStorage.length, cookie: document.cookie }));
    assert.deepEqual(storage, { ls: 0, ss: 0, cookie: '' });
    assert.deepEqual(await context.cookies(), []);
    // CSP により外部への fetch はブロックされる
    const blocked = await page.evaluate(() => fetch('https://example.com/').then(() => false, () => true));
    assert.equal(blocked, true);
    // 再読み込みすると入力内容は残らない（サンプルに戻る）
    await page.reload();
    assert.equal(await page.inputValue('#product-name'), 'サンプル焼き菓子 バターサブレ 8枚入');
    await context.close();
  });

  test('すべてクリア → サンプル読込', async () => {
    const { context, page } = await open();
    await page.click('#btn-clear');
    assert.match(await text(page, '#status'), /入力内容を確認してください/);
    assert.equal(await page.locator('#material-rows [data-row]').count(), 1);
    await page.click('#btn-sample');
    assert.equal(await kpi(page, 'mfgUnit'), '247.16円');
    await context.close();
  });
});
