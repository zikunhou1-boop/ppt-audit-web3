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
        setResult({ stage: "extract", extract });
        return;
      }

      // 2) Rules Audit
      const r2 = await fetch("/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pages: extract.pages })
      });
      const audit = await safeJson(r2);

      // 3) AI Review（report 模式：融合报告）
      let aiReport = null;
      const pagesText = (extract.pages || [])
        .map((p) => `【第${p.page || ""}页】\n${p.content || ""}`)
        .join("\n\n");

      // 读取 rules.json（前端 public/rules/rules.json 可直接 fetch）
      // 你的 rules.json 在 /rules/rules.json（和你之前用的一样）
      let rulesJson = "";
      try {
        const rr = await fetch("/rules/rules.json");
        rulesJson = await rr.text();
      } catch {
        rulesJson = "";
      }

      if (audit && typeof audit === "object") {
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
        aiReport = await safeJson(r3);
      }

      setResult({ stage: "done", extract, audit, aiReport });
    } catch (e) {
      setResult({ stage: "client_error", error: String(e?.message || e) });
    } finally {
      setLoading(false);
    }
  }

  const auditPass = result?.audit?.pass === true;
  const riskLevel = result?.audit?.risk_level || "unknown";
  const issues = result?.audit?.issues || [];
  const ai = result?.aiReport;

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

        <div style={{ marginTop: 12, color: "#666", fontSize: 13 }}>
          支持：ppt/pptx/docx/txt（图片识别暂未开启）
        </div>
      </div>

      <div style={{ marginTop: 18 }}>
        <h3>结果</h3>

        {!result && <div style={{ color: "#666" }}>上传文件后点击“一键审核”。</div>}

        {result && (result.stage === "extract" || result.stage === "client_error") && (
          <pre style={{ whiteSpace: "pre-wrap", background: "#f7f7f7", padding: 12, borderRadius: 8 }}>
            {JSON.stringify(result, null, 2)}
          </pre>
        )}

        {result && result.stage === "done" && (
          <>
            {/* 1) 规则结论（以 audit 为准） */}
            <div style={{ marginBottom: 10, fontWeight: 700 }}>
              规则审核：{auditPass ? "通过" : "不通过"}（risk_level：{riskLevel}）
            </div>

            {/* 2) 融合报告：优先展示可读 summary + rules_issues_fix */}
            {ai && ai.final_summary && (
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
            )}

            {/* 3) 对每条 rules issue 给“可直接改”的 before/after（来自 rules_issues_fix） */}
            <h4>可落地整改清单（按规则命中项逐条给改写）</h4>

            {Array.isArray(ai?.rules_issues_fix) && ai.rules_issues_fix.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {ai.rules_issues_fix.map((it, idx) => (
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
                            （AI 未返回改写建议）
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
              <div style={{ color: "#666" }}>
                （暂未生成融合整改清单。若 AI 返回的是旧结构，请确认 /api/ai_review 已启用 report 模式，并且前端已传 mode:"report"）
              </div>
            )}

            {/* 4) AI 额外发现（可选） */}
            <h4 style={{ marginTop: 14 }}>AI 额外发现（规则未覆盖/漏检的语义风险）</h4>
            {Array.isArray(ai?.ai_extra) && ai.ai_extra.length > 0 ? (
              <pre style={{ whiteSpace: "pre-wrap", background: "#f7f7f7", padding: 12, borderRadius: 8 }}>
                {JSON.stringify(ai.ai_extra, null, 2)}
              </pre>
            ) : (
              <div style={{ color: "#666" }}>（无）</div>
            )}

            {/* 5) 规则初审原始 issues（可折叠） */}
            <details style={{ marginTop: 14 }}>
              <summary style={{ cursor: "pointer" }}>查看规则命中 issues（原始 JSON）</summary>
              <pre style={{ whiteSpace: "pre-wrap", background: "#f7f7f7", padding: 12, borderRadius: 8 }}>
                {JSON.stringify(issues, null, 2)}
              </pre>
            </details>

            {/* 6) Debug：extract/audit/ai 原文（可折叠） */}
            <details style={{ marginTop: 10 }}>
              <summary style={{ cursor: "pointer" }}>调试信息（extract / audit / aiReport 原始）</summary>
              <pre style={{ whiteSpace: "pre-wrap", background: "#f7f7f7", padding: 12, borderRadius: 8 }}>
                {JSON.stringify({ extract: result.extract, audit: result.audit, aiReport: result.aiReport }, null, 2)}
              </pre>
            </details>
          </>
        )}
      </div>
    </div>
  );
}
