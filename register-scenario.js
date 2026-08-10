// ============================================================================
// k6 browser モード サンプル（修正版）
//   ・ドロップダウンリストを表示テキストで選択（ポストバック対応）
//   ・登録ボタン → confirm で OK → 登録完了 alert を待機
//
// 【重要】k6 browser の page.on() は 'dialog' に対応していない。
//   サポートされるのは console / metric / request / requestfinished /
//   requestfailed / response のみ。'dialog' を渡すと
//     GoError: unknown page on event: "dialog"
//   となる。さらに k6 はネイティブダイアログを自動 dismiss するため、
//   何もしないと confirm は常にキャンセル扱いになる。
//   → context.addInitScript() で window.confirm/alert/prompt を
//     スタブに差し替えて制御する。
//
// 実行:
//   k6 run register-scenario.js
//   K6_BROWSER_HEADLESS=false k6 run register-scenario.js
//   BASE_URL=https://your-app.example.com k6 run register-scenario.js
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

const DIALOG_KEY = '__k6_dialogs';

// ---------------------------------------------------------------------------
// メインシナリオ
// ---------------------------------------------------------------------------
export default async function () {
  const context = await browser.newContext();

  // ★ページの JS が動く前にダイアログ関数を差し替える。
  //   同じ context で開くサブウィンドウにも適用される
  await installDialogStubs(context, { confirmResult: true });

  const page = await context.newPage();

  try {
    await page.goto(`${BASE_URL}/order/entry`, { waitUntil: 'networkidle' });

    // 前ページの記録が残らないようクリアしておく
    await clearDialogs(page);

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

    // ---- 登録ボタンクリック → confirm はスタブが true を返す ----
    await page.locator(SEL.registerButton).click();

    // ---- 登録完了 alert を待機 ----
    const done = await waitForDialog(page, {
      type: 'alert',
      match: /登録が完了しました/,
      timeout: 30000,
    });

    check(done, {
      '登録完了の alert が表示された': (d) => d !== null,
    });

    const all = await readDialogs(page);
    check(all.filter((d) => d.type === 'confirm').length, {
      '確認 confirm が1回表示された': (n) => n === 1,
    });

    // ---- 後続画面を確認 ----
    // ※ スタブ化により alert は画面をブロックしないため、
    //   実ブラウザより早く後続処理が進む点に注意
    await page.waitForSelector(SEL.completedPanel, { state: 'visible', timeout: 15000 });
  } finally {
    await page.close();
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// ダイアログのスタブ化と検証
// ---------------------------------------------------------------------------

// window.confirm / alert / prompt を差し替え、呼び出し内容を記録させる。
// ★記録先が sessionStorage なのは、addInitScript がナビゲーションのたびに
//   再実行されるため。window 変数だとポストバックで消える
async function installDialogStubs(context, { confirmResult = true, promptText = '' } = {}) {
  await context.addInitScript(
    ({ key, confirmResult, promptText }) => {
      const rec = (type, message) => {
        const list = JSON.parse(sessionStorage.getItem(key) || '[]');
        list.push({ type, message: String(message), at: Date.now() });
        sessionStorage.setItem(key, JSON.stringify(list));
      };
      window.confirm = (msg) => { rec('confirm', msg); return confirmResult; };
      window.alert = (msg) => { rec('alert', msg); };
      window.prompt = (msg, def) => { rec('prompt', msg); return promptText || def || ''; };
      // 注意: beforeunload はこの方法では制御できない
    },
    { key: DIALOG_KEY, confirmResult, promptText }
  );
}

// 記録されたダイアログ一覧を取得する
async function readDialogs(page) {
  return await page.evaluate(
    (key) => JSON.parse(sessionStorage.getItem(key) || '[]'),
    DIALOG_KEY
  );
}

// 記録をクリアする（画面遷移の区切りで呼ぶ）
async function clearDialogs(page) {
  await page.evaluate((key) => sessionStorage.removeItem(key), DIALOG_KEY);
}

// 指定した種類・メッセージのダイアログが記録されるまで待つ
async function waitForDialog(page, { type, match, timeout = 30000 }) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const list = await readDialogs(page);
    const hit = list.find(
      (d) => d.type === type && (!match || match.test(d.message))
    );
    if (hit) {
      console.log(`[dialog] ${hit.type}: ${hit.message}`);
      return hit;
    }
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
// 参考: confirm でキャンセルを選ぶケースをテストしたい場合
//   installDialogStubs(context, { confirmResult: false }) で別 context を作るか、
//   テスト途中で page.evaluate(() => { window.confirm = () => false; }) で上書きする
//
// 参考: context.addInitScript が使えない k6 バージョンの場合
//   page.goto() 直後に page.evaluate() でスタブを注入する。ただし
//   アプリ JS より後に走るため、読み込み時に出るダイアログは捕捉できず、
//   ナビゲーションのたびに再注入が必要
// ---------------------------------------------------------------------------
