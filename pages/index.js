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

function Badge({ text, tone }) {
  const bg =
    tone === "high" ? "#ffe1e1" : tone === "medium" ? "#fff2cc" : "#e7f6e7";
  const fg =
    tone === "high" ? "#a40000" : tone === "medium" ? "#7a5a00" : "#0f5a0f";
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 999,
        background: bg,
        color: fg,
        fontSize: 12,
        lineHeight: "18px"
      }}
    >
      {text}
    </span>
  );
}

function groupIssuesByPage(issues) {
  const map = new Map();
  for (const it of issues || []) {
    const p = it.page || 1;
    if (!map.has(p)) map.set(p, []);
    map.get(p).push(it);
  }
  return Array.from(map.entries()).sort((a, b) => a[0] - b[0]);
}

function formatRisk(risk) {
  if (risk === "high") return "高";
  if (risk === "medium") return "中";
  if (risk === "low") return "低";
  return String(risk || "");
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

  const issues = result?.issues || [];
  const review = result?.review || [];
  const grouped = groupIssuesByPage(issues);

  return (
    <div style={{ maxWidth: 1060, margin: "40px auto", fontFamily: "sans-serif" }}>
      <h2 style={{ marginBottom: 8 }}>课件合规自动初审（规则版）</h2>
      <div style={{ color: "#666", marginBottom: 16, fontSize: 13 }}>
        支持：PPTX/DOCX（抽取文字层）→ 规则审核 → 输出可读报告
      </div>

      <div style={{ marginBottom: 12, display: "flex", gap: 12, alignItems: "center" }}>
        <input type="file" accept=".pptx,.docx" onChange={onPickFile} disabled={loading} />
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
        rows={10}
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

        <button
          type="button"
          onClick={() => {
            setText("本产品计划第一，预期收益高，安全稳健。");
            setPagesPayload(null);
            setFileName("");
            setFileType("");
          }}
          disabled={loading}
        >
          填充测试文本
        </button>
      </div>

      {/* 报告区 */}
      <div style={{ marginTop: 24 }}>
        <h3 style={{ marginBottom: 10 }}>审核报告</h3>

        {!result ? (
          <div style={{ color: "#666" }}>暂无结果</div>
        ) : result.error ? (
          <pre style={{ background: "#f6f6f6", padding: 12, overflow: "auto" }}>
            {JSON.stringify(result, null, 2)}
          </pre>
        ) : (
          <div style={{ display: "grid", gap: 14 }}>
            {/* 总览 */}
            <div
              style={{
                border: "1px solid #eee",
                borderRadius: 10,
                padding: 14,
                background: "#fff"
              }}
            >
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <Badge text={result.pass ? "通过" : "不通过"} tone={result.pass ? "low" : "high"} />
                <Badge text={`风险：${formatRisk(result.risk_level)}`} tone={result.risk_level} />
                <span style={{ color: "#666", fontSize: 13 }}>
                  规则版本：{result.rule_version || "-"}；命中：{issues.length} 条；复核项：{review.length} 条
                </span>
              </div>
            </div>

            {/* 违规清单 */}
            <div
              style={{
                border: "1px solid #eee",
                borderRadius: 10,
                padding: 14,
                background: "#fff"
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <h4 style={{ margin: 0 }}>自动判定问题（issues）</h4>
                <span style={{ color: "#666", fontSize: 13 }}>按页分组展示</span>
              </div>

              {issues.length === 0 ? (
                <div style={{ color: "#666" }}>未命中自动判定问题</div>
              ) : (
                grouped.map(([pageNo, items]) => (
                  <div key={pageNo} style={{ marginBottom: 14 }}>
                    <div style={{ fontWeight: 700, marginBottom: 8 }}>第 {pageNo} 页</div>
                    <div style={{ display: "grid", gap: 10 }}>
                      {items.map((it, idx) => (
                        <div
                          key={`${it.rule_id}-${idx}`}
                          style={{
                            border: "1px solid #f0f0f0",
                            borderRadius: 10,
                            padding: 12,
                            background: "#fafafa"
                          }}
                        >
                          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                            <Badge text={it.severity === "high" ? "高风险" : "中风险"} tone={it.severity} />
                            <span style={{ fontWeight: 700 }}>{it.rule_id}</span>
                            <span style={{ color: "#333" }}>{it.reason || it.title}</span>
                          </div>

                          <div style={{ marginTop: 8, color: "#333" }}>
                            <div style={{ fontSize: 13, color: "#666" }}>命中内容</div>
                            <div style={{ whiteSpace: "pre-wrap" }}>{it.hit}</div>
                          </div>

                          <div style={{ marginTop: 8, color: "#333" }}>
                            <div style={{ fontSize: 13, color: "#666" }}>问题说明</div>
                            <div style={{ whiteSpace: "pre-wrap" }}>{it.message}</div>
                          </div>

                          <div style={{ marginTop: 8, color: "#333" }}>
                            <div style={{ fontSize: 13, color: "#666" }}>修改建议</div>
                            <div style={{ whiteSpace: "pre-wrap" }}>{it.suggestion}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* 复核项 */}
            <div
              style={{
                border: "1px solid #eee",
                borderRadius: 10,
                padding: 14,
                background: "#fff"
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <h4 style={{ margin: 0 }}>需要复核的问题（review）</h4>
                <span style={{ color: "#666", fontSize: 13 }}>
                  这些点需要人工判断或后续接入AI复核
                </span>
              </div>

              {review.length === 0 ? (
                <div style={{ color: "#666" }}>无复核项</div>
              ) : (
                <div style={{ display: "grid", gap: 10 }}>
                  {review.map((r) => (
                    <div
                      key={r.rule_id}
                      style={{
                        border: "1px solid #f0f0f0",
                        borderRadius: 10,
                        padding: 12,
                        background: "#fafafa"
                      }}
                    >
                      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                        <Badge text={r.severity === "high" ? "高" : "中"} tone={r.severity} />
                        <span style={{ fontWeight: 700 }}>{r.rule_id}</span>
                        <span style={{ color: "#333" }}>{r.title}</span>
                      </div>

                      <div style={{ marginTop: 8 }}>
                        <div style={{ fontSize: 13, color: "#666" }}>复核要点</div>
                        <ul style={{ marginTop: 6 }}>
                          {(r.review_points || []).map((p, idx) => (
                            <li key={idx}>{p}</li>
                          ))}
                        </ul>
                      </div>

                      <div style={{ marginTop: 8 }}>
                        <div style={{ fontSize: 13, color: "#666" }}>处理建议</div>
                        <div style={{ whiteSpace: "pre-wrap" }}>{r.instruction}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 原始JSON折叠查看 */}
            <details style={{ border: "1px solid #eee", borderRadius: 10, padding: 14, background: "#fff" }}>
              <summary style={{ cursor: "pointer" }}>查看原始 JSON</summary>
              <pre style={{ background: "#f6f6f6", padding: 12, overflow: "auto", marginTop: 10 }}>
                {JSON.stringify(result, null, 2)}
              </pre>
            </details>
          </div>
        )}
      </div>
    </div>
  );
}

