import { useState } from "react";

export default function Home() {
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);

  const [result, setResult] = useState(null); // 最终结果（extract + audit + ai）

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
      const raw1 = await r1.text();
      let extract;
      try {
        extract = JSON.parse(raw1);
      } catch {
        extract = { ok: false, http_status: r1.status, raw: raw1 };
      }

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
      const raw2 = await r2.text();
      let audit;
      try {
        audit = JSON.parse(raw2);
      } catch {
        audit = { ok: false, http_status: r2.status, raw: raw2 };
      }

      // 3) AI Review（仅当有 issues）
      let ai = null;
      if (audit && Array.isArray(audit.issues) && audit.issues.length > 0) {
        const text = (extract.pages || []).map((p) => p.content || "").join("\n");
        const r3 = await fetch("/api/ai_review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text,
            issues: audit.issues,
            review: audit.review || []
          })
        });
        const raw3 = await r3.text();
        try {
          ai = JSON.parse(raw3);
        } catch {
          ai = { ok: false, http_status: r3.status, raw: raw3 };
        }
      }

      setResult({ stage: "done", extract, audit, ai });
    } catch (e) {
      setResult({ stage: "client_error", error: String(e) });
    } finally {
      setLoading(false);
    }
  }

  const pass = result?.audit?.pass === true;

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
          {loading ? "审核中..." : "开始审核（自动提取 + 规则 + AI）"}
        </button>

        <div style={{ marginTop: 12, color: "#666", fontSize: 13 }}>
          支持：ppt/pptx/docx/txt（图片识别暂未开启）
        </div>
      </div>

      <div style={{ marginTop: 18 }}>
        <h3>结果</h3>

        {!result && <div style={{ color: "#666" }}>上传文件后点击“开始审核”。</div>}

        {result && result.stage === "extract" && (
          <pre style={{ whiteSpace: "pre-wrap", background: "#f7f7f7", padding: 12, borderRadius: 8 }}>
            {JSON.stringify(result, null, 2)}
          </pre>
        )}

        {result && result.stage === "client_error" && (
          <pre style={{ whiteSpace: "pre-wrap", background: "#f7f7f7", padding: 12, borderRadius: 8 }}>
            {JSON.stringify(result, null, 2)}
          </pre>
        )}

        {result && result.stage === "done" && (
          <>
            <div style={{ marginBottom: 8, fontWeight: 600 }}>
              规则审核：{pass ? "通过" : "不通过"}（risk_level：{result.audit?.risk_level || "unknown"}）
            </div>

            <h4>规则命中 issues（已去重/汇总后）</h4>
            <pre style={{ whiteSpace: "pre-wrap", background: "#f7f7f7", padding: 12, borderRadius: 8 }}>
              {JSON.stringify(result.audit?.issues || [], null, 2)}
            </pre>

            <h4>AI 改写建议（对 issues 输出 before/after）</h4>
            <pre style={{ whiteSpace: "pre-wrap", background: "#f7f7f7", padding: 12, borderRadius: 8 }}>
              {JSON.stringify(result.ai || null, null, 2)}
            </pre>
          </>
        )}
      </div>
    </div>
  );
}
