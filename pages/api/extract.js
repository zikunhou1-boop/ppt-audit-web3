export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method Not Allowed" });
    }

    // 最小可用：先证明接口能跑通、前端不再炸 JSON
    return res.status(200).json({
      ok: true,
      pages_count: 1,
      pages: [{ page: 1, content: "extract ok" }],
    });
  } catch (e) {
    return res.status(200).json({
      ok: false,
      error: String(e),
      stack: e && e.stack ? String(e.stack) : "",
    });
  }
}

