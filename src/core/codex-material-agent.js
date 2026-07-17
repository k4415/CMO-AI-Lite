import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = Number(process.env.CMOAI_CODEX_AGENT_TIMEOUT_MS || process.env.CMOAI_AGENT_TIMEOUT_MS || 30 * 60 * 1000);

export async function transcribeMaterialWithCodex(projectRoot, material, context = {}) {
  return transcribeMaterialWithAgent(projectRoot, material, { ...context, provider: "codex" });
}

export async function transcribeMaterialWithAgent(projectRoot, material, context = {}) {
  const provider = normalizeProvider(context.provider || process.env.CMOAI_MATERIAL_AGENT || "codex");
  const jobRoot = path.join(projectRoot, "outputs", "material-agent-jobs", material.id);
  await fs.rm(jobRoot, { recursive: true, force: true }).catch(() => null);
  await fs.mkdir(jobRoot, { recursive: true });

  const inputPath = path.join(jobRoot, "input.json");
  const promptPath = path.join(jobRoot, "prompt.md");
  const outputPath = path.join(jobRoot, "output.md");
  const resultPath = path.join(jobRoot, "result.json");
  const logPath = path.join(jobRoot, "run.log");
  const lastMessagePath = path.join(jobRoot, "last-message.md");
  const readerPath = path.join(jobRoot, "read-input.mjs");
  const agentOutputPath = path.join(projectRoot, `${material.id}-agent-output.md`);
  const agentResultPath = path.join(projectRoot, `${material.id}-agent-result.json`);
  const agentLastMessagePath = path.join(projectRoot, `${material.id}-agent-last-message.md`);
  const outputRelativePath = relative(projectRoot, agentOutputPath);
  const resultRelativePath = relative(projectRoot, agentResultPath);
  const readerRelativePath = relative(projectRoot, readerPath);
  await fs.rm(agentOutputPath, { force: true }).catch(() => null);
  await fs.rm(agentResultPath, { force: true }).catch(() => null);
  await fs.rm(agentLastMessagePath, { force: true }).catch(() => null);

  const screenshotPaths = (material.screenshotUrls || []).map((url) => resolveProjectFile(projectRoot, url));
  const missingScreenshots = [];
  for (const screenshotPath of screenshotPaths) {
    const stat = await fs.stat(screenshotPath).catch(() => null);
    if (!stat?.isFile() || stat.size <= 0) missingScreenshots.push(relative(projectRoot, screenshotPath));
  }
  if (missingScreenshots.length) {
    throw new Error(`Screenshot files are missing or empty: ${missingScreenshots.slice(0, 5).join(", ")}${missingScreenshots.length > 5 ? " ..." : ""}`);
  }
  const input = {
    provider,
    materialId: material.id,
    title: material.title || "",
    sourceUrl: material.sourceUrl || "",
    projectRoot,
    jobRoot,
    outputPath: agentOutputPath,
    outputRelativePath,
    resultPath: agentResultPath,
    resultRelativePath,
    screenshotPaths,
    htmlTextPath: "",
    htmlTextRelativePath: "",
    readerRelativePath,
    htmlTextAvailable: Boolean(context.htmlText)
  };
  if (context.htmlText) {
    input.htmlTextPath = path.join(jobRoot, "html-text.md");
    input.htmlTextRelativePath = relative(projectRoot, input.htmlTextPath);
    await fs.writeFile(input.htmlTextPath, context.htmlText, "utf8");
  }

  await fs.writeFile(inputPath, JSON.stringify(input, null, 2) + "\n", "utf8");
  await fs.writeFile(readerPath, buildReaderScript(inputPath), "utf8");
  await fs.writeFile(promptPath, buildPrompt(input), "utf8");

  const run = await runAgent({
    provider,
    projectRoot,
    promptPath,
    outputLastMessagePath: agentLastMessagePath,
    logPath,
    imagePaths: screenshotPaths,
    timeoutMs: DEFAULT_TIMEOUT_MS
  });

  const result = await readJsonIfExists(agentResultPath) || await readJsonIfExists(resultPath);
  const output = await readTextIfExists(agentOutputPath) || await readTextIfExists(outputPath);
  await copyIfExists(agentOutputPath, outputPath);
  await copyIfExists(agentResultPath, resultPath);
  await copyIfExists(agentLastMessagePath, lastMessagePath);
  const finalText = String(result?.transcript || output || "").trim();
  if (!run.ok && !finalText) {
    throw new Error(`${providerLabel(provider)} failed: ${run.error || `exit ${run.exitCode}`}\nlog: ${relative(projectRoot, logPath)}`);
  }
  if (!finalText) {
    throw new Error(`${providerLabel(provider)} returned empty transcript. log: ${relative(projectRoot, logPath)}`);
  }
  const quality = transcriptQuality(finalText);
  if (!quality.ok) {
    throw new Error(`${providerLabel(provider)} returned unusable transcript: ${quality.reason}. log: ${relative(projectRoot, logPath)}`);
  }

  return {
    text: finalText,
    summary: result?.summary || `${providerLabel(provider)} agent completed. log: ${relative(projectRoot, logPath)}`,
    method: provider + "_agent",
    provider,
    jobRoot,
    outputPath,
    resultPath,
    logPath,
    steps: Array.isArray(result?.steps) ? result.steps : [],
    warning: run.ok ? "" : `${providerLabel(provider)} reported ${run.error || `exit ${run.exitCode}`}, but transcript output was recovered.`
  };
}

