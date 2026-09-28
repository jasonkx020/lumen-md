//! HTML `<table>`（含 rowspan/colspan）→ docx-rs Table。

use docx_rs::*;
use scraper::{Html, Selector};

use crate::html_sanitize::sanitize_html_fragment;

#[derive(Clone)]
struct OriginCell {
    text: String,
    rowspan: usize,
    colspan: usize,
    is_header: bool,
}

#[derive(Clone)]
enum GridCell {
    /// 单元格起点
    Origin(OriginCell),
    /// 被上方 rowspan 占用
    RowContinue,
    /// 被左方 colspan 占用（DOCX 不单独输出）
    ColSkip,
}

fn parse_span(el: &scraper::ElementRef, name: &str) -> usize {
    el.value()
        .attr(name)
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(1)
}

fn cell_text(el: scraper::ElementRef) -> String {
    // inner text；br 当作换行
    let mut out = String::new();
    for node in el.children() {
        match node.value() {
            scraper::node::Node::Text(t) => out.push_str(t),
            scraper::node::Node::Element(e) if e.name() == "br" => out.push('\n'),
            _ => {
                if let Some(child_el) = scraper::ElementRef::wrap(node) {
                    if !out.is_empty() && !out.ends_with('\n') {
                        // 块级间隔
                        let name = child_el.value().name();
                        if matches!(name, "p" | "div") {
                            out.push('\n');
                        }
                    }
                    out.push_str(&cell_text(child_el));
                }
            }
        }
    }
    out.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace(" \n ", "\n")
        .trim()
        .to_string()
}

/// 将消毒后的 HTML table 解析为网格（含 Continue 占位）。
fn parse_table_grid(html: &str) -> Option<Vec<Vec<GridCell>>> {
    let safe = sanitize_html_fragment(html);
    if !safe.to_ascii_lowercase().contains("<table") {
        return None;
    }
    let frag = Html::parse_fragment(&safe);
    let table_sel = Selector::parse("table").ok()?;
    let table = frag.select(&table_sel).next()?;
    let tr_sel = Selector::parse("tr").ok()?;
    let rows_el: Vec<_> = table.select(&tr_sel).collect();
    if rows_el.is_empty() {
        return None;
    }

    // 先收集每行的 origin 单元格
    let mut raw_rows: Vec<Vec<OriginCell>> = Vec::new();
    for tr in &rows_el {
        let mut cells = Vec::new();
        for child in tr.children() {
            let Some(el) = scraper::ElementRef::wrap(child) else {
                continue;
            };
            let name = el.value().name();
            if name != "td" && name != "th" {
                continue;
            }
            cells.push(OriginCell {
                text: cell_text(el),
                rowspan: parse_span(&el, "rowspan"),
                colspan: parse_span(&el, "colspan"),
                is_header: name == "th",
            });
        }
        if !cells.is_empty() {
            raw_rows.push(cells);
        }
    }
    if raw_rows.is_empty() {
        return None;
    }

    let n_rows = raw_rows.len();
    // 估算列数
    let mut max_cols = 1usize;
    for (ri, row) in raw_rows.iter().enumerate() {
        let mut col = 0usize;
        // 简化：累加 colspan（忽略上方 rowspan 占用的粗估，后面放置时再算准）
        let _ = ri;
        for c in row {
            col += c.colspan;
        }
        max_cols = max_cols.max(col);
    }

    // 放置到网格
    let mut grid: Vec<Vec<Option<GridCell>>> = vec![vec![None; max_cols]; n_rows];
    for (r, row) in raw_rows.iter().enumerate() {
        let mut c = 0usize;
        for cell in row {
            while c < max_cols && grid[r][c].is_some() {
                c += 1;
            }
            if c >= max_cols {
                // 扩展列
                let extra = c + cell.colspan - max_cols;
                for grow in grid.iter_mut() {
                    for _ in 0..extra {
                        grow.push(None);
                    }
                }
                max_cols += extra;
            }
            let rs = cell.rowspan.min(n_rows - r);
            let cs = cell.colspan;
            // 确保列够
            while c + cs > max_cols {
                for grow in grid.iter_mut() {
                    grow.push(None);
                }
                max_cols += 1;
            }
            grid[r][c] = Some(GridCell::Origin(cell.clone()));
            for rr in r..r + rs {
                for cc in c..c + cs {
                    if rr == r && cc == c {
                        continue;
                    }
                    if rr >= n_rows {
                        break;
                    }
                    while cc >= grid[rr].len() {
                        grid[rr].push(None);
                        max_cols = max_cols.max(grid[rr].len());
                    }
                    if grid[rr][cc].is_none() {
                        grid[rr][cc] = Some(if cc == c {
                            GridCell::RowContinue
                        } else {
                            GridCell::ColSkip
                        });
                    }
                }
            }
            c += cs;
        }
    }

    Some(
        grid.into_iter()
            .map(|row| {
                row.into_iter()
                    .map(|c| c.unwrap_or(GridCell::ColSkip))
                    .collect()
            })
            .collect(),
    )
}

