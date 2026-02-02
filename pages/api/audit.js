export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { pages } = req.body || {};
    if (!Array.isArray(pages) || pages.length === 0) {
      return res.status(400).json({ error: "pages is required" });
    }

    return res.status(200).json({ ok: true, pages_count: pages.length, sample: pages[0] });
  } catch (e) {
    return res.status(500).json({ error: String(e), stack: e?.stack });
  }
}
