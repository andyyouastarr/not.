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
            let width = v["attrs"]["widthPercent"]
                .as_f64()
                .unwrap_or(100.0)
                .clamp(15.0, 100.0);
            let layout = match v["attrs"]["layout"].as_str() {
                Some("left") => "left",
                Some("right") => "right",
                _ => "block",
            };
            format!("<figure class=\"journal-image {layout}\" style=\"width:{width}%\"><img src=\"assets/{name}\" alt=\"{}\"><figcaption>{}</figcaption></figure>",escape(&a.name),escape(&a.name))
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
pub fn export(vault: &Vault, id: &str, parent: &Path) -> Result<String> {
    let entry = vault.get(id)?;
    vault::validate_document(&entry.document)?;
    let dest = parent.join(format!("not-{}-{}", entry.date, uuid::Uuid::new_v4()));
    let temp = tempfile::tempdir_in(parent).map_err(|_| "Не удалось создать папку экспорта")?;
    fs::create_dir(temp.path().join("assets")).map_err(|_| "Не удалось создать папку вложений")?;
    let body = render(&entry.document, vault, &temp.path().join("assets"))?;
    let html=format!("<!doctype html><html lang=\"ru\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src 'self'; style-src 'unsafe-inline'\"><title>{}</title><style>body{{max-width:760px;margin:60px auto;padding:0 24px;font:18px/1.7 system-ui;color:#222}}time{{color:#777}}img{{max-width:100%;height:auto}}.journal-image{{clear:both;margin:22px 0;max-width:100%}}.journal-image img{{width:100%;display:block}}.journal-image.left{{float:left;margin:0 22px 16px 0;max-width:calc(100% - 22px)}}.journal-image.right{{float:right;margin:0 0 16px 22px;max-width:calc(100% - 22px)}}figcaption{{font-size:12px;overflow-wrap:anywhere}}table,hr,pre{{clear:both}}body{{display:flow-root}}table{{border-collapse:collapse}}td,th{{border:1px solid #bbb;padding:8px}}blockquote{{border-left:3px solid #999;padding-left:20px}}pre{{white-space:pre-wrap}}a{{color:#6653aa}}</style><time>{}</time><h1>{}</h1>{body}</html>",escape(&entry.title),escape(&entry.date),escape(&entry.title));
    vault::atomic(&temp.path().join("index.html"), html.as_bytes())?;
    crate::vault::rename_directory(temp.path(), &dest)?;
    Ok(dest.to_string_lossy().into_owned())
}
