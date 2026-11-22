use crate::{
    crypto::Result,
    vault::{self, Vault},
};
use serde_json::Value;
use std::{fs, path::Path};
pub fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
fn render(v: &Value, vault: &Vault, assets: &Path) -> Result<String> {
    let kind = v["type"].as_str().unwrap_or("");
    if kind == "text" {
        let mut s = escape(v["text"].as_str().unwrap_or(""));
        if let Some(marks) = v["marks"].as_array() {
            for m in marks {
                let tag = match m["type"].as_str().unwrap_or("") {
                    "bold" => "strong",
                    "italic" => "em",
                    "strike" => "s",
                    "underline" => "u",
                    "code" => "code",
                    "highlight" => {
                        let color = m["attrs"]["color"].as_str().unwrap_or("");
                        let background =
                            vault::highlight_color(color).ok_or("Неверный цвет маркера")?;
                        s = format!("<mark data-highlight=\"{color}\" style=\"background-color:{background};color:inherit\">{s}</mark>");
                        continue;
                    }
                    "link" => {
                        let href = m["attrs"]["href"].as_str().unwrap_or("");
                        if vault::safe_link(href) {
                            s = format!("<a href=\"{}\" rel=\"noreferrer\">{s}</a>", escape(href));
                        }
                        continue;
                    }
                    _ => continue,
                };
                s = format!("<{tag}>{s}</{tag}>");
            }
        }
        return Ok(s);
    }
    if kind == "image" || kind == "attachment" {
        let id = v["attrs"]["attachmentId"]
            .as_str()
            .ok_or("Неверное вложение")?;
        let a = vault.attachment(id)?;
        let ext = match a.mime.as_str() {
            "image/png" => "png",
            "image/jpeg" => "jpg",
            "image/webp" => "webp",
            "image/gif" => "gif",
            _ => "bin",
        };
        let name = format!("{id}.{ext}");
        vault.write_attachment(id, &assets.join(&name))?;
        return Ok(if kind == "image" {
            // The document was validated before rendering. Keep fractional and
            // sub-15% widths; the visual minimum belongs to the layout, not data.
            let width = v["attrs"]["widthPercent"].as_f64().unwrap_or(100.0);
            let layout = match v["attrs"]["layout"].as_str() {
                Some("left") => "left",
                Some("right") => "right",
                _ => "block",
            };
            let layout_id = uuid::Uuid::new_v4();
            let flow_style = image_flow_style(width, layout, &layout_id.to_string());
            format!("{flow_style}<figure class=\"journal-image {layout}\" style=\"width:{width}%\" data-image-layout-id=\"{layout_id}\"><img src=\"assets/{name}\" alt=\"{}\"><figcaption>{}</figcaption></figure>",escape(&a.name),escape(&a.name))
        } else {
            format!(
                "<p><a download=\"{}\" href=\"assets/{name}\">{}</a></p>",
                escape(&a.name),
                escape(&a.name)
            )
        });
    }
    let mut inner = String::new();
    if let Some(c) = v["content"].as_array() {
        for n in c {
            inner.push_str(&render(n, vault, assets)?);
        }
    }
    let tag = match kind {
        "doc" => return Ok(inner),
        "paragraph" => "p",
        "heading" => match v["attrs"]["level"].as_u64() {
            Some(1) => "h1",
            Some(2) => "h2",
            _ => "h3",
        },
        "bulletList" | "taskList" => "ul",
        "orderedList" => "ol",
        "listItem" | "taskItem" => "li",
        "blockquote" => "blockquote",
        "codeBlock" => "pre",
        "table" => "table",
        "tableRow" => "tr",
        "tableCell" => "td",
        "tableHeader" => "th",
        "hardBreak" => return Ok("<br>".into()),
        "horizontalRule" => return Ok("<hr>".into()),
        "timestampDivider" => {
            let date = v["attrs"]["date"]
                .as_str()
                .ok_or("Неверная дата разделителя")?;
            let label = date.split('-').rev().collect::<Vec<_>>().join(".");
            return Ok(format!("<div data-timestamp-date=\"{}\" style=\"display:flex;align-items:center;gap:12px;clear:both;margin:20px 0;font:11px system-ui;color:#50515b\"><time datetime=\"{}\">{}</time><span style=\"flex:1;border-top:1px solid #c9c9d0\"></span></div>",escape(date),escape(date),escape(&label)));
        }
        _ => return Err("Неизвестный блок".into()),
    };
    let prefix = if kind == "taskItem" {
        if v["attrs"]["checked"].as_bool() == Some(true) {
            "☑ "
        } else {
            "☐ "
        }
    } else {
        ""
    };
    Ok(format!("<{tag}>{prefix}{inner}</{tag}>"))
}
// Match the editor's 32px image minimum and 180px minimum text column with a
// 22px gap. Container queries keep exported HTML responsive without JavaScript.
fn image_flow_style(width: f64, layout: &str, id: &str) -> String {
    if layout == "block" {
        return String::new();
    }
    let condition = if width >= 100.0 {
        "width >= 0px".to_owned()
    } else {
        let threshold = (202.0 / (1.0 - width / 100.0)).max(234.0);
        format!("width < {threshold}px")
    };
    let margin = if layout == "right" {
        "margin-left:auto;margin-right:0"
    } else {
        "margin-left:0;margin-right:auto"
    };
    format!("<style>@container ({condition}){{.journal-image[data-image-layout-id=\"{id}\"]{{float:none;{margin}}}}}</style>")
}
pub fn export(vault: &Vault, id: &str, parent: &Path) -> Result<String> {
    let entry = vault.get(id)?;
    vault::validate_document(&entry.document)?;
    let dest = parent.join(format!("not-{}-{}", entry.date, uuid::Uuid::new_v4()));
    let temp = tempfile::tempdir_in(parent).map_err(|_| "Не удалось создать папку экспорта")?;
    fs::create_dir(temp.path().join("assets")).map_err(|_| "Не удалось создать папку вложений")?;
    let body = render(&entry.document, vault, &temp.path().join("assets"))?;
    let html=format!("<!doctype html><html lang=\"ru\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src 'self'; style-src 'unsafe-inline'\"><title>{}</title><style>body{{max-width:760px;margin:60px auto;padding:0 24px;font:18px/1.7 system-ui;color:#222;container-type:inline-size}}time{{color:#777}}img{{max-width:100%;height:auto}}.journal-image{{clear:both;margin:22px 0;min-width:min(32px,100%);max-width:100%}}.journal-image img{{width:100%;display:block}}.journal-image.left{{float:left;margin:0 22px 16px 0}}.journal-image.right{{float:right;margin:0 0 16px 22px}}figcaption{{font-size:12px;overflow-wrap:anywhere}}table,hr,pre{{clear:both}}body{{display:flow-root}}table{{border-collapse:collapse}}td,th{{border:1px solid #bbb;padding:8px}}blockquote{{border-left:3px solid #999;padding-left:20px}}pre{{white-space:pre-wrap}}a{{color:#6653aa}}</style><time>{}</time><h1>{}</h1>{body}</html>",escape(&entry.title),escape(&entry.date),escape(&entry.title));
    vault::atomic(&temp.path().join("index.html"), html.as_bytes())?;
    crate::vault::rename_directory(temp.path(), &dest)?;
    Ok(dest.to_string_lossy().into_owned())
}
