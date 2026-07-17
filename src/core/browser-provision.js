import os from "node:os";
import path from "node:path";
import { install, resolveBuildId, detectBrowserPlatform, Browser, getInstalledBrowsers } from "@puppeteer/browsers";
import { saveChromePath } from "./settings-store.js";

// スクショ取得用のChrome(Chrome for Testing)を、ユーザーがブラウザを別途インストールしなくても
// CMOAI側で調達できるようにするモジュール。@puppeteer/browsers でローカルキャッシュに落とし、
// 解決した実行ファイルパスを設定に保存する。以後 findChromeExecutable がそのパスを使う。
const CACHE_DIR = path.join(os.homedir() || process.cwd(), ".cache", "cmoai", "browsers");

export function browserCacheDir() {
  return CACHE_DIR;
}

// すでに調達済みのChromeがあればそのパスを返す(再ダウンロード回避)。
export async function findInstalledChrome() {
  try {
    const installed = await getInstalledBrowsers({ cacheDir: CACHE_DIR });
    const chrome = installed.find((item) => item.browser === Browser.CHROME || item.browser === Browser.CHROMIUM);
    return chrome ? chrome.executablePath : "";
  } catch {
    return "";
  }
}

export async function installChromeBrowser({ onProgress } = {}) {
  const platform = detectBrowserPlatform();
  if (!platform) throw new Error("この環境ではブラウザのプラットフォームを判定できませんでした。");
  const existing = await findInstalledChrome();
  if (existing) {
    await saveChromePath(existing);
    return { executablePath: existing, platform, reused: true };
  }
  const buildId = await resolveBuildId(Browser.CHROME, platform, "stable");
  const installed = await install({
    browser: Browser.CHROME,
    buildId,
    cacheDir: CACHE_DIR,
    downloadProgressCallback: typeof onProgress === "function" ? onProgress : undefined
  });
  await saveChromePath(installed.executablePath);
  return { executablePath: installed.executablePath, buildId, platform, reused: false };
}
