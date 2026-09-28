from pathlib import Path

p = Path("src/md_docx.rs")
t = p.read_text(encoding="utf-8")
needle = "    fn standalone_html_has_table_css() {"
if "probe_html_table_escape" in t:
    print("already patched")
else:
    # Avoid &lt; in surrounding tooling by building the escape marker in Rust.
    probe = (
        "    #[test]\n"
        "    fn probe_html_table_escape() {\n"
        '        let md = "before\\n\\n<table style=\\"writing-mode: vertical-rl\\">'
        "<tr><th>jia</th><td>1</td></tr></table>\\n\\nafter\\n\";\n"
        "        let html = markdown_to_github_html(md).unwrap();\n"
        '        eprintln!("HAS_RAW_TABLE={}", html.contains("<table"));\n'
        '        let escaped = format!("{}{}", "&lt;", "table");\n'
        '        eprintln!("HAS_ESCAPED={}", html.contains(&escaped));\n'
        '        let idx = html.find("before").unwrap_or(0);\n'
        '        eprintln!("SNIP={}", &html[idx..(idx + 500).min(html.len())]);\n'
        "    }\n\n"
    )
    p.write_text(t.replace(needle, probe + needle, 1), encoding="utf-8")
    print("patched")
