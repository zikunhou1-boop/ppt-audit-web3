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

    // report / semantic
    const pagesText = typeof body.pagesText === "string" ? body.pagesText : "";
    const audit = body.audit && typeof body.audit === "object" ? body.audit : null;
    const rulesJson = typeof body.rulesJson === "string" ? body.rulesJson : "";

    // OCR 可选（你后面接入 OCR 时传这个字段；不传也能跑）
    const ocrText = typeof body.ocrText === "string" ? body.ocrText : "";

    // 参数校验
    if (mode === "legacy") {
      if (typeof text !== "string" || !Array.isArray(review)) {
        return res.status(400).json({ ok: false, error: "legacy mode requires text(string) and review(array)" });
      }
    } else if (mode === "report") {
      if (!audit) return res.status(400).json({ ok: false, error: "report mode requires audit(object)" });
      if (!pagesText) return res.status(400).json({ ok: false, error: "report mode requires pagesText(string)" });
    } else if (mode === "semantic") {
      // semantic 不推翻 audit，但最好带上 audit 便于上下文（可选）
      if (!pagesText && !ocrText) return res.status(400).json({ ok: false, error: "semantic mode requires pagesText or ocrText" });
    }

    // =========================
    // Prompts
    // =========================

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

    // ✅ semantic：全篇语义扫描（只输出 ai_extra，不改 rules_issues_fix，不推翻 audit）
    const system_semantic = `
你是保险课件/宣传材料“全篇语义扫描”合规助手。你只做“规则未覆盖/漏检”的语义风险发现（ai_extra），不推翻任何规则结论。

硬性要求：
1) 只输出严格 JSON，不能有任何多余文字。
2) 只输出 ai_extra（语义问题列表），按严重程度 high -> medium -> low 排序。
3) 每条必须包含：severity、page(可为null)、problem、quote(必须来自原文)、suggestion(必须是可直接粘贴的修改句子/替换句)。
4) 必须“去重合并”：同一类问题（同义/重复表述/同一条款口径）只保留 1 条，quote 可保留 1-2 个代表片段。
5) 不要泛泛而谈，problem 要具体；suggestion 要具体可粘贴。

输出格式：
{
  "ok": true,
  "ai_extra": [
    { "severity": "high/medium/low", "page": 3, "problem": "...", "quote": ["..."], "suggestion": "..." }
  ]
}
`.trim();

    const system_legacy = `
你是保险宣传/课件材料合规审核助手。输出必须是严格 JSON：
{ "ai": [ { "rule_id": "...", "verdict": "...", "quote": [], "problem": "", "rewrite_suggestion": [{ "action": "", "before": "", "after": "" }], "notes": "" } ] }
`.trim();

    // =========================
    // Helpers: slimming + batching
    // =========================

    function extractJsonObject(s) {
      if (typeof s !== "string") return null;
      const first = s.indexOf("{");
      const last = s.lastIndexOf("}");
      if (first >= 0 && last > first) return s.slice(first, last + 1);
      return null;
    }

    // 从 pagesText 里按“【第X页】”切块
    function pickPageBlock(all, pageNo, maxLen) {
      if (!all || pageNo == null) return "";
      const marker = `【第${pageNo}页】`;
      const idx = all.indexOf(marker);
      if (idx < 0) return "";
      const nextIdx = all.indexOf("【第", idx + marker.length);
      const block = nextIdx < 0 ? all.slice(idx) : all.slice(idx, nextIdx);
      return block.slice(0, maxLen);
    }

    function splitPagesTextToMap(all) {
      // 简易解析：把 "【第X页】" 到下一个标记作为一页
      const map = new Map();
      if (!all) return map;
      const re = /【第(\d+)页】/g;
      const matches = [];
      let m;
      while ((m = re.exec(all))) matches.push({ page: Number(m[1]), idx: m.index });
      for (let i = 0; i < matches.length; i++) {
        const cur = matches[i];
        const next = matches[i + 1];
        const chunk = next ? all.slice(cur.idx, next.idx) : all.slice(cur.idx);
        map.set(cur.page, chunk);
      }
      return map;
    }

    function normalizeStr(s) {
      return String(s || "")
        .replace(/\s+/g, " ")
        .replace(/[“”"]/g, '"')
        .replace(/[‘’']/g, "'")
        .trim();
    }

    function dedupeAiExtra(list) {
      const out = [];
      const seen = new Set();
      for (const it of Array.isArray(list) ? list : []) {
        const severity = (it?.severity || "").toLowerCase();
        const problem = normalizeStr(it?.problem || "");
        const suggestion = normalizeStr(it?.suggestion || "");
        const quote0 = Array.isArray(it?.quote) ? normalizeStr(it.quote[0] || "") : normalizeStr(it?.quote || "");
        const key = `${severity}__${problem.slice(0, 80)}__${suggestion.slice(0, 80)}__${quote0.slice(0, 60)}`;
        if (!problem || !suggestion) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          severity: severity === "high" || severity === "medium" || severity === "low" ? severity : "medium",
          page: it?.page ?? null,
          problem,
          quote: Array.isArray(it?.quote) ? it.quote.slice(0, 2) : quote0 ? [quote0] : [],
          suggestion
        });
      }
      // 排序：high->medium->low
      const rank = { high: 0, medium: 1, low: 2 };
      out.sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));
      return out;
    }

    async function callDeepSeek({ system, user, timeoutMs }) {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);

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
          return {
            ok: false,
            error: "DeepSeek API error",
            http_status: httpStatus,
            raw: raw.slice(0, 2000)
          };
        }

        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          return { ok: false, error: "DeepSeek returned non-JSON envelope", http_status: httpStatus, raw: raw.slice(0, 2000) };
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
          return { ok: false, error: "Model content is not valid JSON", http_status: httpStatus, content_preview: String(content).slice(0, 1200) };
        }

        return { ok: true, http_status: httpStatus, parsed };
      } catch (e) {
        return {
          ok: false,
          error: "Fetch DeepSeek failed (timeout or network)",
          detail: String(e),
          http_status: httpStatus || 0
        };
      } finally {
        clearTimeout(t);
      }
    }

    // =========================
    // Build user prompt by mode
    // =========================

    if (mode === "report") {
      // ====== report 模式：输入瘦身（你原来的逻辑保留） ======
      const issues = Array.isArray(audit?.issues) ? audit.issues : [];

      // ✅ 只取前 5 条 issue（稳）
      const issuesSlim = issues.slice(0, 5).map((it) => ({
        rule_id: it.rule_id,
        page: it.page ?? null,
        message: it.message || it.problem || it.reason || "",
        suggestion: it.suggestion || ""
      }));

      // ✅ 单页最多 800 字，总 6000
      const pageBlocks = issuesSlim
        .map((it) => pickPageBlock(pagesText || "", it.page, 800))
        .filter(Boolean)
        .join("\n\n")
        .slice(0, 6000);

      const rulesSlim = (rulesJson || "").slice(0, 800);

      const user = `
【命中页原文（仅抽取命中页）】
${pageBlocks}

【规则初审 issues（已瘦身）】
${JSON.stringify(issuesSlim, null, 2)}

【规则库摘要（截断）】
${rulesSlim}
`.trim();

      // ✅ 110s 你现在能跑通就先不动
      const r = await callDeepSeek({ system: system_report, user, timeoutMs: 110000 });
      if (!r.ok) return res.status(200).json(r);

      const parsed = r.parsed;

      if (!Array.isArray(parsed.rules_issues_fix)) parsed.rules_issues_fix = [];
      if (!Array.isArray(parsed.ai_extra)) parsed.ai_extra = [];
      if (!parsed.final_summary || typeof parsed.final_summary !== "object") {
        parsed.final_summary = { overall: "", top_risks: [], next_actions: [] };
      }
      parsed.ok = true;
      return res.status(200).json(parsed);
    }

    if (mode === "semantic") {
      // ====== semantic：必须更稳：分批 + 抽样 + 限长 + 超时更短 ======

      // 1) 解析 pagesText 为 page->chunk
      const pageMap = splitPagesTextToMap(pagesText || "");
      const pages = Array.from(pageMap.keys()).sort((a, b) => a - b);

      // 2) 命中页优先（来自 audit 可选）
      const hitPages = new Set();
      const issues = Array.isArray(audit?.issues) ? audit.issues : [];
      for (const it of issues) {
        if (Number.isFinite(it?.page)) hitPages.add(Number(it.page));
      }

      // 3) 组装候选页：命中页 + 抽样页（每3页取1页）
      const sampled = [];
      for (let i = 0; i < pages.length; i += 3) sampled.push(pages[i]);
      const mergedPages = Array.from(new Set([...hitPages, ...sampled])).sort((a, b) => a - b);

      // 4) 分批：每批最多 15 页
      const batchSize = 15;
      const batches = [];
      for (let i = 0; i < mergedPages.length; i += batchSize) {
        batches.push(mergedPages.slice(i, i + batchSize));
      }

      // 5) 每页截断 + 总长度截断
      function buildBatchText(pageNos) {
        const parts = [];
        for (const p of pageNos) {
          const chunk = pickPageBlock(pagesText || "", p, 900); // 每页<=900
          if (chunk) parts.push(chunk);
        }
        return parts.join("\n\n").slice(0, 9000); // 每批总<=9000
      }

      // OCR 也要限长（防止爆炸）
      const ocrSlim = (ocrText || "").slice(0, 3000);

      // rules 摘要也限长（semantic 不需要全量）
      const rulesSlim = (rulesJson || "").slice(0, 800);

      // 6) 跑批次（每批 45s 超时更稳；批次数多时也不会卡死一次）
      const allExtra = [];
      for (let bi = 0; bi < batches.length; bi++) {
        const pageNos = batches[bi];
        const batchText = buildBatchText(pageNos);
        if (!batchText && !ocrSlim) continue;

        const user = `
【抽样页原文（第${bi + 1}/${batches.length}批；每批<=15页；已截断）】
${batchText}

【OCR文本（可选，已截断）】
${ocrSlim}

【规则库摘要（截断，可选）】
${rulesSlim}

【要求】
只输出 ai_extra（语义问题列表），必须去重合并，suggestion 必须是可粘贴的具体改写句。
`.trim();

        const r = await callDeepSeek({ system: system_semantic, user, timeoutMs: 45000 });
        if (!r.ok) {
          // semantic 任何一批失败，不直接整体失败：返回当前已拿到的 + 错误信息（前端可提示“部分失败”）
          return res.status(200).json({
            ok: false,
            error: r.error,
            detail: r.detail,
            http_status: r.http_status,
            partial: true,
            ai_extra: dedupeAiExtra(allExtra),
            failed_batch: bi + 1,
            total_batches: batches.length
          });
        }

        const parsed = r.parsed;
        const extra = Array.isArray(parsed?.ai_extra) ? parsed.ai_extra : [];
        allExtra.push(...extra);
      }

      return res.status(200).json({
        ok: true,
        ai_extra: dedupeAiExtra(allExtra)
      });
    }

    // ====== legacy ======
    {
      const user = `
【材料文本】
${text}

【复核项】
${JSON.stringify(review, null, 2)}
`.trim();

      const r = await callDeepSeek({ system: system_legacy, user, timeoutMs: 60000 });
      if (!r.ok) return res.status(200).json(r);

      const parsed = r.parsed;
      if (!Array.isArray(parsed.ai)) parsed.ai = [];
      return res.status(200).json({ ok: true, ...parsed });
    }
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e), stack: e?.stack });
  }
}