fn plain_paragraph(text: &str, bold: bool) -> Paragraph {
    let mut run = Run::new()
        .add_text(text)
        .fonts(
            RunFonts::new()
                .ascii("Segoe UI")
                .hi_ansi("Segoe UI")
                .east_asia("微软雅黑"),
        )
        .size(22);
    if bold {
        run = run.bold();
    }
    // 多行文本：按 \n 拆成多个 break
    if text.contains('\n') {
        let mut p = Paragraph::new();
        for (i, line) in text.split('\n').enumerate() {
            if i > 0 {
                p = p.add_run(Run::new().add_break(BreakType::TextWrapping));
            }
            let mut r = Run::new()
                .add_text(line)
                .fonts(
                    RunFonts::new()
                        .ascii("Segoe UI")
                        .hi_ansi("Segoe UI")
                        .east_asia("微软雅黑"),
                )
                .size(22);
            if bold {
                r = r.bold();
            }
            p = p.add_run(r);
        }
        return p;
    }
    Paragraph::new().add_run(run)
}

/// 若 `html` 是 table，返回构建好的 docx Table；否则 None。
pub fn try_html_to_docx_table(
    html: &str,
    table_width: usize,
    header_fill: &str,
    cell_borders: impl Fn(bool) -> TableCellBorders,
    table_borders: TableBorders,
) -> Option<Table> {
    let grid = parse_table_grid(html)?;
    if grid.is_empty() {
        return None;
    }
    let n_cols = grid.iter().map(|r| r.len()).max().unwrap_or(1).max(1);
    let col_w = (table_width / n_cols).max(200);
    let col_widths: Vec<usize> = vec![col_w; n_cols];

    let mut rows: Vec<TableRow> = Vec::new();
    for row in &grid {
        let mut cells: Vec<TableCell> = Vec::new();
        let mut col = 0usize;
        while col < n_cols {
            let slot = row.get(col).cloned().unwrap_or(GridCell::ColSkip);
            match slot {
                GridCell::ColSkip => {
                    col += 1;
                }
                GridCell::RowContinue => {
                    // 垂直合并延续：空单元格 + Continue
                    let mut cell = TableCell::new()
                        .add_paragraph(Paragraph::new())
                        .width(col_w, WidthType::Dxa)
                        .vertical_merge(VMergeType::Continue)
                        .set_borders(cell_borders(false));
                    cell.property = cell
                        .property
                        .margin_top(60, WidthType::Dxa)
                        .margin_bottom(60, WidthType::Dxa)
                        .margin_left(100, WidthType::Dxa)
                        .margin_right(100, WidthType::Dxa);
                    cells.push(cell);
                    col += 1;
                }
                GridCell::Origin(origin) => {
                    let mut cell = TableCell::new()
                        .add_paragraph(plain_paragraph(&origin.text, origin.is_header))
                        .width(col_w * origin.colspan, WidthType::Dxa)
                        .set_borders(cell_borders(origin.is_header))
                        .vertical_align(VAlignType::Center);
                    if origin.colspan > 1 {
                        cell = cell.grid_span(origin.colspan);
                    }
                    if origin.rowspan > 1 {
                        cell = cell.vertical_merge(VMergeType::Restart);
                    }
                    if origin.is_header {
                        cell = cell.shading(
                            Shading::new()
                                .shd_type(ShdType::Clear)
                                .fill(header_fill)
                                .color("auto"),
                        );
                    }
                    cell.property = cell
                        .property
                        .margin_top(60, WidthType::Dxa)
                        .margin_bottom(60, WidthType::Dxa)
                        .margin_left(100, WidthType::Dxa)
                        .margin_right(100, WidthType::Dxa);
                    cells.push(cell);
                    col += origin.colspan;
                }
            }
        }
        if !cells.is_empty() {
            rows.push(TableRow::new(cells));
        }
    }

    if rows.is_empty() {
        return None;
    }

    let mut table = Table::new(rows)
        .set_grid(col_widths)
        .width(table_width, WidthType::Dxa)
        .layout(TableLayoutType::Fixed)
        .set_borders(table_borders);
    table.property = table
        .property
        .cell_margin_top(60, WidthType::Dxa)
        .cell_margin_bottom(60, WidthType::Dxa)
        .cell_margin_left(100, WidthType::Dxa)
        .cell_margin_right(100, WidthType::Dxa);
    Some(table)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rowspan_grid() {
        let html = r#"<table><tr><td rowspan="2">A</td><td>B</td></tr><tr><td>C</td></tr></table>"#;
        let grid = parse_table_grid(html).expect("grid");
        assert_eq!(grid.len(), 2);
        assert!(matches!(grid[0][0], GridCell::Origin(_)));
        assert!(matches!(grid[1][0], GridCell::RowContinue));
    }
}
