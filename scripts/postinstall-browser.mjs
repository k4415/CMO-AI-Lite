// npm install 時にスクショ取得用ブラウザ(Chrome for Testing)を自動調達する postinstall スクリプト。
// - すでに使えるブラウザがあればダウンロードしない(2回目以降やChrome導入済み環境はスキップ)。
// - ダウンロード失敗やオフラインでも npm install 自体は失敗させない(常に exit 0)。
// - CMOAI_SKIP_BROWSER_INSTALL=1 でスキップ可能(CI・オフライン配布など)。
import process from "node:process";
import fs from "node:fs/promises";

async function main() {
  if (process.env.CMOAI_SKIP_BROWSER_INSTALL === "1") {
    console.log("[cmoai] CMOAI_SKIP_BROWSER_INSTALL=1 のためスクショ用ブラウザの自動調達をスキップします。");
    return;
  }

  // 既存のブラウザ(保存済みパス/CHROME_PATH/OS標準/同梱chromium)が見つかればダウンロード不要。
  try {
    const store = await import("../src/core/settings-store.js");
    const saved = await store.getChromePath().catch(() => "");
    if (saved) {
      try {
        await fs.access(saved);
        console.log("[cmoai] スクショ用ブラウザは調達済みです:", saved);
        return;
      } catch {}
    }
  } catch {}

  console.log("[cmoai] スクショ用ブラウザ(Chrome for Testing)を準備します… 初回のみ数十MBのダウンロードがあります。");
  try {
    const { installChromeBrowser } = await import("../src/core/browser-provision.js");
    const result = await installChromeBrowser();
    console.log(`[cmoai] スクショ用ブラウザを準備しました${result.reused ? "(既存を再利用)" : ""}: ${result.executablePath}`);
  } catch (error) {
    console.log("[cmoai] スクショ用ブラウザの自動準備に失敗しました(インストールは続行します)。");
    console.log("        ネットワーク接続後に npm run setup-browser で再実行できます。理由:", error?.message || error);
  }
}

// postinstall では何があってもインストール自体は成功させる(exit 0)。
main().catch(() => {}).finally(() => process.exit(0));
