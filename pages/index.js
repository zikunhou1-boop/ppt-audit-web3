import { useState } from "react";
import JSZip from "jszip";
import mammoth from "mammoth/mammoth.browser";

// -------- PPTX 解析：按 slide 抽文字 --------
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

// -------- DOCX 解析：抽全文纯文本（先当作第1页）--------
async function extractTextFromDocx(file) {
  const arrayBuffer = await file.arrayBuffer();
  const { value } = await mammoth.extractRawText({ arrayBuffer });
  const text = (value || "").trim();
  return [{ page: 1, content: text }];
}

export default function Home() {
  const [text, setText] = useState("");
  const [pagesPayload, setPagesPayload] = useState(null); // [{page, content}]
  const [fileName, setFileName] = useState("");
  const [fileType, setFileType] = useState(""); // pptx/docx
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  async function onPickFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    const name = file.name || "";
    const lower = name.toLowerCase();

    setLoading(true);
    setResult(null);
    setFileName(name);

    try {
      let pages;
      if (lower.endsWith(".pptx")) {
        setFileType("pptx");
        pages = await extractTextFromPptx(file);
      } else if (lower.endsWith(".docx")) {
        setFileType("docx");
        pages = await extractTextFromDocx(file);
      } else {
        throw new Error("仅支持 .pptx 或 .docx 文件");
      }

      setPagesPayload(pages);

      // 预览：把抽取文本放到输入框里
      const merged =
        pages.length > 1
          ? pages.map((p) => `【第${p.page}页】\n${p.content}`).join("\n\n")
          : pages[0].content;

      setText(merged);
    } catch (err) {
      setResult({ error: String(err) });
      setPagesPayload(null);
      setFileName("");
      setFileType("");
    } finally {
      setLoading(false);
    }
  }

  async function onAudit() {
    setLoading(true);
    setResult(null);

    const payload =
      Array.isArray(pagesPayload) && pagesPayload.length > 0
        ? pagesPayload
        : [{ page: 1, content: text }];

    try {
      const resp = await fetch("/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pages: payload })
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
        <input
          type="file"
          accept=".pptx,.docx"
          onChange={onPickFile}
          disabled={loading}
        />
        <span style={{ color: "#666" }}>
          {fileName ? `已选择：${fileName}` : "未选择文件（支持PPTX/DOCX）"}
        </span>
        {pagesPayload && pagesPayload.length > 0 ? (
          <span style={{ color: "#666" }}>
            {fileType === "pptx" ? `已解析页数：${pagesPayload.length}` : "已解析DOCX全文"}
          </span>
        ) : null}
      </div>

      <textarea
        rows={14}
        style={{ width: "100%", padding: 12, fontSize: 14 }}
        placeholder="粘贴课件文字，或上传PPTX/DOCX自动抽取文字"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setPagesPayload(null);
          setFileName("");
          setFileType("");
        }}
      />

      <div style={{ marginTop: 12, display: "flex", gap: 12 }}>
        <button
          type="button"
          onClick={onAudit}
          disabled={loading || (!text.trim() && !(pagesPayload && pagesPayload.length))}
        >
          {loading ? "审核中..." : "开始审核"}
        </button>

        <button
          type="button"
          onClick={() => {
            setText("");
            setPagesPayload(null);
            setFileName("");
            setFileType("");
            setResult(null);
          }}
          disabled={loading}
        >
          清空
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
