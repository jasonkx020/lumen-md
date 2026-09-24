//! Windows 中文 IME：将 CompositionEnd 转为 Text，忽略预编辑。

use eframe::egui;

pub fn sanitize_cjk_ime_events(ctx: &egui::Context) {
    ctx.input_mut(|i| {
        let events = std::mem::take(&mut i.events);
        i.events = events
            .into_iter()
            .filter_map(|e| match e {
                egui::Event::CompositionStart => None,
                egui::Event::CompositionUpdate(_) => None,
                egui::Event::CompositionEnd(text) => {
                    if text.is_empty() || text == "\n" || text == "\r" {
                        None
                    } else {
                        Some(egui::Event::Text(text))
                    }
                }
                other => Some(other),
            })
            .collect();
    });
}
