import { useState } from "react";

export default function Home() {
  const [file, setFile] = useState(null);
  const [pages, setPages] = useState([]);
  const [extractResult, setExtractResult] = useState(null);

  const [auditResult, setAuditResult] = useState(null);
  const [aiResult, setAiResult] = useState(null);

  const [loadingExtract, setLoadingExtract] = useState(false);
  const [loadingAudit, setLoadingAudit] = useState(false);
  const [loadingAI, setLoadingAI] = useState(false);

  async function onExtract() {
    if (!file) {
      alert("请先选择文件（ppt/pptx/docx/txt）");
      return;
    }
    setLoadingExtract(true);
    setExtractResult(null);
    setPages([]);
    setAuditResult(null);
    setAiResult(null);

    try {
      const fd = new FormData();
      fd.append("file", file);

      const r = await fetch("/api/extract", {
        method: "POST",
        body: fd
      });
      const j = await r.json();
      setExtractResult(j);

      if (j && j.ok && Array.isArray(j.pages)) {
        setPages(j.pages);
      }
    } catch (e) {
      setExtractResult({ error: String(e) });
    } finally {
      setLoadingExtract(false);
    }
  }

  async function onAudit() {
    if (!pages || pages.length === 0) {
      alert("请先提取内容（Extract）");
      return;
    }
    setLoadingAudit(true);
    setAuditResult(null);
    setAiResult(null);

    try {
      const r = await fetch("/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pages })
      });
      const j = await r.json();
      setAuditResult(j);
    } catch (e) {
      setAuditResult({ error: String(e) });
    } finally {
      setLoadingAudit(false);
    }
  }

  async function onAIReview() {
    if (!auditResult) {
      alert("请先完成规则审核（Audit）");
      return;
    }
    if (!auditResult?.issues || auditResult.issues.length === 0) {
      alert("当前没有 issues，AI 复核没有目标");
      return;
    }

    setLoadingAI(true);
    setAiResult(null);

    try {
      const text = (pages || []).map((p) => p.content || "").join("\n");

      const r = await fetch("/api/ai_review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          issues: auditResult.issues,
          review: auditResult.review || []
        })
      });

      const j = await r.json();
      setAiResult(j);
    } catch (e) {
      setAiResult({ error: String(e) });
    } finally {
      setLoadingAI(false);
    }
  }

  async function onTestAI() {
    setLoadingAI(true);
    setAiResult(null);
    try {
      const r = await fetch("/api/ai_review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "这是一个测试文本，保险产品，100%保证收益。",
          issues: [
            {
              page: 1,
              rule_id: "6-18",
              severity: "medium",
              type: "forbidden_terms",
              hit: "100%",
              reason: "禁止使用绝对化/最高级用语",
              suggestion: "删除绝对化/最高级用语，改为可证实的客观描述并保留依据。",
              message: "疑似使用绝对化/最高级用语。"
            }
          ],
          review: []
        })
      });
      const j = await r.json();
      setAiResult(j);
    } catch (e) {
      setAiResult({ error: String(e) });
    } finally {
      setLoadingAI(false);
    }
  }

  return (
    <div style={{ maxWidth: 980, margin: "24px auto", padding: 16, fontFamily: "system-ui, -apple-system" }}>
      <h2>课件合规初审（规则 + AI）</h2>

      <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 8 }}>
        <div style={{ marginBottom: 10 }}>
          <input
            type="file"
            accept=".ppt,.pptx,.docx,.txt"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={onExtract} disabled={loadingExtract}>
            {loadingExtract ? "提取中..." : "1) Extract 提取内容"}
          </button>

          <button onClick={onAudit} disabled={loadingAudit || pages.length === 0}>
            {loadingAudit ? "审核中..." : "2) Audit 规则审核"}
          </button>

          <button onClick={onAIReview} disabled={loadingAI || !auditResult}>
            {loadingAI ? "AI 复核中..." : "3) AI 复核（对 issues 出改写）"}
          </button>

          <button onClick={onTestAI} disabled={loadingAI} style={{ marginLeft: 8 }}>
            测试 AI 接口
          </button>
        </div>
      </div>

      <div style={{ marginTop: 18 }}>
        <h3>Extract 结果</h3>
        <pre style={{ whiteSpace: "pre-wrap", background: "#f7f7f7", padding: 12, borderRadius: 8 }}>
          {JSON.stringify(extractResult, null, 2)}
        </pre>
      </div>

      <div style={{ marginTop: 18 }}>
        <h3>提取到的 pages（前 3 页预览）</h3>
        <pre style={{ whiteSpace: "pre-wrap", background: "#f7f7f7", padding: 12, borderRadius: 8 }}>
          {JSON.stringify((pages || []).slice(0, 3), null, 2)}
        </pre>
      </div>

      <div style={{ marginTop: 18 }}>
        <h3>规则审核结果 Audit</h3>
        <pre style={{ whiteSpace: "pre-wrap", background: "#f7f7f7", padding: 12, borderRadius: 8 }}>
          {JSON.stringify(auditResult, null, 2)}
        </pre>
      </div>

      <div style={{ marginTop: 18 }}>
        <h3>AI 自动复核（原样返回）</h3>
        <pre style={{ whiteSpace: "pre-wrap", background: "#f7f7f7", padding: 12, borderRadius: 8 }}>
          {JSON.stringify(aiResult, null, 2)}
        </pre>
      </div>
    </div>
  );
}
