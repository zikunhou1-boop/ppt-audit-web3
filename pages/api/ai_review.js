// pages/api/ai_review.js
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return res.status(500).json({ ok: false, error: "Missing env: DEEPSEEK_API_KEY" });

    const body = req.body || {};
    const mode = body.mode === "semantic" ? "semantic" : body.mode === "report" ? "report" : "legacy";

    // legacy
    const text = typeof body.text === "string" ? body.text : null;
    const review = Array.isArray(body.review) ? body.review : null;

    // report/semantic
    const pagesText = typeof body.pagesText === "string" ? body.pagesText : "";
    const audit = body.audit && typeof body.audit === "object" ? body.audit : null;
    const rulesJson = typeof body.rulesJson === "string" ? body.rulesJson : "";

    if (mode === "legacy") {
      if (typeof text !== "string" || !Array.isArray(review)) {
        return res.status(400).json({ ok: false, error: "legacy mode requires text(string) and review(array)" });
      }
    } else {
      if (!audit) return res.status(400).json({ ok: false, error: `${mode} mode requires audit(object)` });
    }

    // ---------- prompts ----------
    const system_report = `
你是保险课件/宣传材料合规复审助手。你要在规则初审(audit)基础上复核，并输出结构化融合结果。

硬性要求（必须遵守）：
1) 不得推翻 audit.pass / audit.risk_level，仅做复核与改写。
2) rules_issues_fix 必须逐条对应 audit.issues（数量不得少于 audit.issues 条数）。
3) 每条 rules_issues_fix 必须给 quote（必须来自给你的“命中页原文”），不得为空。
4) rewrite[0].before 必须等于 quote 中的一句（或其精简），不得为空、不得写“缺失/无”。
5) rewrite[0].after 必须是可直接替换进课件的具体句子（可粘贴），不得只写原则/口径。
6) 相同 rule_id + page + quote 的重复项要合并成一条（rewrite 取最优一条，避免重复刷屏）。
7) 额外语义风险放 ai_extra（可为空），不能混入 rules_issues_fix。

输出必须是严格 JSON：
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

    const system_semantic = `
你是保险课件/宣传材料合规“全篇语义扫描”助手。任务：在不推翻规则审核(audit)结论的前提下，仅找出【必须修改】且【高风险(high)】的语义问题。

硬性要求：
1) 只输出必须修改的问题：必须同时满足 must_fix=true 且 severity="high"。
2) 不要输出 medium/low；不要输出建议性优化。
3) 每条必须给：page、quote（来自原文）、problem、why_high（为何高风险）、fix（可直接粘贴的改写句子）。
4) 输出必须严格 JSON，且只包含如下字段：

{
  "ok": true,
  "semantic_extra": [
    {
      "severity": "high",
      "must_fix": true,
      "page": 1,
      "quote": ["原文片段<=80字"],
      "problem": "问题是什么",
      "why_high": "为什么属于必须修改的高风险",
      "fix": "给一条可直接替换进课件的改写句子"
    }
  ]
}
`.trim();

    const system_legacy = `
你是保险宣传/课件材料合规审核助手。输出必须是严格 JSON：
{ "ai": [ { "rule_id": "...", "verdict": "...", "quote": [], "problem": "", "rewrite_suggestion": [{ "action": "", "before": "", "after": "" }], "notes": "" } ] }
`.trim();

    // ---------- slimming to reduce timeout ----------
    const issues = Array.isArray(audit?.issues) ? audit.issues : [];

    // report：只取前 5 条 issue（你之前稳定策略）
    const issuesSlim = issues.slice(0, 5).map((it) => ({
      rule_id: it.rule_id,
      page: it.page ?? null,
      message: it.message || it.problem || it.reason || "",
      suggestion: it.suggestion || "",
    }));

    function pickPageBlock(all, pageNo, limit = 800) {
      if (pageNo == null) return "";
      const marker = `【第${pageNo}页】`;
      const idx = all.indexOf(marker);
      if (idx < 0) return "";
      const nextIdx = all.indexOf("【第", idx + marker.length);
      const block = nextIdx < 0 ? all.slice(idx) : all.slice(idx, nextIdx);
      return block.slice(0, limit);
    }

    // report：命中页抽取
    const reportPageBlocks = issuesSlim
      .map((it) => pickPageBlock(pagesText || "", it.page, 800))
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 6000);

    // semantic：全篇扫描也要控长度，抽“高概率风险页”
    // 规则：取前 6 页 + 含关键字页 + 最后 2 页（总计再截断）
    const KEYWORDS = ["保本", "收益", "利息", "稳赚", "替代存款", "第一", "最好", "唯一", "限时", "错过", "马上", "确保", "零风险", "100%"];
    function collectSemanticPages(all) {
      const blocks = [];
      // 前 6 页
      for (let p = 1; p <= 6; p++) {
        const b = pickPageBlock(all, p, 900);
        if (b) blocks.push(b);
      }
      // 关键字命中页（简单扫 1~60 页）
      for (let p = 1; p <= 60; p++) {
        const b = pickPageBlock(all, p, 900);
        if (!b) continue;
        if (KEYWORDS.some((k) => b.includes(k))) blocks.push(b);
      }
      // 最后 2 页（粗略：从末尾找两个 marker）
      const tail = String(all || "").slice(-8000);
      blocks.push("【尾部抽样】\n" + tail);

      return blocks.join("\n\n").slice(0, 9000);
    }
    const semanticBlocks = collectSemanticPages(pagesText || "");

    const rulesSlim = (rulesJson || "").slice(0, 800);

    let system = mode === "report" ? system_report : mode === "semantic" ? system_semantic : system_legacy;

    let user =
      mode === "report"
        ? `
