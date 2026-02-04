export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing env: DEEPSEEK_API_KEY" });

    const { text, review } = req.body || {};
    if (typeof text !== "string" || !Array.isArray(review)) {
      return res.status(400).json({ error: "text(string) and review(array) are required" });
    }

    const system = `
你是保险宣传材料合规审核助手。只针对“复核项(review)”进行判断并给出可直接替换到课件中的改写建议。
输出必须是严格 JSON，格式：
{
  "ai": [
    { "rule_id": "6-03", "verdict": "违规/可能违规/不违规/不确定", "reason": "理由", "rewrite_suggestion": "可直接替换的改写文案" }
  ]
}
`.trim();

    const user = `
【材料文本】
${text}

【复核项（需要你判断）】
${JSON.stringify(review, null, 2)}
`.trim();

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
        temperature: 0.2,
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

    return res.status(200).json({ ok: true, ...parsed });
  } catch (e) {
    return res.status(500).json({ error: String(e), stack: e?.stack });
  }
}
