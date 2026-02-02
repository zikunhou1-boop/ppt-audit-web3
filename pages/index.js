import { useState } from "react";

export default function Home() {
  const [text, setText] = useState("");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  async function onAudit() {
    setLoading(true);
    setResult(null);
    try {
      const resp = await fetch("/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pages: [{ page: 1, content: text }] })
      });

      const raw = await resp.text();
      let data;
      try { data = JSON.parse(raw); }
      catch { data = { http_status: resp.status, raw }; }

      setResult(data);
    } catch (e) {
      setResult({ error: String(e) });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 920, margin: "40px auto", fontFamily: "sans-serif" }}>
      <h2>课件合规自动初审</h2>

      <textarea
        rows={14}
        style={{ width: "100%", padding: 12, fontSize: 14 }}
        placeholder="粘贴课件文字（先用文字验证接口）"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />

      <div style={{ marginTop: 12, display: "flex", gap: 12 }}>
        <button
          type="button"              // 关键：必须是 button，避免变成 GET
          onClick={onAudit}
          disabled={loading || !text.trim()}
        >
          {loading ? "审核中..." : "开始审核"}
        </button>

        <button
          type="button"
          onClick={() => { setText(""); setResult(null); }}
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
