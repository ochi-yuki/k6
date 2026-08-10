// ============================================================================
// k6 browser モード サンプル
//   親画面 → サブウィンドウ（ポップアップ）で検索 → 選択 → 親画面に値がセット
//   を 2 回（サブウィンドウ1／サブウィンドウ2）繰り返すシナリオ
//
// 実行:
//   k6 run popup-scenario.js
//   K6_BROWSER_HEADLESS=false k6 run popup-scenario.js   // 画面を見ながらデバッグ
//   BASE_URL=https://your-app.example.com k6 run popup-scenario.js
//
// 前提: k6 v0.52 以降（それ以前は import を 'k6/experimental/browser' に）
//       browser API は基本すべて非同期なので await を付けること
// ============================================================================

import { browser } from 'k6/browser';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'https://example.com';

export const options = {
  scenarios: {
    popup_flow: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: '3m',
      options: {
        browser: { type: 'chromium' },
      },
    },
  },
  thresholds: {
    checks: ['rate==1.0'],
    browser_web_vital_lcp: ['p(95)<3000'],
  },
};

// ---------------------------------------------------------------------------
// 画面ごとのセレクタ定義（実アプリに合わせて書き換える）
// ---------------------------------------------------------------------------
const SUB1 = {
  name: '得意先検索',
  openButton: '#btnOpenCustomer',        // 親画面：サブウィンドウ1を開くボタン1
  searchInput: '#txtKeyword',            // サブ画面：検索キーワード入力欄
  searchButton: '#btnSearch',            // サブ画面：検索ボタン
  resultRow: '#resultTable tbody tr',    // サブ画面：検索結果の行
  selectButton: '#resultTable tbody tr:first-child button.btn-select', // 選択ボタン
  parentField: '#txtCustomerCode',       // 親画面：値がセットされる項目
  keyword: '東京',
};

const SUB2 = {
  name: '商品検索',
  openButton: '#btnOpenProduct',         // 親画面：サブウィンドウ2を開くボタン2
  searchInput: '#txtProductName',
  searchButton: '#btnSearch',
  resultRow: '#resultTable tbody tr',
  selectButton: '#resultTable tbody tr:first-child button.btn-select',
  parentField: '#txtProductCode',
  keyword: 'ボールペン',
};

// ---------------------------------------------------------------------------
// メインシナリオ
// ---------------------------------------------------------------------------
export default async function () {
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // ---- 親画面を表示 ----
    await page.goto(`${BASE_URL}/order/entry`, { waitUntil: 'networkidle' });
    await page.waitForSelector(SUB1.openButton, { state: 'visible' });

    check(await page.title(), {
      '親画面が表示された': (t) => t.length > 0,
    });

    // ---- サブウィンドウ1 ----
    await selectFromSubWindow(context, page, SUB1);

    // ---- サブウィンドウ2 ----
    await selectFromSubWindow(context, page, SUB2);
  } finally {
    // ポップアップが残っていても context.close() でまとめて閉じられる
    await page.close();
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// サブウィンドウを開いて検索 → 選択 → 親画面の値を検証する共通処理
// ---------------------------------------------------------------------------
async function selectFromSubWindow(context, parentPage, cfg) {
  // 検証用に「開く前の値」を控えておく（既に値が入っている画面でも判定できるように）
  const before = await parentPage.locator(cfg.parentField).inputValue();

  // ★ポイント1: click() より先に waitForEvent('page') を登録する。
  //   Promise.all の引数は左から評価されるので、この順番で書くこと。
  //   （後から登録するとポップアップの生成イベントを取りこぼす）
  const [subPage] = await Promise.all([
    context.waitForEvent('page'),                 // window.open で開く新規ページを捕捉
    parentPage.locator(cfg.openButton).click(),   // ボタンをクリック
  ]);

  // ---- サブウィンドウ側の操作 ----
  await subPage.waitForLoadState('load');
  await subPage.waitForSelector(cfg.searchInput, { state: 'visible' });

  // 検索
  await subPage.locator(cfg.searchInput).fill(cfg.keyword);

  // (A) 検索がポストバック（画面遷移）の場合はナビゲーション待ちを併用する
  await Promise.all([
    subPage.waitForNavigation({ waitUntil: 'load' }),
    subPage.locator(cfg.searchButton).click(),
  ]);

  // (B) Ajax 検索の場合は上の Promise.all を消して、下記だけにする
  // await subPage.locator(cfg.searchButton).click();

  // 検索結果欄が描画されるまで待つ
  await subPage.waitForSelector(cfg.resultRow, { state: 'visible', timeout: 15000 });
  const hitCount = await subPage.locator(cfg.resultRow).count();
  check(hitCount, {
    [`[${cfg.name}] 検索結果が1件以上ある`]: (n) => n > 0,
  });

  // 選択ボタンをクリック（通常ここで opener に値をセットし self.close() される）
  await subPage.locator(cfg.selectButton).click();

  // ★ポイント2: サブウィンドウが自分で閉じるまで待つ。
  //   閉じない仕様なら subPage.close() を明示的に呼ぶ。
  await waitForClose(subPage, 10000);

  // ---- 親画面に値がセットされたことを確認 ----
  const value = await waitForValueChanged(parentPage, cfg.parentField, before, 10000);

  check(value, {
    [`[${cfg.name}] 親画面に値がセットされた`]: (v) => v !== '' && v !== before,
  });

  console.log(`[${cfg.name}] 親画面 ${cfg.parentField} = "${value}"`);
}

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

// 親画面の入力欄の値が変わるまでポーリングする
// （page.waitForFunction でも書けるが、バージョン差の少ないこの形が無難）
async function waitForValueChanged(page, selector, before, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const current = await page.locator(selector).inputValue();
    if (current !== before && current.trim() !== '') {
      return current;
    }
    await page.waitForTimeout(200);
  }
  return await page.locator(selector).inputValue(); // タイムアウト時は最終値を返す
}

// サブウィンドウが閉じるのを待つ。閉じなければこちらから閉じる
async function waitForClose(subPage, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (subPage.isClosed()) return;
    await subPage.waitForTimeout(200);
  }
  try {
    await subPage.close();
  } catch (e) {
    // 既に閉じられていた場合は無視
  }
}

// ---------------------------------------------------------------------------
// 参考: <label>や表示テキストが不変ならセレクタは role / text ベースが堅牢
//   parentPage.getByRole('button', { name: '得意先検索' })
//   subPage.getByRole('row', { name: /東京商事/ }).getByRole('button', { name: '選択' })
//
// 参考: ポップアップではなく同一タブ遷移や <iframe> のモーダルの場合
//   - 同一タブ  : waitForEvent('page') は不要。waitForNavigation() を使う
//   - iframe    : const f = subFrameOwner.frameLocator('#modalFrame'); f.locator(...)
//
// 注意: 旧来の window.showModalDialog は Chromium で廃止済みのため動作しない
// ---------------------------------------------------------------------------
