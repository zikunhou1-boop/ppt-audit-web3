// pages/api/ai_review.js
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const body = req.body || {};
    const mode = body.mode === "report" ? "report" : "legacy";

    // legacy 输入
    const text = typeof body.text === "string" ? body.text : null;
    const review = Array.isArray(body.review) ? body.review : null;

    // report 输入
    const pagesText = typeof body.pagesText === "string" ? body.pagesText : null;
    const audit = body.audit && typeof body.audit === "object" ? body.audit : null;
    const rulesJson = typeof body.rulesJson === "string" ? body.rulesJson : null;

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

    // ===== report 兜底构造：无论 AI 成功与否，都要返回完整结构 =====
    const buildReportFallback = () => {
      const issues = audit && Array.isArray(audit.issues) ? audit.issues : [];
      return {
        ok: true,
        rules_issues_fix: issues.map((it) => ({
          rule_id: it.rule_id,
          page: it.page === undefined ? null : it.page,
          quote: it.quote ? [String(it.quote).slice(0, 80)] : [],
          problem: it.problem || it.reason || it.message || "",
          rewrite: [
            {
              action: "修改/补充",
              before: it.quote || "",
              after: it.suggestion || ""
            }
          ],
          note: ""
        })),
        ai_extra: [],
        final_summary: {
          overall: "",
          top_risks: [],
          next_actions: []
        }
      };
    };

    // 如果是 report 模式：即使没有 API Key，也返回兜底报告（保证有整改清单）
    if (mode === "report") {
      const apiKey = process.env.DEEPSEEK_API_KEY;

      // 先准备兜底结构（后面 AI 成功就覆盖/补充）
      let parsed = buildReportFallback();

      // 没 key：直接返回兜底（不会再“未生成整改清单”）
      if (!apiKey) {
        return res.status(200).json(parsed);
      }

      // ===== System Prompt（融合版）=====
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

      const user = `
【全文（按页）】
${pagesText}

【规则库（rulesJson）】
${rulesJson}

【规则初审结果（audit）】
${JSON.stringify(audit, null, 2)}
`.trim();

      // ===== Call DeepSeek（任何失败都不 return error，直接走兜底）=====
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
              { role: "system", content: system_report },
              { role: "user", content: user }
            ],
            temperature: 0.1,
            response_format: { type: "json_object" }
          })
        });

        const raw = await resp.text();
        if (resp.ok) {
          const data = JSON.parse(raw);
          const content = data?.choices?.[0]?.message?.content || "";
          const modelObj = JSON.parse(content);

          // 合并：模型给的结构优先，但必须保证每条 issue 有 fix；缺的用兜底补齐
          if (modelObj && typeof modelObj === "object") {
            parsed.final_summary =
              modelObj.final_summary && typeof modelObj.final_summary === "object"
                ? {
                    overall: String(modelObj.final_summary.overall || ""),
                    top_risks: Array.isArray(modelObj.final_summary.top_risks) ? modelObj.final_summary.top_risks : [],
                    next_actions: Array.isArray(modelObj.final_summary.next_actions) ? modelObj.final_summary.next_actions : []
                  }
                : parsed.final_summary;

            parsed.ai_extra = Array.isArray(modelObj.ai_extra) ? modelObj.ai_extra : parsed.ai_extra;

            if (Array.isArray(modelObj.rules_issues_fix) && modelObj.rules_issues_fix.length > 0) {
              parsed.rules_issues_fix = modelObj.rules_issues_fix;
            }

            // 再补齐缺失：确保 audit.issues 都被覆盖
            const issues = audit && Array.isArray(audit.issues) ? audit.issues : [];
            const existed = new Set(
              (parsed.rules_issues_fix || []).map((x) => `${x?.rule_id || ""}__${x?.page === undefined ? "" : x.page}`)
            );

            for (const it of issues) {
              const key = `${it.rule_id || ""}__${it.page === undefined ? "" : it.page}`;
              if (!existed.has(key)) {
                parsed.rules_issues_fix.push(
                  ...buildReportFallback().rules_issues_fix.filter(
                    (z) => `${z.rule_id}__${z.page === undefined ? "" : z.page}` === key
                  )
                );
                existed.add(key);
              }
            }
          }
        }
      } catch {
        // 忽略，返回兜底 parsed
      }

      parsed.ok = true;
      return res.status(200).json(parsed);
    }

    // ===== legacy 模式：保持原逻辑（无 key 仍报错）=====
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing env: DEEPSEEK_API_KEY" });

    const system_legacy = `
你是保险宣传/课件材料合规审核助手。你的任务：依据给定“复核项(review)”对材料文本进行复核，并输出可直接落地修改的结果。

输出必须是严格 JSON，结构如下：
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
`.trim();

    const userLegacy = `
【材料文本】
${text}

【复核项（你需要判断）】
${JSON.stringify(review, null, 2)}
`.trim();

    const respLegacy = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: system_legacy },
          { role: "user", content: userLegacy }
        ],
        temperature: 0.1,
        response_format: { type: "json_object" }
      })
    });

    const rawLegacy = await respLegacy.text();
    if (!respLegacy.ok) {
      return res.status(respLegacy.status).json({ error: "DeepSeek API error", http_status: respLegacy.status, raw: rawLegacy });
    }

    const dataLegacy = JSON.parse(rawLegacy);
    const contentLegacy = dataLegacy?.choices?.[0]?.message?.content || "{}";
    const parsedLegacy = JSON.parse(contentLegacy);

    if (!parsedLegacy || typeof parsedLegacy !== "object") return res.status(200).json({ ok: true, ai: [] });
    if (!Array.isArray(parsedLegacy.ai)) parsedLegacy.ai = [];
    return res.status(200).json({ ok: true, ...parsedLegacy });
  } catch (e) {
    return res.status(500).json({ error: String(e), stack: e?.stack });
  }
}
