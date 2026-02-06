// ===== 兜底字段 + 强制对齐 audit.issues =====
if (!parsed || typeof parsed !== "object") parsed = {};

function buildFixFromIssues(issues) {
  return (issues || []).map((it) => ({
    rule_id: it.rule_id,
    page: it.page ?? null,
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
  }));
}

if (mode === "report") {
  // 统一 ok / summary / ai_extra
  parsed.ok = true;

  if (!Array.isArray(parsed.ai_extra)) parsed.ai_extra = [];
  if (!parsed.final_summary || typeof parsed.final_summary !== "object") {
    parsed.final_summary = { overall: "", top_risks: [], next_actions: [] };
  } else {
    if (typeof parsed.final_summary.overall !== "string") parsed.final_summary.overall = "";
    if (!Array.isArray(parsed.final_summary.top_risks)) parsed.final_summary.top_risks = [];
    if (!Array.isArray(parsed.final_summary.next_actions)) parsed.final_summary.next_actions = [];
  }

  // 兼容：模型如果误返回 legacy 结构 { ai: [...] }，尝试转为 rules_issues_fix
  if (!Array.isArray(parsed.rules_issues_fix) || parsed.rules_issues_fix.length === 0) {
    if (Array.isArray(parsed.ai) && parsed.ai.length > 0) {
      const issues = audit?.issues || [];
      const byRule = new Map();
      parsed.ai.forEach((x) => {
        if (x?.rule_id) byRule.set(String(x.rule_id), x);
      });

      parsed.rules_issues_fix = issues.map((it) => {
        const hit = byRule.get(String(it.rule_id));
        const rs = hit?.rewrite_suggestion || hit?.rewrite || [];
        const rw0 = Array.isArray(rs) && rs.length > 0 ? rs[0] : null;

        return {
          rule_id: it.rule_id,
          page: it.page ?? null,
          quote: Array.isArray(hit?.quote) ? hit.quote.slice(0, 3) : it.quote ? [String(it.quote).slice(0, 80)] : [],
          problem: hit?.problem || it.problem || it.reason || it.message || "",
          rewrite: [
            {
              action: rw0?.action || "修改/补充",
              before: rw0?.before || it.quote || "",
              after: rw0?.after || it.suggestion || ""
            }
          ],
          note: hit?.notes || ""
        };
      });
    } else {
      // 最强兜底：AI 完全没给时，用 audit.issues 生成清单
      parsed.rules_issues_fix = buildFixFromIssues(audit?.issues || []);
    }
  }

  // 强制：rules_issues_fix 必须覆盖 audit.issues（缺的补齐）
  const issues = audit?.issues || [];
  const existed = new Set(
    (parsed.rules_issues_fix || []).map((x) => `${x?.rule_id}__${x?.page ?? ""}`)
  );

  for (const it of issues) {
    const key = `${it.rule_id}__${it.page ?? ""}`;
    if (!existed.has(key)) {
      parsed.rules_issues_fix.push(...buildFixFromIssues([it]));
      existed.add(key);
    }
  }

  return res.status(200).json(parsed);
} else {
  if (!Array.isArray(parsed.ai)) parsed.ai = [];
  return res.status(200).json({ ok: true, ...parsed });
}
