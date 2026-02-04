import fs from "fs";
import path from "path";

function readRulesText() {
  const p = path.join(process.cwd(), "rules", "rules.json");
  return fs.readFileSync(p, "utf-8");
}

function toText(pages) {
  return (pages || [])
    .map((p) => `【第${p.page}页】\n${p.content || ""}`.trim())
    .join("\n\n");
}

function groupIssues(issues) {
  const byRule = {};
  for (const it of issues || []) {
    const k = it.rule_id || "unknown";
    if (!byRule[k]) byRule[k] = [];
    byRule[k].push(it);
  }
  return byRule;
}

function riskScore(issue) {
  const s = issue.severity;
  if (s === "high") return 3;
  if (s === "medium") return 2;
  return 1;
}

function formatRulesBlock(rulesJsonStr) {
  // 给 AI 用：只截规则中最重要的字段，减少 token
  try {
    const obj = JSON.parse(rulesJsonStr);
    const rules = (obj.rules || []).map((r) => ({
      id: r.id,
      severity: r.severity,
      title: r.title,
      instruction: r.instruction,
      auto_checks: r.auto_checks,
      review_points: r.review_points
    }));
    return JSON.stringify({ version: obj.version, rules }, null, 2);
  } catch {
    return rulesJsonStr;
  }
}

async function callAI({ pagesText, rulesJson, audit }) {
  // 这里调用你已有的 AI 接口（同域调用），不用你改 key/部署逻辑
  // 你项目里如果 AI 接口叫 /api/ai，就保持不动
  const resp = await fetch(process.env.BASE_URL + "/api/ai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: "report",
      pagesText,
      rulesJson,
      audit
    })
  });

  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: "AI 返回不是 JSON", raw: text };
  }
}

function buildReadableReport({ pages_count, audit, ai }) {
  const pass = audit?.pass;
  const risk = audit?.risk_level || "unknown";
  const issues = audit?.issues || [];
  const byRule = groupIssues(issues);

  // 规则摘要：按严重度排序
  const sorted = [...issues].sort((a, b) => riskScore(b) - riskScore(a));

  const top = sorted.slice(0, 10).map((x) => ({
    page: x.page,
    rule_id: x.rule_id,
    severity: x.severity,
    message: x.message,
    suggestion: x.suggestion
  }));

  return {
    meta: {
      pages_count: pages_count || 0,
      rule_version: audit?.rule_version || "",
      rule_result: pass ? "通过" : "不通过",
      risk_level: risk
    },
    rule_hits_summary: top,
    rule_hits_by_rule: byRule,
    ai_review: ai || null
  };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

    const { pages, audit } = req.body || {};
    if (!Array.isArray(pages) || pages.length === 0) return res.status(400).json({ ok: false, error: "pages required" });
    if (!audit) return res.status(400).json({ ok: false, error: "audit required" });

    const rulesJsonStr = readRulesText();
    const pagesText = toText(pages);
    const rulesJson = formatRulesBlock(rulesJsonStr);

    // 这行需要你在 Vercel 配一个 BASE_URL（下面会教）
    const ai = await callAI({ pagesText, rulesJson, audit });

    const report = buildReadableReport({
      pages_count: pages.length,
      audit,
      ai
    });

    return res.status(200).json({ ok: true, report });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e), stack: e?.stack || "" });
  }
}