【命中页原文（仅抽取命中页）】
${reportPageBlocks}

【规则初审 issues（已瘦身）】
${JSON.stringify(issuesSlim, null, 2)}

【规则库摘要（截断）】
${rulesSlim}
`.trim()
        : mode === "semantic"
        ? `
【全篇抽样（高概率风险页 + 尾部抽样）】
${semanticBlocks}

【规则初审概要】
audit.pass=${String(audit?.pass)}
audit.risk_level=${String(audit?.risk_level)}
issues_count=${issues.length}

【规则库摘要（截断）】
${rulesSlim}
`.trim()
        : `
【材料文本】
${text}

【复核项】
${JSON.stringify(review, null, 2)}
`.trim();

    // ---------- call DeepSeek (timeout) ----------
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 110000);

    let raw = "";
    let httpStatus = 0;

    try {
      const resp = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: "deepseek-chat",
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          temperature: 0.1,
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      });

      httpStatus = resp.status;
      raw = await resp.text();

      if (!resp.ok) {
        return res.status(200).json({
          ok: false,
          error: "DeepSeek API error",
          http_status: httpStatus,
          raw: raw.slice(0, 2000),
        });
      }
    } catch (e) {
      return res.status(200).json({
        ok: false,
        error: "Fetch DeepSeek failed (timeout or network)",
        detail: String(e),
        http_status: httpStatus || 0,
      });
    } finally {
      clearTimeout(t);
    }

    // ---------- parse envelope ----------
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

    if (!parsed || typeof parsed !== "object") {
      return res.status(200).json({
        ok: false,
        error: "Model content is not valid JSON",
        http_status: httpStatus,
        content_preview: String(content).slice(0, 1200),
      });
    }

    // ---------- post process ----------
    if (mode === "report") {
      if (!Array.isArray(parsed.rules_issues_fix)) parsed.rules_issues_fix = [];
      if (!Array.isArray(parsed.ai_extra)) parsed.ai_extra = [];
      if (!parsed.final_summary || typeof parsed.final_summary !== "object") {
        parsed.final_summary = { overall: "", top_risks: [], next_actions: [] };
      }

      // 去重合并：rule_id+page+quote0
      const merged = [];
      const mp = new Map();
      for (const it of parsed.rules_issues_fix) {
        const ruleId = it?.rule_id || "";
        const page = it?.page ?? "";
        const q0 = Array.isArray(it?.quote) && it.quote[0] ? String(it.quote[0]) : "";
        const key = `${ruleId}__${page}__${q0.slice(0, 80)}`;
        if (!mp.has(key)) {
          mp.set(key, it);
          merged.push(it);
        } else {
          const prev = mp.get(key);
          // rewrite 取 “after 更长更具体”的那条
          const prevAfter = prev?.rewrite?.[0]?.after ? String(prev.rewrite[0].after) : "";
          const nowAfter = it?.rewrite?.[0]?.after ? String(it.rewrite[0].after) : "";
          if (nowAfter.length > prevAfter.length) {
            mp.set(key, it);
            const idx = merged.indexOf(prev);
            if (idx >= 0) merged[idx] = it;
          }
        }
      }

      parsed.rules_issues_fix = merged;
      parsed.ok = true;
      return res.status(200).json(parsed);
    }

    if (mode === "semantic") {
      const arr = Array.isArray(parsed.semantic_extra) ? parsed.semantic_extra : [];
      // 再次强制过滤：只保留 high + must_fix
      const filtered = arr.filter((x) => x?.severity === "high" && x?.must_fix === true);
      return res.status(200).json({ ok: true, semantic_extra: filtered });
    }

    // legacy
    if (!Array.isArray(parsed.ai)) parsed.ai = [];
    return res.status(200).json({ ok: true, ...parsed });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e), stack: e?.stack });
  }
}
