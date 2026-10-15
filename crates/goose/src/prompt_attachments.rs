use crate::conversation::message::{Message, MessageContent};
use anyhow::{ensure, Result};
use base64::{engine::general_purpose::STANDARD, Engine};

pub(crate) fn validate_image_attachment(data: &str, mime_type: &str) -> Result<()> {
    ensure!(
        matches!(
            mime_type,
            "image/png" | "image/jpeg" | "image/jpg" | "image/gif" | "image/webp"
        ),
        "unsupported image MIME type"
    );
    let decoded = STANDARD.decode(data)?;
    ensure!(!decoded.is_empty(), "image attachment must not be empty");
    Ok(())
}

pub(crate) fn validated_image_count(message: &Message) -> Result<usize> {
    let mut count = 0;
    for content in &message.content {
        if let MessageContent::Image(image) = content {
            validate_image_attachment(&image.data, &image.mime_type)?;
            count += 1;
        }
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_only_transport_validation_is_strict_without_reencoding() {
        for mime in [
            "image/png",
            "image/jpeg",
            "image/jpg",
            "image/gif",
            "image/webp",
        ] {
            assert!(validate_image_attachment("AA==", mime).is_ok());
        }
        for data in ["", " ", "AA", "AB==", "invalid!base64", "AA==\n"] {
            assert!(validate_image_attachment(data, "image/png").is_err());
        }
        for mime in ["", "text/plain", "image/svg+xml", "image/bmp"] {
            assert!(validate_image_attachment("AA==", mime).is_err());
        }
        let mixed = Message::user()
            .with_image("AA==", "image/png")
            .with_image("invalid!base64", "image/png");
        assert!(validated_image_count(&mixed).is_err());
        assert_eq!(validated_image_count(&Message::user()).unwrap(), 0);
    }
}
