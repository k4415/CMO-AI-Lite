import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const promptsDir = path.join(appRoot, "config", "prompts");

// システムプロンプトの正はここ(config/prompts/*.md)。UIからの生成もエージェントの
// サブスク実行モードも同じファイルを読む前提のため、内容はtrimせずそのまま返す
// (先頭末尾の改行差だけは許容範囲として扱う)。
export function loadPrompt(name) {
  const filePath = path.join(promptsDir, `${name}.md`);
  return fs.readFileSync(filePath, "utf8");
}