function buildPrompt(input) {
  const screenshotList = input.screenshotPaths.length
    ? input.screenshotPaths.map((item, index) => `${index + 1}. ${item}`).join("\n")
    : "none";
  return `あなたはCMOAIのLP文字起こし専用エージェントです。

対象LPを、上から下まで、表示される順番のまま文字起こししてください。
スクリーンショット画像の中に見える文字も徹底的に書き起こしてください。
HTML本文は補助情報です。HTMLにある本文だけで済ませず、必ずスクリーンショットを上から順に確認し、画像内テキスト・固定バナー・ポップアップ・ボタン・フォーム文言まで拾ってください。

入力:
- Provider: ${input.provider}
- Source URL: ${input.sourceUrl}
- Material ID: ${input.materialId}
- Material title: ${input.title}
- HTML text file: ${input.htmlTextRelativePath || "none"}
- UTF-8 input reader: ${input.readerRelativePath}
- Screenshots:
${screenshotList}

必須出力:
- Markdown transcript: ${input.outputRelativePath}
- Result JSON: ${input.resultRelativePath}

実行ルール:
- Windows/macOS両対応。OS固有のシェル挙動に依存しないこと。
- WindowsではPowerShell Get-Content/typeがUTF-8日本語を文字化けさせることがあります。入力確認は必ず次で読むこと:
  node "${input.readerRelativePath}"
- 出力は必ず上記の相対パスへ書くこと。絶対パス C:\\... には書かないこと。
- Windows sandboxではapply_patchで新規ファイル作成に失敗する場合があります。出力ファイルの作成は Node.js fs.writeFileSync / fs.writeFile、または PowerShell Set-Content -Encoding utf8 を使うこと。
- 対象URL、HTML text file、添付スクリーンショットだけを使うこと。広範なWeb調査は禁止。
- 何かが読めない場合は、推測せず [判読不能] と書くこと。
- 推測サンプル生成は禁止。対象LPに表示されている内容のみを書き起こすこと。

【文字起こしルール】
- テキストは表示されている通りに書き起こす。要約・言い換えは禁止。
- 画像/GIF/動画がある箇所は【画像】【GIF】【動画】と明記し、その中に見える内容をすべて書き起こす。
- ボタンやリンクは【ボタン：...】【リンク：...】と記載する。
- 改行区切り、色強調、太字、下線、赤字などもわかる範囲で再現する。
- 分析、解釈、役割説明は一切不要。
- Section分けや項目名（見出し、本文、CTAなど）のラベル付けは禁止。ただし画面上に実際に表示されている文言ならそのまま書く。
- 出力は、上から順番に、見たままをそのまま羅列する。

出力例の形式:
---
PR
【画像】白衣の女性、頭頂部ビフォーアフター写真、「NHKでも特集」の文字、アマギフ2000円分の券面

一回限り 初回 実質無料
アマギフ 2000円分プレゼント!!

自宅でバレずに薄毛卒業
---
【画像】手のひらに乗った抜け毛、「今日もこんなに...」の文字

鏡を見るたびにショック
「最近、地肌が透けて見える」
...
---

Result JSON shape:
{
  "status": "completed",
  "method": "${input.provider}_agent",
  "sourceUrl": "${input.sourceUrl}",
  "summary": "LPを上から下まで、画像内文字を含めて表示順に文字起こししました。",
  "transcript": "output.mdと同じ全文",
  "steps": ["実行した短い手順"],
  "errors": []
}

失敗した場合でも、可能な範囲の transcript を output.md に書き、result.json に status "failed" と errors を書くこと。
`;
}

function buildReaderScript(inputPath) {
  return `import fs from "node:fs";
const input = JSON.parse(fs.readFileSync(${JSON.stringify(inputPath)}, "utf8"));
const htmlText = input.htmlTextPath ? fs.readFileSync(input.htmlTextPath, "utf8") : "";
console.log(JSON.stringify({ input, htmlText }, null, 2));
`;
}

