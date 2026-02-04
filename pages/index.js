import { useState } from "react";
import JSZip from "jszip";

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
      .map((m) =>
        m[1]
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
      )
      .filter(Boolean);

    const n = Number(p.match(/slide(\d+)\.xml/)[1]);
    pages.push({ page: n, content: texts.join("\n") });
  }

  return pages;
}

export default function Home() {
  const [text, setText] = useState("");
  const [pptPages, setPptPages] = useState(null);
  const [fileName, setFileName] = useState("");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  async function onPickPptx(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    setResult(null);
    setFileName(file.name);

    try {
      const pages = await extractTextFromPptx(file);
      setPptPages(pages);

      const merged = pages.map((p) => `【第${p.page}页】\n${p.content}`).join("\n\n");
      setText(merged);
    } catch (err) {
      setResult({ error: String(err) });
      setPptPages(null);
      setFileName("");
    } finally {
      setLoading(false);
    }
  }

  async function onAudit() {
    setLoading(true);
    setResult(null);

    const pagesPayload =
      Array.isArray(pptPages) && pptPages.length > 0
        ? pptPages
        : [{ page: 1, content: text }];

    try {
      const resp = await fetch("/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pages: pagesPayload })
      });

      const raw = await resp.text();
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        data = { http_status: resp.status, raw };
      }
      setResult(data);
    } catch (e) {
      setResult({ error: String(e) });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 980, margin: "40px auto", fontFamily: "sans-serif" }}>
      <h2>课件合规自动初审（规则版）</h2>

      <div style={{ marginBottom: 12, display: "flex", gap: 12, alignItems: "center" }}>
        <input type="file" accept=".pptx" onChange={onPickPptx} disabled={loading} />
        <span style={{ color: "#666" }}>
          {fileName ? `已选择：${fileName}` : "未选择PPTX"}
        </span>
        {pptPages && pptPages.length > 0 ? (
          <span style={{ color: "#666" }}>已解析页数：{pptPages.length}</span>
        ) : null}
      </div>

      <textarea
        rows={14}
        style={{ width: "100%", padding: 12, fontSize: 14 }}
        placeholder="粘贴课件文字，或上传PPTX自动抽取文字"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setPptPages(null);
          setFileName("");
        }}
      />

      <div style={{ marginTop: 12, display: "flex", gap: 12 }}>
        <button
          type="button"
          onClick={onAudit}
          disabled={loading || (!text.trim() && !(pptPages && pptPages.length))}
        >
          {loading ? "审核中..." : "开始审核"}
        </button>

        <button
          type="button"
          onClick={() => {
            setText("");
            setPptPages(null);
            setFileName("");
            setResult(null);
          }}
          disabled={loading}
        >
          清空
        </button>

        <button
          type="button"
          onClick={() => {
            setText("本产品预期收益高，安全稳健，复利滚存，保证收益。短期健康险可自动续保，终身限额500万。");
            setPptPages(null);
            setFileName("");
          }}
          disabled={loading}
        >
          填充测试文本
        </button>
      </div>

      <div style={{ marginTop: 24 }}>
        <h3>审核结果</h3>
        <pre style={{ background: "#f6f6f6", padding: 12, overflow: "auto" }}>
          {result ? JSON.stringify(result, null, 2) : "暂无"}
        </pre>
      </div>
    </div>
  );
}
