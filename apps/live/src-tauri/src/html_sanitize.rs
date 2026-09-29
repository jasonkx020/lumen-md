//! HTML 消毒：对齐 Live「WebView2 解析 + XSS 擦除」策略。
//! 在 ammonia 默认标签集上扩展，而非替换成窄白名单。

use std::collections::HashSet;

use ammonia::Builder;

fn extra_tags() -> HashSet<&'static str> {
    [
        "picture",
        "source",
        "figure",
        "figcaption",
        "center",
        "font",
        "details",
        "summary",
        "section",
        "article",
        "header",
        "footer",
        "nav",
        "main",
        "aside",
        "mark",
        "kbd",
        "u",
        "s",
        "sub",
        "sup",
        "small",
    ]
    .into_iter()
    .collect()
}

fn extra_attrs() -> HashSet<&'static str> {
    [
        "style",
        "class",
        "id",
        "title",
        "alt",
        "width",
        "height",
        "align",
        "valign",
        "border",
        "cellpadding",
        "cellspacing",
        "colspan",
        "rowspan",
        "target",
        "rel",
        "srcset",
        "media",
        "sizes",
        "loading",
        "decoding",
        "open",
        "color",
        "size",
        "face",
        "bgcolor",
        "background",
        "role",
        "aria-label",
        "aria-hidden",
        "data-type",
        "data-value",
    ]
    .into_iter()
    .collect()
}

/// 消毒 HTML 片段：保留浏览器可解析结构与 style（含 flex），去掉 script 等。
pub fn sanitize_html_fragment(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    // 基于 ammonia 默认大标签集扩展，避免 .tags() 整表替换导致 div/style 能力回退
    Builder::default()
        .add_tags(extra_tags())
        .add_generic_attributes(extra_attrs())
        .link_rel(None)
        .url_relative(ammonia::UrlRelative::PassThrough)
        .clean(trimmed)
        .to_string()
}

/// 粗判是否为 HTML table 块。
pub fn is_html_table(raw: &str) -> bool {
    let lower = raw.to_ascii_lowercase();
    lower.contains("<table")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_table_and_rowspan() {
        let html = r#"<table border="1"><tr><td rowspan="2">A</td><td>B</td></tr><tr><td>C</td></tr></table>"#;
        let out = sanitize_html_fragment(html);
        assert!(out.to_ascii_lowercase().contains("<table"), "{out}");
        assert!(out.contains("rowspan"), "{out}");
        assert!(out.contains('A'), "{out}");
    }

    #[test]
    fn strips_script() {
        let out = sanitize_html_fragment("<p>ok</p><script>alert(1)</script>");
        assert!(out.contains("ok"));
        assert!(!out.to_ascii_lowercase().contains("script"));
    }

    #[test]
    fn keeps_target_and_relative_img() {
        let out = sanitize_html_fragment(
            r#"<a href="https://example.com" target="_blank" rel="noopener">x</a><img src="docs/a.jpg" alt="a">"#,
        );
        assert!(out.contains("target="), "{out}");
        assert!(out.contains("docs/a.jpg"), "{out}");
    }

    #[test]
    fn keeps_flex_div_style() {
        let out = sanitize_html_fragment(
            r#"<div style="display: flex; justify-content: space-between;"><img src="docs/a.jpg" width="240"></div>"#,
        );
        assert!(out.to_ascii_lowercase().contains("<div"), "{out}");
        assert!(
            out.contains("display") && out.contains("flex"),
            "flex style stripped: {out}"
        );
        assert!(
            out.contains("justify-content") || out.contains("space-between"),
            "justify-content stripped: {out}"
        );
        assert!(out.contains("docs/a.jpg"), "{out}");
    }

    #[test]
    fn keeps_picture_img() {
        let out = sanitize_html_fragment(
            r#"<picture><source media="(prefers-color-scheme: dark)" srcset="https://example.com/d.svg"><img src="https://example.com/l.svg" alt="x"></picture>"#,
        );
        assert!(
            out.contains("example.com") || out.contains("<img"),
            "{out}"
        );
    }
}