function runAgent({ provider, projectRoot, promptPath, outputLastMessagePath, logPath, imagePaths = [], timeoutMs }) {
  return new Promise((resolve) => {
    const spec = provider === "claude"
      ? claudeCommand({ imagePaths })
      : codexCommand({ projectRoot, outputLastMessagePath, imagePaths });
    const child = spawn(spec.file, spec.args, {
      cwd: projectRoot,
      shell: false,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: "1" }
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessTree(child)
        .finally(() => writeLog(logPath, stdout, stderr + `\nAgent timed out after ${timeoutMs}ms\n`))
        .finally(() => resolve({ ok: false, exitCode: null, error: `timeout after ${Math.round(timeoutMs / 1000)}s` }));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      writeLog(logPath, stdout, stderr + "\n" + error.stack).finally(() => {
        resolve({ ok: false, exitCode: null, error: error.message });
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      writeLog(logPath, stdout, stderr).finally(() => {
        resolve({ ok: code === 0, exitCode: code, error: code === 0 ? "" : stderr.trim() || stdout.trim() });
      });
    });

    fs.readFile(promptPath, "utf8")
      .then((prompt) => {
        child.stdin.write(prompt);
        child.stdin.end();
      })
      .catch((error) => {
        stderr += "\nPrompt read failed: " + error.message;
        child.stdin.end();
      });
  });
}

function codexCommand({ projectRoot, outputLastMessagePath, imagePaths }) {
  const bin = codexBinPath();
  const file = bin ? process.execPath : (process.env.CODEX_BIN || "codex");
  const args = bin ? [bin] : [];
  args.push("exec", "--sandbox", "workspace-write", "--cd", projectRoot, "--skip-git-repo-check", "--output-last-message", outputLastMessagePath);
  for (const imagePath of imagePaths.filter(Boolean)) args.push("--image", imagePath);
  args.push("-");
  return { file, args };
}

function claudeCommand({ imagePaths }) {
  const args = ["--print", "--permission-mode", "acceptEdits", "--input-format", "text", "--output-format", "text"];
  for (const imagePath of imagePaths.filter(Boolean)) args.push("--image", imagePath);
  args.push("-");
  return { file: process.env.CLAUDE_BIN || "claude", args };
}

function codexBinPath() {
  if (process.env.CODEX_BIN_JS) return process.env.CODEX_BIN_JS;
  if (process.env.APPDATA) return path.join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
  return "";
}

function killProcessTree(child) {
  return new Promise((resolve) => {
    if (!child?.pid) return resolve();
    if (process.platform === "win32") {
      execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => resolve());
      return;
    }
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    resolve();
  });
}

async function writeLog(logPath, stdout, stderr) {
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.writeFile(logPath, ["# stdout", stdout || "", "", "# stderr", stderr || ""].join("\n"), "utf8");
}

function normalizeProvider(value) {
  const provider = String(value || "").toLowerCase();
  return provider === "claude" ? "claude" : "codex";
}

function providerLabel(provider) {
  return provider === "claude" ? "Claude" : "Codex";
}

function transcriptQuality(value) {
  const text = String(value || "");
  const chars = Math.max(text.length, 1);
  const questionCount = (text.match(/\?/g) || []).length;
  const mojibakeCount = (text.match(/[縺繧譁蜒譛螟荳豌蛻鬆驕謗]/g) || []).length;
  const replacementCount = (text.match(/\uFFFD/g) || []).length;
  const questionRatio = questionCount / chars;
  const mojibakeRatio = mojibakeCount / chars;
  if (text.length < 200) return { ok: false, reason: "too short" };
  if (questionCount > 80 && questionRatio > 0.08) return { ok: false, reason: `too many question marks (${questionCount})` };
  if (mojibakeCount > 80 && mojibakeRatio > 0.06) return { ok: false, reason: `mojibake detected (${mojibakeCount})` };
  if (replacementCount > 10) return { ok: false, reason: `replacement characters detected (${replacementCount})` };
  return { ok: true, reason: "" };
}

function resolveProjectFile(projectRoot, src) {
  const raw = String(src || "");
  let relativePath = raw;
  if (raw.startsWith("/project-file")) {
    const url = new URL(raw, "http://localhost");
    relativePath = url.searchParams.get("path") || "";
  } else if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    relativePath = url.searchParams.get("path") || url.pathname;
  }
  return path.resolve(projectRoot, relativePath.replace(/^[/\\]+/, ""));
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function copyIfExists(sourcePath, targetPath) {
  try {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);
  } catch {
    // Optional audit copy. The transcript has already been read from sourcePath.
  }
}

function relative(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}
