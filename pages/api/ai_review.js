export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing env: DEEPSEEK_API_KEY" });

    const { text, review } = req.body || {};
    if (typeof text !== "string" || !Array.isArray(review)) {
      return res.status(400).json({ error: "text(string) and review(array) are required" });
    }

    // ===== System Prompt：逐句定位 + before/after 改写 =====
    const system = `
你是保险宣传/课件材料合规审核助手。你的任务：依据给定“复核项(review)”对材料文本进行复核，并输出可直接落地修改的结果。

硬性要求：
1) 不要写成“通报/总结/总体平稳”口吻；必须定位到原文句子或短语（quote）。
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
        { "action": "删除/替换/补充", "before": "原句", "after": "改写句" }
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

    // ===== User Prompt =====
    const user = `
【材料文本】
${text}

【复核项（你需要判断）】
${JSON.stringify(review, null, 2)}
`.trim();

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

    // 兜底：保证字段存在
    if (!parsed || typeof parsed !== "object") parsed = {};
    if (!Array.isArray(parsed.ai)) parsed.ai = [];

    return res.status(200).json({ ok: true, ...parsed });
  } catch (e) {
    return res.status(500).json({ error: String(e), stack: e?.stack });
  }
}

