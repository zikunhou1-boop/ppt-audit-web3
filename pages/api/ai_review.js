// pages/api/ai_review.js
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return res.status(500).json({ ok: false, error: "Missing env: DEEPSEEK_API_KEY" });

    const body = req.body || {};
    const mode =
      body.mode === "report" ? "report" :
      body.mode === "semantic" ? "semantic" :
      "legacy";

    // legacy
    const text = typeof body.text === "string" ? body.text : null;
    const review = Array.isArray(body.review) ? body.review : null;

    // report / semantic
    const pagesText = typeof body.pagesText === "string" ? body.pagesText : "";
    const audit = body.audit && typeof body.audit === "object" ? body.audit : null;
    const rulesJson = typeof body.rulesJson === "string" ? body.rulesJson : "";

    // 参数校验
    if (mode === "legacy") {
      if (typeof text !== "string" || !Array.isArray(review)) {
        return res.status(400).json({ ok: false, error: "legacy mode requires text(string) and review(array)" });
      }
    } else if (mode === "report") {
      if (!audit) return res.status(400).json({ ok: false, error: "report mode requires audit(object)" });
      if (!pagesText) return res.status(400).json({ ok: false, error: "report mode requires pagesText(string)" });
    } else if (mode === "semantic") {
      if (!pagesText) return res.status(400).json({ ok: false, error: "semantic mode requires pagesText(string)" });
    }

    // ---------------- helpers ----------------
    function extractJsonObject(s) {
      if (typeof s !== "string") return null;
      const first = s.indexOf("{");
      const last = s.lastIndexOf("}");
      if (first >= 0 && last > first) return s.slice(first, last + 1);
      return null;
    }

    // 从 pagesText 里按“【第X页】”切块，抽取指定页内容
    function pickPageBlock(all, pageNo, maxLen) {
      if (pageNo == null) return "";
      const marker = `【第${pageNo}页】`;
      const idx = all.indexOf(marker);
      if (idx < 0) return "";
      const nextIdx = all.indexOf("【第", idx + marker.length);
      const block = nextIdx < 0 ? all.slice(idx) : all.slice(idx, nextIdx);
      return block.slice(0, maxLen);
    }

    // 语义扫描：把全文切成几段（降低超时概率）
    function splitByMaxLen(s, maxLen) {
      const out = [];
      let i = 0;
      while (i < s.length) {
        out.push(s.slice(i, i + maxLen));
        i += maxLen;
      }
      return out;
    }

    // 合并重复整改项：同 rule_id + page + quote(首条) + before(首条) 认为重复
    function dedupeFixes(fixes) {
      const map = new Map();
      for (const it of fixes || []) {
        const q0 = Array.isArray(it?.quote) && it.quote.length ? String(it.quote[0]) : "";
        const b0 =
          Array.isArray(it?.rewrite) && it.rewrite.length ? String(it.rewrite[0]?.before || "") : "";
        const key = `${it?.rule_id || ""}__${it?.page ?? ""}__${q0}__${b0}`;
        if (!map.has(key)) {
          map.set(key, it);
        } else {
          // 合并 rewrite：最多保留 3 条
          const prev = map.get(key);
          const rw = []
            .concat(Array.isArray(prev.rewrite) ? prev.rewrite : [])
            .concat(Array.isArray(it.rewrite) ? it.rewrite : []);
          const uniq = [];
          const seen = new Set();
          for (const x of rw) {
            const k = `${x?.action || ""}__${x?.before || ""}__${x?.after || ""}`;
            if (seen.has(k)) continue;
            seen.add(k);
            uniq.push(x);
            if (uniq.length >= 3) break;
          }
          prev.rewrite = uniq;
          // note 合并
          const n1 = String(prev.note || "").trim();
          const n2 = String(it.note || "").trim();
          prev.note = n1 && n2 ? `${n1}\n${n2}` : (n1 || n2);
          map.set(key, prev);
        }
      }
      return Array.from(map.values());
    }

    // 语义风险去重：同 page + problem + quote(首条)
    function dedupeExtra(extras) {
      const map = new Map();
      for (const x of extras || []) {
        const p = String(x?.page ?? "");
        const prob = String(x?.problem || "");
        const q0 = Array.isArray(x?.quote) && x.quote.length ? String(x.quote[0]) : "";
        const key = `${p}__${prob}__${q0}`;
        if (!map.has(key)) map.set(key, x);
      }
      return Array.from(map.values());
    }

    // ---------------- prompts ----------------
    const system_report = `
你是保险课件/宣传材料合规复审助手。你要在规则初审(audit)基础上复核，并输出结构化融合结果。

硬性要求（必须遵守）：
1) 不得推翻 audit.pass / audit.risk_level，仅做复核与改写。
2) rules_issues_fix 必须逐条对应 audit.issues（数量不得少于 audit.issues 条数）。
3) 每条 rules_issues_fix 必须给 quote（来自命中页原文），不得为空。
4) rewrite[0].before 必须等于 quote 中的一句（或其精简），不得为空、不得写“缺失/无”。
5) rewrite[0].after 必须是可直接替换进课件的具体句子（可粘贴），不得只写原则/口径。
6) 若 audit.issues 中有重复项（相同 rule_id+page+相同原文），请合并成一条输出。
7) 额外语义风险放 ai_extra，不能混入 rules_issues_fix。

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

    const system_semantic = `
