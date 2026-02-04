import { useState } from "react";
import JSZip from "jszip";
import mammoth from "mammoth/mammoth.browser";

// -------- PPTX 解析 --------
async function extractTextFromPptx(file) {
  const buf = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);

  const slideFiles = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)\.xml/)[1]);
      const nb = Number(b.match(/slide(\d+)\.xml/)[1]);
      return na - nb;
    });

  const pages = [];
  for (const p of slideFiles) {
    const xml = await zip.file(p).async("string");
    const texts = Array.from(xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g))
      .map((m) => m[1])
      .filter(Boolean);
    const n = Number(p.match(/slide(\d+)\.xml/)[1]);
    pages.push({ page: n, content: texts.join("\n") });
  }
  return pages;
}

// -------- DOCX 解析 --------
async function extractTextFromDocx(file) {
  const arrayBuffer = await file.arrayBuffer();
  const { value } = await mammoth.extractRawText({ arrayBuffer });
  return [{ page: 1, content: (value || "").trim() }];
}

function Badge({ text, tone }) {
  const bg =
    tone === "high" ? "#ffe1e1" : tone === "medium" ? "#fff2cc" : "#e7f6e7";
  const fg =
    tone === "high" ? "#a40000" : tone === "medium" ? "#7a5a00" : "#0f5a0f";
  return (
    <span style={{ padding: "2px 8px", borderRadius: 999, background: bg, color: fg, fontSize: 12 }}>
      {text}
    </span>
  );
}

export default function Home() {
  const [text, setText] = useState("");
  const [pagesPayload, setPagesPayload] = useState(null);
  const [fileName, setFileName] = useState("");
  const [fileType, setFileType] = useState("");
  const [result, setResult] = useState(null);
  const [aiResult, setAiResult] = useState(null);
  const [loading, setLoading] = useState(false);

  async function onPickFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    setResult(null);
    setAiResult(null);
    setFileName(file.name);

    try {
      let pages;
      if (file.name.toLowerCase().endsWith(".pptx")) {
        setFileType("pptx");
        pages = await extractTextFromPptx(file);
      } else if (file.name.toLowerCase().endsWith(".docx")) {
        setFileType("docx");
        pages = await extractTextFromDocx(file);
      } else {
        throw new Error("仅支持 .pptx / .docx");
      }
      setPagesPayload(pages);
      setText(
        pages.length > 1
          ? pages.map((p) => `【第${p.page}页】\n${p.content}`).join("\n\n")
          : pages[0].content
      );
    } finally {
      setLoading(false);
    }
  }

  async function onAudit() {
    setLoading(true);
    setResult(null);
    setAiResult(null);

    const payload =
      pagesPayload && pagesPayload.length
        ? pagesPayload
        : [{ page: 1, content: text }];

    // 1️⃣ 规则审核
    const resp = await fetch("/api/audit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pages: payload })
    });
    const audit = await resp.json();
    setResult(audit);

    // 2️⃣ 若存在 review，自动 AI 复核
    if (audit?.review?.length) {
      const aiResp = await fetch("/api/ai_review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          review: audit.review
        })
      });
      const ai = await aiResp.json();
      setAiResult(ai);
    }

    setLoading(false);
  }

  return (
    <div style={{ maxWidth: 1000, margin: "40px auto", fontFamily: "sans-serif" }}>
      <h2>课件合规自动审核（规则 + AI 自动复核）</h2>

      <input type="file" accept=".pptx,.docx" onChange={onPickFile} />
      <textarea
        rows={10}
        style={{ width: "100%", marginTop: 12 }}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />

      <button onClick={onAudit} disabled={loading} style={{ marginTop: 12 }}>
        {loading ? "审核中…" : "开始审核"}
      </button>

      {/* 规则结果 */}
      {result && (
        <div style={{ marginTop: 24 }}>
          <h3>规则审核结果</h3>
          <Badge text={result.pass ? "通过" : "不通过"} tone={result.pass ? "low" : "high"} />
          <pre>{JSON.stringify(result.issues, null, 2)}</pre>
        </div>
      )}

      {/* AI 自动复核 */}
      {aiResult?.ai && (
        <div style={{ marginTop: 24 }}>
          <h3>AI 自动复核结论</h3>
          {aiResult.ai.map((r) => (
            <div key={r.rule_id} style={{ border: "1px solid #eee", padding: 12, marginBottom: 10 }}>
              <div><b>{r.rule_id}</b>｜结论：{r.verdict}</div>
              <div>原因：{r.reason}</div>
              <div>建议改写：{r.rewrite_suggestion}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
