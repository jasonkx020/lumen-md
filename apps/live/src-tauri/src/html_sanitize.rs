//! HTML 白名单消毒（对齐前端 sanitizeHtml.ts），供 PDF/DOCX 导出使用。

use std::collections::HashSet;

use ammonia::Builder;

/// 与 apps/live/src/markdown/sanitizeHtml.ts 对齐的标签白名单。
fn allowed_tags() -> HashSet<&'static str> {
    [
        "br", "p", "div", "span", "section", "details", "summary", "kbd", "mark", "u",
        "sub", "sup", "font", "center", "table", "thead", "tbody", "tr", "th", "td", "img",
        "a", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "hr",
        "pre", "code", "em", "strong", "b", "i", "small",
    ]
    .into_iter()
    .collect()
}

fn allowed_attrs() -> HashSet<&'static str> {
    [
        "href", "src", "alt", "title", "class", "id", "style", "colspan", "rowspan",
        "open", "color", "size", "align", "width", "height", "border",
    ]
    .into_iter()
    .collect()
}

/// 消毒 HTML 片段；去掉 script/事件等，保留 table/rowspan/colspan。
pub fn sanitize_html_fragment(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    Builder::default()
        .tags(allowed_tags())
        .generic_attributes(allowed_attrs())
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
}
