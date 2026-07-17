export const resolveContextAction = {
  id: "project.resolve_context",
  skillId: "system.context-resolver",
  phase: "案件準備",
  name: "案件コンテキスト確認",
  description: "ローカル案件フォルダから、AIスキル実行に必要な入力・中間成果物・注意事項を読み込みます。",
  reads: [
    "project.json",
    "inputs/product.md",
    "inputs/notes.md",
    "inputs/source-urls.md",
    "research/facts.md",
    "strategy/who-what.md",
    "regulations/expression-rules.md"
  ],
  writes: [],
  requiresReview: false,
  async handler({ context }) {
    return {
      status: "ready",
      data: {
        project: context.project,
        warnings: context.warnings,
        documentLengths: Object.fromEntries(
          Object.entries(context.documents).map(([key, value]) => [key, value.length])
        )
      },
      nextActions: ["research.extract_facts", "strategy.create_who_what"]
    };
  }
};
