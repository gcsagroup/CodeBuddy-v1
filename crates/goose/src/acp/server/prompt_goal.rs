use crate::conversation::message::Message;
use crate::prompt_attachments::validated_image_count;
use anyhow::Result;

pub(super) fn prompt_goal(message: &Message, locale: Option<&str>) -> Result<String> {
    validated_image_count(message)?;
    let visible = message.agent_visible_content();
    let text = visible.as_concat_text();
    if !text.trim().is_empty() {
        return Ok(text);
    }
    let images = validated_image_count(&visible)?;
    if images == 0 {
        return Ok(text);
    }

    // This is run metadata only; preserve the original attachment-only user message.
    Ok(match locale.unwrap_or("en") {
        "zh-TW" | "zh-HK" => format!("圖片附件（{images} 張，未附文字）"),
        locale if locale.starts_with("zh") => format!("图片附件（{images} 张，未附文字）"),
        _ => format!("Image attachments: {images} (no text)"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=";

    #[test]
    fn image_only_run_summary_never_changes_the_user_message() {
        let message = Message::user()
            .with_id("image-source")
            .with_image(PNG, "image/png");
        let original = serde_json::to_value(&message).unwrap();
        assert_eq!(
            prompt_goal(&message, Some("zh-CN")).unwrap(),
            "图片附件（1 张，未附文字）"
        );
        assert_eq!(
            prompt_goal(&message, Some("zh-TW")).unwrap(),
            "圖片附件（1 張，未附文字）"
        );
        assert_eq!(
            prompt_goal(&message, None).unwrap(),
            "Image attachments: 1 (no text)"
        );
        assert_eq!(serde_json::to_value(&message).unwrap(), original);
        assert!(message.as_concat_text().is_empty());
    }

    #[test]
    fn text_is_preserved_and_empty_payloads_do_not_create_a_goal() {
        for message in [Message::user(), Message::user().with_text(" \n ")] {
            assert!(prompt_goal(&message, None).unwrap().trim().is_empty());
        }
        for (data, mime) in [
            ("", "image/png"),
            (PNG, ""),
            ("invalid!base64", "image/png"),
            (PNG, "text/plain"),
        ] {
            for message in [
                Message::user().with_image(data, mime),
                Message::user()
                    .with_image(PNG, "image/png")
                    .with_image(data, mime),
                Message::user().with_text("明确目标").with_image(data, mime),
            ] {
                assert!(prompt_goal(&message, None).is_err());
            }
        }
        for message in [
            Message::user().with_text("  原始目标\n"),
            Message::user()
                .with_text("  原始目标\n")
                .with_image(PNG, "image/png"),
        ] {
            assert_eq!(
                prompt_goal(&message, Some("zh-CN")).unwrap(),
                "  原始目标\n"
            );
        }
        let images = Message::user()
            .with_text(" ")
            .with_image(PNG, "image/png")
            .with_image(PNG, "image/png");
        assert_eq!(
            prompt_goal(&images, Some("zh-CN")).unwrap(),
            "图片附件（2 张，未附文字）"
        );
    }
}