你是保险课件/宣传材料“全篇语义合规扫描”助手。你要基于全文内容，发现规则引擎可能漏掉的语义风险点。

硬性要求：
1) 不要推翻 audit 结论（若给了 audit，只做补充）。
2) 输出只放在 ai_extra：按严重程度排序（high/medium/low），每条要有 page、problem、quote、suggestion。
3) quote 必须来自原文（<=80字）。
4) suggestion 必须是可直接粘贴的合规改写句子或补充句子，不能只写原则。
5) 控制数量：最多输出 12 条（按严重程度优先）。

输出必须是严格 JSON：
{
  "ok": true,
  "ai_extra": [
    { "severity":"high/medium/low", "page": 1, "problem":"...", "quote":["..."], "suggestion":"..." }
  ]
}
`.trim();

    const system_legacy = `
你是保险宣传/课件材料合规审核助手。输出必须是严格 JSON：
{ "ai": [ { "rule_id": "...", "verdict": "...", "quote": [], "problem": "", "rewrite_suggestion": [{ "action": "", "before": "", "after": "" }], "notes": "" } ] }
`.trim();

    // ---------------- input slimming ----------------
    const issues = Array.isArray(audit?.issues) ? audit.issues : [];

    // report：只取前 5 条 issue（你之前就是这个策略，最稳）
    const issuesSlim = issues.slice(0, 5).map((it) => ({
      rule_id: it.rule_id,
      page: it.page ?? null,
      message: it.message || it.problem || it.reason || "",
      suggestion: it.suggestion || "",
      quote: it.quote || ""
    }));

    // report：抽取命中页，每页最多 800 字，总 6000
    const pageBlocks_report = issuesSlim
      .map((it) => pickPageBlock(pagesText || "", it.page, 800))
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 6000);

    const rulesSlim = (rulesJson || "").slice(0, 800);

    // semantic：全文切块（每块 4500 字），最多 2 块（更稳，降低超时）
    const semanticChunks = splitByMaxLen(String(pagesText || ""), 4500).slice(0, 2);

    // ---------------- build request ----------------
    let system = system_legacy;
    let user = "";

    if (mode === "report") {
      system = system_report;
      user = `
【命中页原文（仅抽取命中页）】
${pageBlocks_report}

【规则初审 issues（已瘦身）】
${JSON.stringify(issuesSlim, null, 2)}

【规则库摘要（截断）】
${rulesSlim}
`.trim();
    } else if (mode === "semantic") {
      system = system_semantic;
      // semantic 用分块调用：先做第一块，若能返回就够用（更稳）
      user = `
【全文片段】
${semanticChunks[0] || ""}

${semanticChunks[1] ? `\n\n【全文片段-续】\n${semanticChunks[1]}` : ""}

${audit ? `\n\n【规则初审摘要（不推翻，仅参考）】\n${JSON.stringify({ pass: audit.pass, risk_level: audit.risk_level }, null, 2)}` : ""}
`.trim();
    } else {
      system = system_legacy;
      user = `
【材料文本】
${text}

【复核项】
${JSON.stringify(review, null, 2)}
`.trim();
    }

    // ---------------- call DeepSeek ----------------
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 110000);

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
          temperature: 0.1,
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

    // ---------------- parse DeepSeek envelope ----------------
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return res.status(200).json({
        ok: false,
        error: "DeepSeek returned non-JSON envelope",
        raw: raw.slice(0, 2000)
      });
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
        content_preview: String(content).slice(0, 1200)
      });
    }

    // ---------------- normalize outputs ----------------
    if (mode === "report") {
      if (!Array.isArray(parsed.rules_issues_fix)) parsed.rules_issues_fix = [];
      if (!Array.isArray(parsed.ai_extra)) parsed.ai_extra = [];
      if (!parsed.final_summary || typeof parsed.final_summary !== "object") {
        parsed.final_summary = { overall: "", top_risks: [], next_actions: [] };
      }

      // 后处理：合并重复整改项、去重 extra
      parsed.rules_issues_fix = dedupeFixes(parsed.rules_issues_fix);
      parsed.ai_extra = dedupeExtra(parsed.ai_extra);

      parsed.ok = true;
      return res.status(200).json(parsed);
    }

    if (mode === "semantic") {
      if (!Array.isArray(parsed.ai_extra)) parsed.ai_extra = [];

      // 去重 + 控制最多 12 条
      parsed.ai_extra = dedupeExtra(parsed.ai_extra).slice(0, 12);

      return res.status(200).json({
        ok: true,
        ai_extra: parsed.ai_extra
      });
    }

    // legacy
    if (!Array.isArray(parsed.ai)) parsed.ai = [];
    return res.status(200).json({ ok: true, ...parsed });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e), stack: e?.stack });
  }
}

