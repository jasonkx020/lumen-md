fn main() {
    use ammonia::Builder;
    use std::collections::HashSet;
    let tags: HashSet<&str> = [""div"", ""img"", ""a""].into_iter().collect();
    let attrs: HashSet<&str> = [""style"", ""src"", ""href"", ""width"", ""alt"", ""target""].into_iter().collect();
    let out = Builder::default()
        .tags(tags)
        .generic_attributes(attrs)
        .link_rel(None)
        .url_relative(ammonia::UrlRelative::PassThrough)
        .clean(r#"<div style=""display: flex; justify-content: space-between;""><img src=""docs/a.jpg"" width=""240""></div>"#)
        .to_string();
    println!("OUT={out}");
}
