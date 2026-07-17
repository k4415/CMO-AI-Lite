import { openAiVisionText } from "./openai-text.js";

// 表現レギュレーション等の取り込み用ファイルからテキストを抽出する。
// - テキスト系(txt/csv/md/json): そのままデコード
// - 画像(png/jpg/webp…): OpenAI vision で文字起こし
// - PDF: pdf-parse でテキスト抽出(画像のみPDFは取れないことがある)
// - Excel(xlsx/xls): SheetJS でシートをCSV化
// - Word(docx): mammoth で本文抽出
// 重いパーサは必要になったときだけ動的 import する(サーバー起動を軽く保つ)。

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp"]);
const TEXT_EXT = new Set(["txt", "csv", "tsv", "md", "markdown", "json", "log", "yaml", "yml"]);

const VISION_SYSTEM = "画像に写っている文字を、表現レギュレーション(NG表現・推奨表現・注記・法務/薬機・景表ルール)として使えるよう、見えている順に正確に書き起こしてください。表や箇条書きは構造を保ち、装飾や推測は加えず記載された文言をそのまま書き出す。";

export async function extractTextFromFile({ fileName = "", mimeType = "", dataBase64 = "", projectRoot } = {}) {
  const base64 = String(dataBase64 || "").replace(/^data:[^;]+;base64,/, "");
  if (!base64) throw new Error("ファイルデータが空です。");
  const buffer = Buffer.from(base64, "base64");
  const ext = String(fileName || "").split(".").pop().toLowerCase();
  const mime = String(mimeType || "").toLowerCase();

  // テキスト系
  if (TEXT_EXT.has(ext) || mime.startsWith("text/") || mime === "application/json") {
    return { text: buffer.toString("utf8"), method: "text" };
  }

  // 画像: OpenAI vision で文字起こし
  if (IMAGE_EXT.has(ext) || mime.startsWith("image/")) {
    const dataUrl = `data:${mime || "image/png"};base64,${base64}`;
    const text = await openAiVisionText({
      image: dataUrl,
      projectRoot,
      system: VISION_SYSTEM,
      text: "この画像の内容を、上から順にそのまま文字起こししてください。"
    });
    return { text: String(text || "").trim(), method: "vision" };
  }

  // PDF
  if (ext === "pdf" || mime === "application/pdf") {
    const { PDFParse } = await loadParser("pdf-parse", "PDF");
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      const text = String(result?.text || "").trim();
      // テキストが取れた場合はそれを返す。画像のみのPDFは空になり得る。
      return { text, method: text ? "pdf" : "pdf-empty" };
    } finally {
      try { await parser.destroy?.(); } catch { /* noop */ }
    }
  }

  // Excel / スプレッドシート
  if (["xlsx", "xls", "xlsm", "ods"].includes(ext) || mime.includes("spreadsheet") || mime.includes("excel") || mime.includes("ms-excel")) {
    const xlsx = await loadParser("xlsx", "Excel");
    let wb;
    try {
      wb = xlsx.read(buffer, { type: "buffer" });
    } catch (error) {
      throw new Error("Excelファイルを読み込めませんでした。ファイルが破損しているか、パスワード保護されている可能性があります。詳細: " + error.message);
    }
    const parts = [];
    for (const name of wb.SheetNames) {
      const csv = xlsx.utils.sheet_to_csv(wb.Sheets[name]).trim();
      if (csv) parts.push(`# ${name}\n${csv}`);
    }
    const text = parts.join("\n\n");
    if (!text) throw new Error("Excelから読み取れるテキストがありませんでした。シートが空か、内容が画像のみの可能性があります。");
    return { text, method: "xlsx" };
  }

  // Word docx
  if (ext === "docx" || mime.includes("wordprocessingml")) {
    const mammoth = await loadParser("mammoth", "Word");
    const extractRawText = mammoth.default?.extractRawText || mammoth.extractRawText;
    const result = await extractRawText({ buffer });
    return { text: String(result?.value || "").trim(), method: "docx" };
  }

  throw new Error("未対応のファイル形式です: " + (ext || mime || "unknown") + "(対応: PDF / Excel / Word(docx) / テキスト / 画像)");
}

// 重いパーサを動的importする。未導入(npm install漏れ等)のときは、原因が分かる
// 日本語メッセージにして投げ直す(生のMODULE_NOT_FOUNDだと原因が伝わりにくいため)。
async function loadParser(moduleName, label) {
  try {
    return await import(moduleName);
  } catch (error) {
    throw new Error(`${label}の読み込みに必要な依存(${moduleName})が見つかりません。プロジェクト直下で "npm install" を実行してください。詳細: ${error.message}`);
  }
}
