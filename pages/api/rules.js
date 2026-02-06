import fs from "fs";
import path from "path";

export default function handler(req, res) {
  try {
    // 规则文件在仓库根目录：rules.json
    const p = path.join(process.cwd(), "rules.json");
    const text = fs.readFileSync(p, "utf-8");
    res.status(200).json({ ok: true, rulesJson: text });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
}
