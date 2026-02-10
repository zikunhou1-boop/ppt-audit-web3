// pages/api/ai_explain.js
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return res.status(500).json({ ok: false, error: "Missing env: DEEPSEEK_API_KEY" });

    const body = req.body || {};
    const item = body.item && typeof body.item === "object" ? body.item : null;

    if (!item) return res.status(400).json({ ok: false, error: "Missing item" });

    const system = `
你是保险宣传/课件材料合规解释助手。用户会给你一条“命中问题项”（rule_id/page/quote/problem/after等）。
你的任务是：用中文把这条问题解释清楚，帮助一线人员理解风险与整改原因。

输出必须是严格 JSON（不能有任何多余文字）：
{
  "ok": true,
  "rule_id": "6-01",
  "title": "一句话概括触犯点",
  "why_risky": ["2-4条：为何有风险（监管/消保视角）"],
  "what_triggered": ["2-4条：这条内容/表述具体哪里触发了问题（基于quote）"],
  "how_to_fix": ["2-4条：整改要点（与after一致、可执行）"],
  "better_wording": ["1-3条：更合规的替代表述（可直接粘贴）"],
  "notes": "可选：适用边界/注意事项/提示语"
}

硬性要求：
- 必须结合 quote 和 rule_id 来解释，不要泛泛而谈。
- 不要编造法律条文编号；可以用“信息披露/不得误导/不得绝对化用语/不得与理财混同”等合规原则表述。
- better_wording 必须是具体句子，不要只写原则。
`.trim();

    const user = `
【问题项】
${JSON.stringify(item, null, 2)}
`.trim();

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
          temperature: 0.2,
          response_format: { type: "json_object" }
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
      parsed = null;
    }

    if (!parsed || typeof parsed !== "object") {
      return res.status(200).json({ ok: false, error: "Model content is not valid JSON", content_preview: String(content).slice(0, 1200) });
    }

    parsed.ok = true;
    if (typeof parsed.rule_id !== "string") parsed.rule_id = String(item.rule_id || "");
    if (typeof parsed.title !== "string") parsed.title = "";
    if (!Array.isArray(parsed.why_risky)) parsed.why_risky = [];
    if (!Array.isArray(parsed.what_triggered)) parsed.what_triggered = [];
    if (!Array.isArray(parsed.how_to_fix)) parsed.how_to_fix = [];
    if (!Array.isArray(parsed.better_wording)) parsed.better_wording = [];
    if (typeof parsed.notes !== "string") parsed.notes = "";

    return res.status(200).json(parsed);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e), stack: e?.stack });
  }
}
