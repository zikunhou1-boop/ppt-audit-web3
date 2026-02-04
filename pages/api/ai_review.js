export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing env: DEEPSEEK_API_KEY" });

    // 兼容两种输入：
    // A) 旧：{ text, review }
    // B) 新：{ pagesText, audit, rulesJson }
    const body = req.body || {};
    const text = typeof body.text === "string" ? body.text : null;
    const review = Array.isArray(body.review) ? body.review : null;

    const pagesText = typeof body.pagesText === "string" ? body.pagesText : null;
    const audit = body.audit && typeof body.audit === "object" ? body.audit : null;
    const rulesJson = typeof body.rulesJson === "string" ? body.rulesJson : null;

    const mode = body.mode === "report" ? "report" : "legacy";

    // 参数校验
    if (mode === "legacy") {
      if (typeof text !== "string" || !Array.isArray(review)) {
        return res.status(400).json({ error: "legacy mode requires text(string) and review(array)" });
      }
    } else {
      if (!pagesText || !audit || !rulesJson) {
        return res.status(400).json({ error: "report mode requires pagesText(string), audit(object), rulesJson(string)" });
      }
    }

    // ===== System Prompt（融合版：规则为准 + AI 可补充 ai_extra + 对 issues 给改写）=====
    const system_report = `
你是保险课件/宣传材料合规复审助手。你要在“规则初审(audit)”基础上复审全文，并产出结构化融合结果，供生成可读报告。

核心原则（必须遵守）：
1) 规则初审结论以 audit 为准：不要推翻 audit.pass / audit.risk_level。
2) 你的主要任务是：对 audit.issues 逐条输出可直接落地的改写建议（before/after），并补充必要的合规提示。
3) 你可以发现“规则未覆盖或规则漏检”的语义风险，但必须放到 ai_extra 数组，并清楚标注为 AI 发现；不得混入 rules_issues_fix。
4) 不要泛泛而谈，quote 必须来自原文；尽量提供可直接粘贴的 after 文案（短、可用、合规）。

输出必须是严格 JSON（不能有任何多余文字），格式如下：
{
  "ok": true,
  "rules_issues_fix": [
    {
      "rule_id": "6-01",
      "page": 1,
      "quote": ["原文片段(<=80字)"],
      "problem": "对应该 issue 的简短问题描述",
      "rewrite": [
        { "action": "替换/删除/补充", "before": "原句或缺失", "after": "改写后可直接粘贴文案" }
      ],
      "note": "如需补充口径/来源/时间/免责声明等，写这里"
    }
  ],
  "ai_extra": [
    {
      "severity": "high/medium/low",
      "page": 1,
      "problem": "AI 额外发现的问题（规则未覆盖/漏检）",
      "quote": ["原文片段(<=80字)"],
      "suggestion": "建议如何改（可直接粘贴的写法优先）"
    }
  ],
  "final_summary": {
    "overall": "一句话总体结论（不推翻 audit，仅总结）",
    "top_risks": ["最多3条关键风险"],
    "next_actions": ["最多3条下一步建议（可执行）"]
  }
}

约束：
- rules_issues_fix 必须严格对应 audit.issues（每条 issue 至少给 1 条 rewrite）。
- 不要输出 audit 中不存在的 rule_id 到 rules_issues_fix。
- quote 最多 3 条，每条 <=80字。
- rewrite 至少 1 条、最多 3 条，每条必须给 after。
`.trim();

    // ===== System Prompt（旧版：对 review 输出 before/after）=====
    const system_legacy = `
你是保险宣传/课件材料合规审核助手。你的任务：依据给定“复核项(review)”对材料文本进行复核，并输出可直接落地修改的结果。

硬性要求：
1) 必须定位到原文句子或短语（quote）。
2) 尽量保留事实数据；如保留数据，必须避免不当对比/排序/评比、制造紧迫感、保证承诺、绝对化用语；必要时补充数据口径/来源/时间。
3) 每个 rule_id 输出一条结果：verdict + quote + problem + rewrite_suggestion（before/after）。
4) 输出必须是严格 JSON，结构如下：
{
  "ai": [
    {
      "rule_id": "6-03",
      "verdict": "违规/可能违规/不违规/不确定",
      "quote": ["原文片段1","原文片段2"],
      "problem": "为什么可能违规（对应规则点，简短）",
      "rewrite_suggestion": [
        { "action": "删除/替换/补充", "before": "原句或缺失", "after": "改写句" }
      ],
      "notes": "如需补充来源/时间/口径/免责声明等，写在这里"
    }
  ]
}

输出约束：
- 必须输出 JSON，不能有任何多余文字。
- quote 最多给 3 条，每条不超过 80 字。
- rewrite_suggestion 至少 1 条，最多 5 条，必须给出 after。
`.trim();

    // ===== User Prompt（按模式组装）=====
    let user;
    let system;

    if (mode === "report") {
      system = system_report;
      user = `
【全文（按页）】
${pagesText}

【规则库（rulesJson）】
${rulesJson}

【规则初审结果（audit）】
${JSON.stringify(audit, null, 2)}
`.trim();
    } else {
      system = system_legacy;
      user = `
【材料文本】
${text}

【复核项（你需要判断）】
${JSON.stringify(review, null, 2)}
`.trim();
    }

    // ===== Call DeepSeek =====
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
        temperature: 0.1,
        response_format: { type: "json_object" }
      })
    });

    const raw = await resp.text();
    if (!resp.ok) {
      return res.status(resp.status).json({ error: "DeepSeek API error", http_status: resp.status, raw });
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return res.status(500).json({ error: "DeepSeek returned non-JSON", raw });
    }

    const content = data?.choices?.[0]?.message?.content || "";
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return res.status(500).json({ error: "Model content is not JSON", content });
    }

    // ===== 兜底字段 =====
    if (!parsed || typeof parsed !== "object") parsed = {};

    if (mode === "report") {
      if (parsed.ok !== true) parsed.ok = true;
      if (!Array.isArray(parsed.rules_issues_fix)) parsed.rules_issues_fix = [];
      if (!Array.isArray(parsed.ai_extra)) parsed.ai_extra = [];
      if (!parsed.final_summary || typeof parsed.final_summary !== "object") {
        parsed.final_summary = { overall: "", top_risks: [], next_actions: [] };
      }
      return res.status(200).json(parsed);
    } else {
      if (!Array.isArray(parsed.ai)) parsed.ai = [];
      return res.status(200).json({ ok: true, ...parsed });
    }
  } catch (e) {
    return res.status(500).json({ error: String(e), stack: e?.stack });
  }
}
