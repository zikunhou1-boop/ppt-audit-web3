// pages/api/ai_review.js
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return res.status(500).json({ ok: false, error: "Missing env: DEEPSEEK_API_KEY" });

    const body = req.body || {};
    const mode = body.mode === "report" ? "report" : "legacy";

    // legacy
    const text = typeof body.text === "string" ? body.text : null;
    const review = Array.isArray(body.review) ? body.review : null;

    // report
    const pagesText = typeof body.pagesText === "string" ? body.pagesText : "";
    const audit = body.audit && typeof body.audit === "object" ? body.audit : null;
    const rulesJson = typeof body.rulesJson === "string" ? body.rulesJson : "";

    if (mode === "legacy") {
      if (typeof text !== "string" || !Array.isArray(review)) {
        return res.status(400).json({ ok: false, error: "legacy mode requires text(string) and review(array)" });
      }
    } else {
      if (!audit) return res.status(400).json({ ok: false, error: "report mode requires audit(object)" });
    }

    // ====== 强制“像 AI”的 system prompt（必须给 quote/before/after，不能写缺失/无） ======
    const system_report = `
你是保险课件/宣传材料合规复审助手。你要在规则初审(audit)基础上复核，并输出结构化融合结果。

硬性要求（必须遵守）：
1) 不得推翻 audit.pass / audit.risk_level，仅做复核与改写。
2) rules_issues_fix 必须逐条对应 audit.issues（数量不得少于 audit.issues 条数）。
3) 每条 rules_issues_fix 必须给 quote（必须来自给你的“命中页原文”），不得为空。
4) rewrite[0].before 必须等于 quote 中的一句（或其精简），不得为空、不得写“缺失/无”。
5) rewrite[0].after 必须是可直接替换进课件的具体句子（可粘贴），不得只写原则/口径。
6) 额外语义风险放 ai_extra，不能混入 rules_issues_fix。

输出必须是严格 JSON（不能有任何多余文字），格式：
{
  "ok": true,
  "rules_issues_fix": [
    {
      "rule_id": "6-01",
      "page": 1,
      "quote": ["..."],
      "problem": "...",
      "rewrite": [{ "action": "替换/删除/补充", "before": "...", "after": "..." }],
      "note": ""
    }
  ],
  "ai_extra": [],
  "final_summary": { "overall": "", "top_risks": [], "next_actions": [] }
}
`.trim();

    const system_legacy = `
你是保险宣传/课件材料合规审核助手。输出必须是严格 JSON：
{ "ai": [ { "rule_id": "...", "verdict": "...", "quote": [], "problem": "", "rewrite_suggestion": [{ "action": "", "before": "", "after": "" }], "notes": "" } ] }
`.trim();

    // ====== report 模式：自动“瘦身”输入（避免慢/超时/不稳定） ======
    const issues = Array.isArray(audit?.issues) ? audit.issues : [];

    // 只取前 10 条 issue（太多会慢；后续你要全量可做分页/批处理）
    const issuesSlim = issues.slice(0, 10).map((it) => ({
      rule_id: it.rule_id,
      page: it.page ?? null,
      message: it.message || it.problem || it.reason || "",
      suggestion: it.suggestion || ""
    }));

    // 从 pagesText 里按“【第X页】”切块，抽取命中页内容，每页最多 1500 字
    function pickPageBlock(all, pageNo) {
      if (pageNo == null) return "";
      const marker = `【第${pageNo}页】`;
      const idx = all.indexOf(marker);
      if (idx < 0) return "";
      const nextIdx = all.indexOf("【第", idx + marker.length);
      const block = nextIdx < 0 ? all.slice(idx) : all.slice(idx, nextIdx);
      return block.slice(0, 1500);
    }

    const pageBlocks = issuesSlim
      .map((it) => pickPageBlock(pagesText || "", it.page))
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 12000); // 总长度再兜底

    // rulesJson 只给摘要，避免巨大
    const rulesSlim = (rulesJson || "").slice(0, 2000);

    let system = mode === "report" ? system_report : system_legacy;
    let user =
      mode === "report"
        ? `
【命中页原文（仅抽取命中页）】
${pageBlocks}

【规则初审 issues（已瘦身）】
${JSON.stringify(issuesSlim, null, 2)}

【规则库摘要（截断）】
${rulesSlim}
`.trim()
        : `
【材料文本】
${text}

【复核项】
${JSON.stringify(review, null, 2)}
`.trim();

    // ====== 调 DeepSeek（带超时） ======
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 55000);

    let raw = "";
    let httpStatus = 0;

    try {
      const resp = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: "deepseek-chat",
          messages: [
            { role: "system", content: system },
            { role: "user", content: user }
          ],
          temperature: 0.1
        }),
        signal: controller.signal
      });

      httpStatus = resp.status;
      raw = await resp.text();

      if (!resp.ok) {
        return res.status(200).json({
          ok: false,
          error: "DeepSeek API error",
          http_status: httpStatus,
          raw: raw.slice(0, 2000)
        });
      }
    } catch (e) {
      return res.status(200).json({
        ok: false,
        error: "Fetch DeepSeek failed (timeout or network)",
        detail: String(e),
        http_status: httpStatus || 0
      });
    } finally {
      clearTimeout(t);
    }

    // ====== 解析 DeepSeek 返回（容错：模型不是严格 JSON 时提取大括号） ======
    function extractJsonObject(s) {
      if (typeof s !== "string") return null;
      const first = s.indexOf("{");
      const last = s.lastIndexOf("}");
      if (first >= 0 && last > first) return s.slice(first, last + 1);
      return null;
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return res.status(200).json({ ok: false, error: "DeepSeek returned non-JSON envelope", raw: raw.slice(0, 2000) });
    }

    const content = data?.choices?.[0]?.message?.content || "";
    let parsed = null;

    try {
      parsed = JSON.parse(content);
    } catch {
      const cut = extractJsonObject(content);
      if (cut) {
        try {
          parsed = JSON.parse(cut);
        } catch {
          parsed = null;
        }
      }
    }

    // ====== 最终兜底：永远返回 report 结构（但 ok=false 表示 AI 没真正产出） ======
    if (!parsed || typeof parsed !== "object") {
      return res.status(200).json({
        ok: false,
        error: "Model content is not valid JSON",
        http_status: httpStatus,
        content_preview: String(content).slice(0, 1200)
      });
    }

    if (mode === "report") {
      if (!Array.isArray(parsed.rules_issues_fix)) parsed.rules_issues_fix = [];
      if (!Array.isArray(parsed.ai_extra)) parsed.ai_extra = [];
      if (!parsed.final_summary || typeof parsed.final_summary !== "object") {
        parsed.final_summary = { overall: "", top_risks: [], next_actions: [] };
      }
      parsed.ok = true;
      return res.status(200).json(parsed);
    } else {
      if (!Array.isArray(parsed.ai)) parsed.ai = [];
      return res.status(200).json({ ok: true, ...parsed });
    }
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e), stack: e?.stack });
  }
}
