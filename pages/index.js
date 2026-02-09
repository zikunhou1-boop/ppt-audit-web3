// pages/index.js
import { useState } from "react";

export default function Home() {
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);

  // 最终结果：extract + audit + aiReport + semantic
  const [result, setResult] = useState(null);

  async function safeJson(resp) {
    const raw = await resp.text();
    try {
      return JSON.parse(raw);
    } catch {
      return { ok: false, http_status: resp.status, raw };
    }
  }

  // ✅ 判定“AI 是否生效”：ok:true 且 rules_issues_fix 非空
  function isReportEffective(aiReportRaw) {
    if (!aiReportRaw || typeof aiReportRaw !== "object") return false;
    if (aiReportRaw.ok !== true) return false;
    if (!Array.isArray(aiReportRaw.rules_issues_fix) || aiReportRaw.rules_issues_fix.length === 0) return false;
    return true;
  }

  // ✅ 规范化成 report 结构（只做展示转换，不做“兜底伪装成AI”）
  function normalizeAiReport(aiReportRaw) {
    if (!aiReportRaw || typeof aiReportRaw !== "object") return null;

    // 已是 report 结构
    if (aiReportRaw?.final_summary && Array.isArray(aiReportRaw?.rules_issues_fix)) {
      return {
        ok: aiReportRaw.ok === true,
        final_summary: aiReportRaw.final_summary,
        rules_issues_fix: aiReportRaw.rules_issues_fix,
        ai_extra: Array.isArray(aiReportRaw.ai_extra) ? aiReportRaw.ai_extra : []
      };
    }

    // 兼容旧结构：{ ai: [...] }（转换成 report 结构展示）
    const legacy = aiReportRaw?.ai;
    if (Array.isArray(legacy)) {
      return {
        ok: true,
        final_summary: { overall: "", top_risks: [], next_actions: [] },
        rules_issues_fix: legacy.map((x) => ({
          rule_id: x.rule_id,
          page: x.page ?? null,
          quote: Array.isArray(x.quote) ? x.quote.slice(0, 3) : [],
          problem: x.problem || "",
          rewrite: Array.isArray(x.rewrite_suggestion)
            ? x.rewrite_suggestion.slice(0, 3).map((r) => ({
                action: r.action || "修改/补充",
                before: r.before || "",
                after: r.after || ""
              }))
            : [],
          note: x.notes || ""
        })),
        ai_extra: []
      };
    }

    return null;
  }

  // ✅ 语义扫描是否有效：ok:true 且 ai_extra 是数组（可空也算有效）
  function isSemanticEffective(semanticRaw) {
    if (!semanticRaw || typeof semanticRaw !== "object") return false;
    if (semanticRaw.ok !== true) return false;
    if (!Array.isArray(semanticRaw.ai_extra)) return false;
    return true;
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
  setResult({
    stage: "error",
    message: `提取失败：未获取到页面内容（/api/extract 返回 ${r1.status}）`,
    detail: extract
  });
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

      // 3) 拼全文
      const pagesText = (extract.pages || [])
        .map((p) => `【第${p.page || ""}页】\n${p.content || ""}`)
        .join("\n\n");

      // 4) 取 rulesJson（从后端接口取）
      let rulesJson = "";
      let rulesOk = false;
      try {
        const rr = await fetch("/api/rules");
        const j = await safeJson(rr);
        rulesJson = j?.rulesJson || "";
        rulesOk = typeof rulesJson === "string" && rulesJson.trim().length > 0;
      } catch {
        rulesJson = "";
        rulesOk = false;
      }

      // 5) AI report（整改清单）
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
      const aiReport = normalizeAiReport(aiReportRaw);
      const aiUsed = isReportEffective(aiReportRaw);

      // 6) AI semantic（全篇语义扫描）
      const r4 = await fetch("/api/ai_review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "semantic",
          pagesText,
          audit,
          rulesJson,
          ocrText: "" // 先空，OCR 后续接入再传
        })
      });
      const semanticRaw = await safeJson(r4);
      const semanticUsed = isSemanticEffective(semanticRaw);
      const semanticExtra = semanticUsed ? semanticRaw.ai_extra : [];

      setResult({
        stage: "done",
        extract,
        audit,
        rulesOk,

        // report
        aiReport,
        aiUsed,
        aiHttpStatus: r3.status,
        aiRaw: aiReportRaw,

        // semantic
        semanticUsed,
        semanticHttpStatus: r4.status,
        semanticRaw,
        semanticExtra
      });
    } catch (e) {
      setResult({ stage: "error", message: "客户端异常", detail: String(e?.message || e) });
    } finally {
      setLoading(false);
    }
  }

  const auditPass = result?.audit?.pass === true;
  const riskLevel = result?.audit?.risk_level || "unknown";
  const ai = result?.aiReport;
  const fixesToShow = result?.aiUsed && Array.isArray(ai?.rules_issues_fix) ? ai.rules_issues_fix : [];

  // UI：尽量少技术词（你后面要美化可以再改）
  return (
    <div style={{ maxWidth: 920, margin: "28px auto", padding: 16, fontFamily: "system-ui, -apple-system" }}>
      <h2 style={{ margin: "0 0 12px 0" }}>课件合规审核</h2>

      <div style={{ border: "1px solid #e6e6e6", borderRadius: 14, padding: 14, background: "#fff" }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <input
            type="file"
            accept=".ppt,.pptx,.docx,.txt"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            style={{ flex: "1 1 320px" }}
          />

          <button
            onClick={onRun}
            disabled={loading}
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid #ddd",
              background: loading ? "#f3f3f3" : "#111",
              color: loading ? "#666" : "#fff",
              cursor: loading ? "not-allowed" : "pointer"
            }}
          >
            {loading ? "处理中..." : "开始审核"}
          </button>
        </div>

        <div style={{ marginTop: 10, color: "#777", fontSize: 13 }}>
          支持：ppt/pptx/docx/txt（OCR 后续接入）
        </div>
      </div>

      <div style={{ marginTop: 18 }}>
        <h3 style={{ margin: "0 0 10px 0" }}>结果</h3>

        {!result && <div style={{ color: "#777" }}>选择文件后点击“开始审核”。</div>}

        {result?.stage === "error" && (
          <div style={{ border: "1px solid #ffd2d2", background: "#fff5f5", borderRadius: 14, padding: 12 }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>失败</div>
            <div style={{ whiteSpace: "pre-wrap" }}>{result.message || "（无）"}</div>
          </div>
        )}

        {result?.stage === "done" && (
          <>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
              <div
                style={{
                  padding: "8px 10px",
                  borderRadius: 999,
                  border: "1px solid #eee",
                  background: "#fafafa",
                  fontSize: 13
                }}
              >
                规则结论：<b>{auditPass ? "通过" : "不通过"}</b>（{riskLevel}）
              </div>

              <div
                style={{
                  padding: "8px 10px",
                  borderRadius: 999,
                  border: "1px solid #eee",
                  background: "#fafafa",
                  fontSize: 13
                }}
              >
                规则库：<b>{result.rulesOk ? "正常" : "异常"}</b>
              </div>

              <div
                style={{
                  padding: "8px 10px",
                  borderRadius: 999,
                  border: "1px solid #eee",
                  background: "#fafafa",
                  fontSize: 13
                }}
              >
                AI整改：<b>{result.aiUsed ? "已生效" : "未生效"}</b>
              </div>

              <div
                style={{
                  padding: "8px 10px",
                  borderRadius: 999,
                  border: "1px solid #eee",
                  background: "#fafafa",
                  fontSize: 13
                }}
              >
                AI语义扫描：<b>{result.semanticUsed ? "已生效" : "未生效"}</b>
              </div>
            </div>

            {/* AI 未生效原因（report） */}
            {!result.aiUsed && result.aiRaw && (
              <div style={{ border: "1px solid #eee", background: "#fafafa", borderRadius: 14, padding: 10, marginBottom: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>AI整改未生效原因</div>
                <div style={{ whiteSpace: "pre-wrap", fontSize: 13, color: "#444" }}>
                  {result.aiRaw.error || result.aiRaw.detail || "（无 error/detail 字段）"}
                </div>
                {result.aiRaw.http_status ? (
                  <div style={{ marginTop: 6, fontSize: 12, color: "#666" }}>DeepSeek http_status：{result.aiRaw.http_status}</div>
                ) : null}
              </div>
            )}

            {/* AI 未生效原因（semantic） */}
            {!result.semanticUsed && result.semanticRaw && (
              <div style={{ border: "1px solid #eee", background: "#fafafa", borderRadius: 14, padding: 10, marginBottom: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>AI语义扫描未生效原因</div>
                <div style={{ whiteSpace: "pre-wrap", fontSize: 13, color: "#444" }}>
                  {result.semanticRaw.error || result.semanticRaw.detail || "（无 error/detail 字段）"}
                </div>
                {result.semanticRaw.http_status ? (
                  <div style={{ marginTop: 6, fontSize: 12, color: "#666" }}>DeepSeek http_status：{result.semanticRaw.http_status}</div>
                ) : null}
              </div>
            )}

            {/* 融合报告（report） */}
            {result.aiUsed && ai?.final_summary ? (
              <div style={{ border: "1px solid #eee", borderRadius: 14, padding: 12, marginBottom: 12, background: "#fff" }}>
                <div style={{ fontWeight: 800, marginBottom: 10 }}>融合报告</div>

                <div style={{ marginBottom: 10 }}>
                  <div style={{ color: "#777", fontSize: 13, marginBottom: 4 }}>总体结论</div>
                  <div style={{ whiteSpace: "pre-wrap" }}>{ai.final_summary.overall || "（无）"}</div>
                </div>

                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <div style={{ flex: "1 1 260px" }}>
                    <div style={{ color: "#777", fontSize: 13, marginBottom: 4 }}>关键风险</div>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {(ai.final_summary.top_risks || []).slice(0, 3).map((x, i) => (
                        <li key={i}>{x}</li>
                      ))}
                      {(!ai.final_summary.top_risks || ai.final_summary.top_risks.length === 0) && <li>（无）</li>}
                    </ul>
                  </div>

                  <div style={{ flex: "1 1 260px" }}>
                    <div style={{ color: "#777", fontSize: 13, marginBottom: 4 }}>下一步建议</div>
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

            {/* 可落地整改清单（report） */}
            <h4 style={{ margin: "12px 0 8px 0" }}>可落地整改清单</h4>

            {fixesToShow.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {fixesToShow.map((it, idx) => (
                  <div key={idx} style={{ border: "1px solid #eee", borderRadius: 14, padding: 12, background: "#fff" }}>
                    <div style={{ fontWeight: 800, marginBottom: 8 }}>
                      #{idx + 1}｜rule_id：{it.rule_id}｜页：{it.page}
                    </div>

                    {Array.isArray(it.quote) && it.quote.length > 0 && (
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ color: "#777", fontSize: 13, marginBottom: 4 }}>定位原文</div>
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
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ color: "#777", fontSize: 13, marginBottom: 4 }}>问题说明</div>
                        <div style={{ whiteSpace: "pre-wrap" }}>{it.problem}</div>
                      </div>
                    )}

                    <div>
                      <div style={{ color: "#777", fontSize: 13, marginBottom: 6 }}>改写建议</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {(it.rewrite || []).slice(0, 3).map((rw, i) => (
                          <div key={i} style={{ background: "#f7f7f7", borderRadius: 12, padding: 10 }}>
                            <div style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>
                              动作：{rw.action || "（无）"}
                            </div>
                            <div style={{ fontSize: 12, color: "#666" }}>before：</div>
                            <div style={{ whiteSpace: "pre-wrap", marginBottom: 6 }}>{rw.before || "（无）"}</div>
                            <div style={{ fontSize: 12, color: "#666" }}>after：</div>
                            <div style={{ whiteSpace: "pre-wrap", fontWeight: 700 }}>{rw.after || "（无）"}</div>
                          </div>
                        ))}
                        {(!it.rewrite || it.rewrite.length === 0) && (
                          <div style={{ background: "#f7f7f7", borderRadius: 12, padding: 10, color: "#666" }}>
                            （AI 未返回改写建议）
                          </div>
                        )}
                      </div>
                    </div>

                    {it.note && (
                      <div style={{ marginTop: 8 }}>
                        <div style={{ color: "#777", fontSize: 13, marginBottom: 4 }}>备注</div>
                        <div style={{ whiteSpace: "pre-wrap" }}>{it.note}</div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ color: "#777" }}>{result.aiUsed ? "（AI 未返回可用整改清单）" : "（AI 整改未生效）"}</div>
            )}

            {/* 全篇语义扫描结果（semantic） */}
            <h4 style={{ margin: "14px 0 8px 0" }}>AI 语义风险补充（全篇扫描）</h4>

            {result.semanticUsed && Array.isArray(result.semanticExtra) && result.semanticExtra.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {result.semanticExtra.slice(0, 20).map((x, i) => (
                  <div key={i} style={{ border: "1px solid #eee", borderRadius: 14, padding: 12, background: "#fff" }}>
                    <div style={{ fontWeight: 800, marginBottom: 6 }}>
                      #{i + 1}｜{x.severity || "medium"}｜页：{x.page ?? "?"}
                    </div>
                    {x.problem ? (
                      <div style={{ marginBottom: 6, whiteSpace: "pre-wrap" }}>{x.problem}</div>
                    ) : null}
                    {Array.isArray(x.quote) && x.quote.length > 0 ? (
                      <div style={{ color: "#666", fontSize: 13, whiteSpace: "pre-wrap", marginBottom: 6 }}>
                        引用：{x.quote[0]}
                      </div>
                    ) : null}
                    {x.suggestion ? (
                      <div style={{ background: "#f7f7f7", borderRadius: 12, padding: 10 }}>
                        <div style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>建议改法：</div>
                        <div style={{ whiteSpace: "pre-wrap", fontWeight: 700 }}>{x.suggestion}</div>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ color: "#777" }}>
                {result.semanticUsed ? "（未发现额外语义风险）" : "（语义扫描未生效）"}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
