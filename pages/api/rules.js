// pages/api/rules.js
import fs from "fs";
import path from "path";

export default function handler(req, res) {
  try {
    const p = path.join(process.cwd(), "rules", "rules.json");
    const text = fs.readFileSync(p, "utf-8");
    res.status(200).json({ ok: true, rulesJson: text });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
}
