// ============================================================================
// k6 browser モード サンプル
//   ・ドロップダウンリストを表示テキストで選択（ポストバック対応）
//   ・登録ボタン → confirm で OK → 登録完了 alert を待機
//
// 実行:
//   k6 run register-scenario.js
//   K6_BROWSER_HEADLESS=false k6 run register-scenario.js
//   BASE_URL=https://your-app.example.com k6 run register-scenario.js
//
// 前提: k6 v0.52 以降（それ以前は import を 'k6/experimental/browser' に）
// ============================================================================

import { browser } from 'k6/browser';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'https://example.com';

export const options = {
  scenarios: {
    register_flow: {
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
  },
};

// 実アプリに合わせて書き換える
const SEL = {
  branchDropdown: '#ddlBranch',        // ポストバックするドロップダウン
  categoryDropdown: '#ddlCategory',    // 通常のドロップダウン
  registerButton: '#btnRegister',      // 登録ボタン
  completedPanel: '#pnlCompleted',     // 登録完了後に表示される要素
};

// ---------------------------------------------------------------------------
// メインシナリオ
// ---------------------------------------------------------------------------
export default async function () {
  const context = await browser.newContext();
  const page = await context.newPage();

  // ★イテレーション毎に初期化すること。
  //   モジュールスコープに置くと前回の記録が残り、待機が即成立してしまう
  const dialogs = [];
  attachDialogHandler(page, dialogs);

  try {
    await page.goto(`${BASE_URL}/order/entry`, { waitUntil: 'networkidle' });

    // ---- ドロップダウン: 表示テキストで選択（ポストバックあり）----
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'load' }),
      page.locator(SEL.branchDropdown).selectOption({ label: '大阪支店' }),
    ]);

    check(await getSelectedText(page, SEL.branchDropdown), {
      '支店が選択された': (t) => t === '大阪支店',
    });

    // ---- ドロップダウン: 部分一致で選択（「001：文房具」のような表記に対応）----
    await selectByPartialText(page, SEL.categoryDropdown, '文房具');

    // ---- 登録ボタンクリック → confirm で OK ----
    await page.locator(SEL.registerButton).click();

    // ---- 登録完了 alert を待機 ----
    const done = await waitForDialog(page, dialogs, {
      type: 'alert',
      match: /登録が完了しました/,
      timeout: 30000,
    });

    check(done, {
      '登録完了の alert が表示された': (d) => d !== null,
    });
    check(dialogs.filter((d) => d.type === 'confirm').length, {
      '確認 confirm が1回表示された': (n) => n === 1,
    });

    // ---- alert を閉じた後の画面を確認 ----
    // ※ waitForNavigation との Promise.all は使わない。
    //   alert がモーダルで JS を止めるため load の発火タイミングが読めず
    //   デッドロックしやすい。「alert を待つ → 後続要素を待つ」の順に分ける
    await page.waitForSelector(SEL.completedPanel, { state: 'visible', timeout: 15000 });
  } finally {
    await page.close();
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// ダイアログ（confirm / alert / prompt）
// ---------------------------------------------------------------------------

// ★ハンドラ未登録だと k6 はダイアログを自動 dismiss する（confirm がキャンセル扱い）。
//   クリックより前に、ページごとに登録すること。サブウィンドウにも個別に必要
function attachDialogHandler(page, dialogs, { promptText = '' } = {}) {
  page.on('dialog', async (dialog) => {
    const type = dialog.type();          // 'alert' | 'confirm' | 'prompt' | 'beforeunload'
    const message = dialog.message();
    dialogs.push({ type, message, at: Date.now() });
    console.log(`[dialog] ${type}: ${message}`);

    // ★必ず accept() か dismiss() を呼ぶ。呼ばないと画面が固まりタイムアウトする
    if (type === 'prompt') {
      await dialog.accept(promptText);
    } else {
      await dialog.accept();             // confirm は OK、alert は閉じる
    }
    // キャンセル側をテストするなら → await dialog.dismiss();
  });
}

// 指定した種類・メッセージのダイアログが出るまで待つ
async function waitForDialog(page, dialogs, { type, match, timeout = 30000 }) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const hit = dialogs.find(
      (d) => d.type === type && (!match || match.test(d.message))
    );
    if (hit) return hit;
    await page.waitForTimeout(200);
  }
  return null;
}

// ---------------------------------------------------------------------------
// ドロップダウン
// ---------------------------------------------------------------------------

// 表示テキストの部分一致で選択する
// （label 指定は前後空白を除いた完全一致のため、コード前置や &nbsp; インデントに弱い）
async function selectByPartialText(page, selector, text) {
  const value = await page.evaluate(
    ({ sel, t }) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const opt = Array.from(el.options).find((o) => o.textContent.trim().includes(t));
      return opt ? opt.value : null;
    },
    { sel: selector, t: text }
  );
  if (value === null) throw new Error(`option が見つかりません: ${text}`);
  await page.locator(selector).selectOption(value);
  return value;
}

// 現在選択されている項目の表示テキストを取得する
async function getSelectedText(page, selector) {
  return await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el || el.selectedIndex < 0) return '';
    return el.options[el.selectedIndex].text.trim();
  }, selector);
}

// ---------------------------------------------------------------------------
// 参考: selectOption の指定方法
//   await page.locator('#ddl').selectOption({ label: '大阪支店' });   // 表示テキスト（完全一致）
//   await page.locator('#ddl').selectOption('OSK');                   // value 属性
//   await page.locator('#ddl').selectOption({ index: 2 });            // インデックス
//   await page.locator('#ddl').selectOption([{ label: '至急' }, { label: '再送' }]); // 複数選択
//
// 注意: 上記が効くのは本物の <select> のときだけ。
//   <div> + JS の独自ドロップダウンはクリック2回で操作する
//     await page.locator('#ddl').click();
//     await page.getByText('大阪支店', { exact: true }).click();
// ---------------------------------------------------------------------------
