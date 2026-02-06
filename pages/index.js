// pages/index.js
import { useState } from "react";

export default function Home() {
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);

  // 最终结果：extract + audit + aiReport
  const [result, setResult] = useState(null);

  async function safeJson(resp) {
    const raw = await resp.text();
    try {
      return JSON.parse(raw);
    } catch {
      return { ok: false, http_status: resp.status, raw };
    }
  }

  // ✅ 强制把 ai_report 规范化成 report 结构（即使 AI 失败，也用 audit.issues 兜底）
  function normalizeAiReport(aiReportRaw, audit) {
    const issues = audit?.issues || [];

    const fallback = {
      ok: true,
      final_summary: { overall: "", top_risks: [], next_actions: [] },
      rules_issues_fix: issues.map((it) => ({
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
      })),
      ai_extra: []
    };

    // 1) 已是 report 结构且有整改清单
    if (aiReportRaw?.final_summary && Array.isArray(aiReportRaw?.rules_issues_fix) && aiReportRaw.rules_issues_fix.length > 0) {
      return {
        ok: true,
        final_summary: aiReportRaw.final_summary,
        rules_issues_fix: aiReportRaw.rules_issues_fix,
        ai_extra: Array.isArray(aiReportRaw.ai_extra) ? aiReportRaw.ai_extra : []
      };
    }

    // 2) AI 接口直接报错/400/500：用兜底
    if (aiReportRaw?.error || aiReportRaw?.ok === false) {
      return fallback;
    }

    // 3) 兼容旧结构：{ ai: [...] }
    const legacy = aiReportRaw?.ai;
    if (Array.isArray(legacy) && legacy.length > 0) {
      const fixes = issues.map((it) => {
        const hit =
          legacy.find((x) => x?.rule_id === it.rule_id && (x?.page == null || x?.page === it.page)) ||
          legacy.find((x) => x?.rule_id === it.rule_id) ||
          null;

        // 兼容 legacy 的 rewrite_suggestion
        const rs = hit?.rewrite_suggestion;
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

      return {
        ok: true,
        final_summary: { overall: "", top_risks: [], next_actions: [] },
        rules_issues_fix: fixes,
        ai_extra: []
      };
    }

    // 4) 其他未知结构：兜底
    return fallback;
  }

  async function onRun() {
    if (!file) {
      alert("请先选择文件（ppt/pptx/docx/txt）");
      return;
    }
    setLoading(true);
    setResult(null);

    try {
      // 1) Extract
      const fd = new FormData();
      fd.append("file", file);

      const r1 = await fetch("/api/extract", { method: "POST", body: fd });
      const extract = await safeJson(r1);

      if (!extract.ok || !Array.isArray(extract.pages) || extract.pages.length === 0) {
        setResult({ stage: "error", message: "提取失败：未获取到页面内容", detail: extract });
        return;
      }

      // 2) Rules Audit
      const r2 = await fetch("/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pages: extract.pages })
      });
      const audit = await safeJson(r2);

      if (!audit || typeof audit !== "object") {
        setResult({ stage: "error", message: "规则审核失败：返回异常", detail: audit });
        return;
      }

      // 3) AI Review（✅ 必调用 AI：report 模式融合复核）
      const pagesText = (extract.pages || [])
        .map((p) => `【第${p.page || ""}页】\n${p.content || ""}`)
        .join("\n\n");

      // ✅ 从后端接口取 rulesJson（避免前端直接 /rules/rules.json 引发跨环境问题）
      let rulesJson = "";
      try {
        const rr = await fetch("/api/rules");
        const j = await safeJson(rr);
        rulesJson = j?.rulesJson || "";
      } catch {
        rulesJson = "";
      }

      // 即使 rulesJson 为空，也照样发起 AI 调用（后端可能会校验；normalize 会兜底展示）
      const r3 = await fetch("/api/ai_review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "report",
          pagesText,
          audit,
          rulesJson
        })
      });
      const aiReportRaw = await safeJson(r3);
      const aiReport = normalizeAiReport(aiReportRaw, audit);

      setResult({ stage: "done", extract, audit, aiReport });
    } catch (e) {
      setResult({ stage: "error", message: "客户端异常", detail: String(e?.message || e) });
    } finally {
      setLoading(false);
    }
  }

  const auditPass = result?.audit?.pass === true;
  const riskLevel = result?.audit?.risk_level || "unknown";
  const ai = result?.aiReport;

  // ✅ 永远有整改清单（AI 成功优先用 AI；失败就用规则 issues 兜底）
  const fixesToShow = Array.isArray(ai?.rules_issues_fix) ? ai.rules_issues_fix : [];

  return (
    <div style={{ maxWidth: 900, margin: "28px auto", padding: 16, fontFamily: "system-ui, -apple-system" }}>
      <h2>课件合规初审（规则 + AI）</h2>

      <div style={{ border: "1px solid #ddd", borderRadius: 10, padding: 14 }}>
        <div style={{ marginBottom: 10 }}>
          <input
            type="file"
            accept=".ppt,.pptx,.docx,.txt"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
        </div>

        <button onClick={onRun} disabled={loading} style={{ padding: "8px 14px" }}>
          {loading ? "审核中..." : "一键审核（提取 → 规则 → AI融合报告）"}
        </button>

        <div style={{ marginTop: 12, color: "#666", fontSize: 13 }}>支持：ppt/pptx/docx/txt（图片识别暂未开启）</div>
      </div>

      <div style={{ marginTop: 18 }}>
        <h3>结果</h3>

        {!result && <div style={{ color: "#666" }}>上传文件后点击“一键审核”。</div>}

        {result && result.stage === "error" && (
          <div style={{ border: "1px solid #f0d7d7", background: "#fff5f5", borderRadius: 10, padding: 12 }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>失败</div>
            <div style={{ whiteSpace: "pre-wrap" }}>{result.message || "（无）"}</div>
          </div>
        )}

        {result && result.stage === "done" && (
          <>
            {/* 1) 规则结论（以 audit 为准） */}
            <div style={{ marginBottom: 10, fontWeight: 700 }}>
              规则审核：{auditPass ? "通过" : "不通过"}（risk_level：{riskLevel}）
            </div>

            {/* 2) 融合报告：summary（AI 成功则更丰富；失败则为空，但不影响整改清单展示） */}
            {ai?.final_summary ? (
              <div style={{ border: "1px solid #eee", borderRadius: 10, padding: 12, marginBottom: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>融合报告（AI 在规则基础上给可落地改写）</div>

                <div style={{ marginBottom: 8 }}>
                  <div style={{ color: "#666", fontSize: 13, marginBottom: 4 }}>总体结论</div>
                  <div style={{ whiteSpace: "pre-wrap" }}>{ai.final_summary.overall || "（无）"}</div>
                </div>

                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <div style={{ flex: "1 1 260px" }}>
                    <div style={{ color: "#666", fontSize: 13, marginBottom: 4 }}>关键风险（最多3条）</div>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {(ai.final_summary.top_risks || []).slice(0, 3).map((x, i) => (
                        <li key={i}>{x}</li>
                      ))}
                      {(!ai.final_summary.top_risks || ai.final_summary.top_risks.length === 0) && <li>（无）</li>}
                    </ul>
                  </div>

                  <div style={{ flex: "1 1 260px" }}>
                    <div style={{ color: "#666", fontSize: 13, marginBottom: 4 }}>下一步建议（最多3条）</div>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {(ai.final_summary.next_actions || []).slice(0, 3).map((x, i) => (
                        <li key={i}>{x}</li>
                      ))}
                      {(!ai.final_summary.next_actions || ai.final_summary.next_actions.length === 0) && <li>（无）</li>}
                    </ul>
                  </div>
                </div>
              </div>
            ) : null}

            {/* 3) 可落地整改清单：永远展示（AI 优先，失败则规则兜底） */}
            <h4>可落地整改清单（按规则命中项逐条给改写）</h4>

            {Array.isArray(fixesToShow) && fixesToShow.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {fixesToShow.map((it, idx) => (
                  <div key={idx} style={{ border: "1px solid #eee", borderRadius: 10, padding: 12 }}>
                    <div style={{ fontWeight: 700, marginBottom: 6 }}>
                      #{idx + 1}｜rule_id：{it.rule_id}｜页：{it.page}
                    </div>

                    {Array.isArray(it.quote) && it.quote.length > 0 && (
                      <div style={{ marginBottom: 6 }}>
                        <div style={{ color: "#666", fontSize: 13, marginBottom: 4 }}>定位原文（quote）</div>
                        <ul style={{ margin: 0, paddingLeft: 18 }}>
                          {it.quote.slice(0, 3).map((q, i) => (
                            <li key={i} style={{ whiteSpace: "pre-wrap" }}>
                              {q}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {it.problem && (
                      <div style={{ marginBottom: 6 }}>
                        <div style={{ color: "#666", fontSize: 13, marginBottom: 4 }}>问题说明</div>
                        <div style={{ whiteSpace: "pre-wrap" }}>{it.problem}</div>
                      </div>
                    )}

                    <div>
                      <div style={{ color: "#666", fontSize: 13, marginBottom: 4 }}>改写建议（before → after）</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {(it.rewrite || []).slice(0, 3).map((rw, i) => (
                          <div key={i} style={{ background: "#f7f7f7", borderRadius: 8, padding: 10 }}>
                            <div style={{ fontSize: 13, color: "#666", marginBottom: 4 }}>
                              动作：{rw.action || "（无）"}
                            </div>
                            <div style={{ fontSize: 13, color: "#666" }}>before：</div>
                            <div style={{ whiteSpace: "pre-wrap", marginBottom: 6 }}>{rw.before || "（缺失/无）"}</div>
                            <div style={{ fontSize: 13, color: "#666" }}>after：</div>
                            <div style={{ whiteSpace: "pre-wrap", fontWeight: 600 }}>{rw.after || "（无）"}</div>
                          </div>
                        ))}
                        {(!it.rewrite || it.rewrite.length === 0) && (
                          <div style={{ background: "#f7f7f7", borderRadius: 8, padding: 10, color: "#666" }}>
                            （未返回改写建议）
                          </div>
                        )}
                      </div>
                    </div>

                    {it.note && (
                      <div style={{ marginTop: 8 }}>
                        <div style={{ color: "#666", fontSize: 13, marginBottom: 4 }}>备注</div>
                        <div style={{ whiteSpace: "pre-wrap" }}>{it.note}</div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ color: "#666" }}>（未命中任何规则问题，暂无整改项）</div>
            )}

            {/* 4) AI 额外发现 */}
            <h4 style={{ marginTop: 14 }}>AI 额外发现（规则未覆盖/漏检的语义风险）</h4>
            {Array.isArray(ai?.ai_extra) && ai.ai_extra.length > 0 ? (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {ai.ai_extra.slice(0, 10).map((x, i) => (
                  <li key={i} style={{ whiteSpace: "pre-wrap" }}>
                    {typeof x === "string" ? x : JSON.stringify(x)}
                  </li>
                ))}
              </ul>
            ) : (
              <div style={{ color: "#666" }}>（无）</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

