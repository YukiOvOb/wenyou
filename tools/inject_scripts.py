# -*- coding: utf-8 -*-
"""把 scripts/ 里的内置剧本 JSON 写进 index.html 的 BUILTIN_SCRIPTS。

用法：python3 tools/inject_scripts.py
写入位置是 index.html 里 @generated-scripts:start 和 @generated-scripts:end 两行注释之间，
顺序按 ORDER（书架上内置剧本的顺序）。改完剧本的生成脚本后，先生成 JSON，再运行这个。
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ORDER = ["douluo-wuhundian", "hehuan-wenqing", "dushi-qianjin", "xianchao-quanmou"]

START = "/* @generated-scripts:start（tools/inject_scripts.py 从 scripts/*.json 写入，不要手改这一段） */\n"
END = "/* @generated-scripts:end */\n"


def main():
    path = os.path.join(ROOT, "index.html")
    html = open(path, encoding="utf-8").read()
    a = html.index(START) + len(START)
    b = html.index(END, a)
    blocks = []
    for sid in ORDER:
        f = os.path.join(ROOT, "scripts", sid + ".json")
        if not os.path.exists(f):
            print("跳过（还没有生成）：", sid)
            continue
        data = json.load(open(f, encoding="utf-8"))
        assert data.get("id") == sid, (f, data.get("id"))
        blocks.append(json.dumps(data, ensure_ascii=False, indent=1))
        print("写入：", sid, "v%s" % data.get("version", 1))
    html = html[:a] + "".join(x + ",\n" for x in blocks) + html[b:]
    open(path, "w", encoding="utf-8").write(html)


if __name__ == "__main__":
    main()
