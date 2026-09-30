#!/usr/bin/env python3
import argparse
import json
import os
import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def safe_name(value):
    text = re.sub(r"[^\w\u4e00-\u9fff.-]+", "_", str(value or "unknown")).strip("_")
    return text or "unknown"


def load_font(size):
    candidates = [
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
        "/Library/Fonts/Arial Unicode.ttf",
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                pass
    return ImageFont.load_default()


def resize_to_width(image, width):
    if image.width == width:
        return image
    height = round(image.height * width / image.width)
    return image.resize((width, height), Image.LANCZOS)


def draw_header(width, title, subtitle):
    height = 150
    canvas = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(canvas)
    font_title = load_font(44)
    font_sub = load_font(24)
    draw.rectangle((0, 0, width, height), fill=(246, 248, 250))
    draw.text((32, 28), title, fill=(20, 24, 31), font=font_title)
    draw.text((32, 92), subtitle, fill=(90, 98, 112), font=font_sub)
    draw.line((0, height - 1, width, height - 1), fill=(220, 224, 230), width=2)
    return canvas


def stitch_candidate(draft, out_dir, index, stored_prefix=None):
    files = [Path(item) for item in draft.get("files", [])]
    images = []
    for file in files:
        with Image.open(file) as image:
            images.append(image.convert("RGB").copy())
    if not images:
        return None

    width = max(image.width for image in images)
    normalized = [resize_to_width(image, width) for image in images]
    facts = draft.get("facts", {})
    title = f"{index:02d} {draft.get('name') or '未命名'}"
    subtitle = " · ".join(
        part
        for part in [
            facts.get("work_years"),
            facts.get("degree"),
            facts.get("age"),
            facts.get("salary"),
            f"{len(files)} 张截图",
        ]
        if part
    )
    header = draw_header(width, title, subtitle)
    gap = 18
    total_height = header.height + sum(image.height for image in normalized) + gap * (len(normalized) - 1)
    canvas = Image.new("RGB", (width, total_height), (242, 244, 247))
    y = 0
    canvas.paste(header, (0, y))
    y += header.height
    for image in normalized:
        canvas.paste(image, (0, y))
        y += image.height + gap

    out_file = out_dir / f"{index:02d}_{safe_name(draft.get('name'))}_{safe_name(draft.get('draft_id'))}.jpg"
    canvas.save(out_file, "JPEG", quality=92, optimize=True)
    stored_file = str(Path(stored_prefix) / out_file.name) if stored_prefix else str(out_file)
    return {
        "index": index,
        "name": draft.get("name"),
        "draft_id": draft.get("draft_id"),
        "stitched_file": stored_file,
        "source_files": [str(file) for file in files],
        "source_file_names": [file.name for file in files],
        "facts": facts,
        "width": canvas.width,
        "height": canvas.height,
    }


def write_markdown(rows, out_file):
    lines = [
        "# Boss App 截图候选人拼合索引",
        "",
        f"候选人数：{len(rows)}",
        "",
        "| # | 候选人 | 截图数 | 年限 | 学历 | 年龄 | 薪资 | 拼合图 | 原始截图 |",
        "|---|---|---:|---|---|---|---|---|---|",
    ]
    for row in rows:
        facts = row.get("facts", {})
        rel_stitched = Path(row["stitched_file"]).name
        files = ", ".join(row.get("source_file_names", []))
        lines.append(
            "| {index} | {name} | {count} | {years} | {degree} | {age} | {salary} | [{file}]({link}) | {files} |".format(
                index=row["index"],
                name=row.get("name") or "",
                count=len(row.get("source_files", [])),
                years=facts.get("work_years") or "",
                degree=facts.get("degree") or "",
                age=facts.get("age") or "",
                salary=facts.get("salary") or "",
                file=Path(row["stitched_file"]).name,
                link=rel_stitched.replace(" ", "%20"),
                files=files,
            )
        )
    out_file.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description="Stitch Boss screenshot drafts by candidate.")
    parser.add_argument("--drafts", default="data/import/screenshot-drafts.json")
    parser.add_argument("--out-dir", default="data/import/stitched-candidates")
    parser.add_argument("--stored-prefix", default=None)
    args = parser.parse_args()

    drafts_path = Path(args.drafts)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    data = json.loads(drafts_path.read_text(encoding="utf-8"))
    rows = []
    for idx, draft in enumerate(data.get("drafts", []), start=1):
        row = stitch_candidate(draft, out_dir, idx, args.stored_prefix)
        if row:
            rows.append(row)

    index_json = out_dir / "index.json"
    index_md = out_dir / "index.md"
    index_json.write_text(json.dumps({"count": len(rows), "rows": rows}, ensure_ascii=False, indent=2), encoding="utf-8")
    write_markdown(rows, index_md)
    print(json.dumps({"ok": True, "count": len(rows), "index_json": str(index_json), "index_md": str(index_md)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
