use crate::config::Config;
use rmcp::model::{CallToolResult, Content, ErrorData};
use std::io::Write;

const DEFAULT_LARGE_TEXT_THRESHOLD: usize = 200_000;
const MIN_LARGE_TEXT_THRESHOLD: usize = 1_024;
const MAX_LARGE_TEXT_THRESHOLD: usize = 1_000_000;
const MAX_NON_TEXT_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const MAX_TOOL_RESPONSE_CONTENT_ITEMS: usize = 256;
const TEXT_CONTENT_BOUNDARY: &str = "\n\n";

fn large_text_threshold() -> usize {
    Config::global()
        .get_param::<usize>("GOOSE_MAX_TOOL_RESPONSE_SIZE")
        .unwrap_or(DEFAULT_LARGE_TEXT_THRESHOLD)
        .clamp(MIN_LARGE_TEXT_THRESHOLD, MAX_LARGE_TEXT_THRESHOLD)
}

/// Process tool response and handle large text content
pub fn process_tool_response(
    response: Result<CallToolResult, ErrorData>,
) -> Result<CallToolResult, ErrorData> {
    process_tool_response_with_limits(
        response,
        large_text_threshold(),
        MAX_NON_TEXT_RESPONSE_BYTES,
        write_large_text_parts_to_file,
    )
}

fn utf8_prefix(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn append_with_remaining(output: &mut String, value: &str, remaining: &mut usize) {
    let addition = value.chars().take(*remaining).collect::<String>();
    *remaining = (*remaining).saturating_sub(addition.chars().count());
    output.push_str(&addition);
}

fn bounded_spill_failure(text_parts: &[&str], threshold: usize) -> String {
    let warning = "Output could not be stored; bounded prefix:\n";
    let mut message = utf8_prefix(warning, threshold);
    let mut remaining = threshold.saturating_sub(message.chars().count());
    for (index, text) in text_parts.iter().enumerate() {
        if index > 0 {
            append_with_remaining(&mut message, TEXT_CONTENT_BOUNDARY, &mut remaining);
        }
        append_with_remaining(&mut message, text, &mut remaining);
        if remaining == 0 {
            break;
        }
    }
    message
}

#[derive(Default)]
struct SerializedSizeCounter {
    bytes: usize,
}

impl Write for SerializedSizeCounter {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.bytes = self.bytes.saturating_add(buffer.len());
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn serialized_size(value: &impl serde::Serialize) -> Option<usize> {
    let mut counter = SerializedSizeCounter::default();
    serde_json::to_writer(&mut counter, value).ok()?;
    Some(counter.bytes)
}

fn process_tool_response_with_limits<Writer>(
    response: Result<CallToolResult, ErrorData>,
    text_threshold: usize,
    non_text_limit: usize,
    mut writer: Writer,
) -> Result<CallToolResult, ErrorData>
where
    Writer: FnMut(&[&str]) -> Result<String, std::io::Error>,
{
    match response {
        Ok(mut result) => {
            let content_items_omitted = result.content.len() > MAX_TOOL_RESPONSE_CONTENT_ITEMS;
            result.content.truncate(if content_items_omitted {
                MAX_TOOL_RESPONSE_CONTENT_ITEMS - 1
            } else {
                MAX_TOOL_RESPONSE_CONTENT_ITEMS
            });
            let mut auxiliary_bytes = 0usize;
            let mut auxiliary_omitted = false;
            result.content.retain(|content| {
                let Some(size) = serialized_size(content) else {
                    auxiliary_omitted = true;
                    return false;
                };
                // Text bytes have their own aggregate limit below. Everything else in a text
                // block (JSON framing, escaping expansion, annotations and `_meta`) shares the
                // auxiliary serialized budget with non-text/structured output.
                let auxiliary_size = content
                    .as_text()
                    .map_or(size, |text| size.saturating_sub(text.text.len()));
                let next_size = auxiliary_bytes.saturating_add(auxiliary_size);
                if next_size > non_text_limit {
                    auxiliary_omitted = true;
                    false
                } else {
                    auxiliary_bytes = next_size;
                    true
                }
            });

            if let Some(structured_content) = result.structured_content.as_ref() {
                let size = serialized_size(structured_content).unwrap_or(usize::MAX);
                let next_size = auxiliary_bytes.saturating_add(size);
                if next_size > non_text_limit {
                    result.structured_content = None;
                    auxiliary_omitted = true;
                } else {
                    auxiliary_bytes = next_size;
                }
            }
            if let Some(meta) = result.meta.as_ref() {
                let size = serialized_size(meta).unwrap_or(usize::MAX);
                if auxiliary_bytes.saturating_add(size) > non_text_limit {
                    result.meta = None;
                    auxiliary_omitted = true;
                }
            }
            if auxiliary_omitted || content_items_omitted {
                let notice = match (auxiliary_omitted, content_items_omitted) {
                    (true, true) => {
                        "Some tool output, including non-text output or metadata, was omitted because it exceeded host output limits."
                    }
                    (true, false) => {
                        "Some non-text output or metadata was omitted because it exceeded the host output limit."
                    }
                    (false, true) => {
                        "Some tool output was omitted because it exceeded the host content item limit."
                    }
                    (false, false) => unreachable!("checked omission state"),
                };
                result.content.push(Content::text(notice));
            }

            let text_parts = result
                .content
                .iter()
                .filter_map(|content| content.as_text().map(|text| text.text.as_str()))
                .collect::<Vec<_>>();
            let text_chars = text_parts
                .iter()
                .map(|text| text.chars().count())
                .fold(0usize, usize::saturating_add)
                .saturating_add(
                    text_parts
                        .len()
                        .saturating_sub(1)
                        .saturating_mul(TEXT_CONTENT_BOUNDARY.chars().count()),
                );
            if text_chars <= text_threshold {
                return Ok(result);
            }

            let replacement = match writer(&text_parts) {
                Ok(file_path) => utf8_prefix(
                    &format!(
                        "The response returned from the tool call was larger ({text_chars} characters) and is stored in the file which you can use other tools to examine or search in: {file_path}"
                    ),
                    text_threshold,
                ),
                Err(_) => bounded_spill_failure(&text_parts, text_threshold),
            };
            let mut inserted_replacement = false;
            let mut processed_contents = Vec::with_capacity(result.content.len());
            for content in result.content {
                if content.as_text().is_some() {
                    if !inserted_replacement && !replacement.is_empty() {
                        processed_contents.push(Content::text(replacement.clone()));
                        inserted_replacement = true;
                    }
                } else {
                    processed_contents.push(content);
                }
            }
            result.content = processed_contents;
            Ok(result)
        }
        Err(e) => Err(e),
    }
}

/// Write large text content to a temporary file
fn write_large_text_parts_to_file(parts: &[&str]) -> Result<String, std::io::Error> {
    let mut file = tempfile::Builder::new()
        .prefix("goose_mcp_response_")
        .suffix(".txt")
        .tempfile()?;
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            file.write_all(TEXT_CONTENT_BOUNDARY.as_bytes())?;
        }
        file.write_all(part.as_bytes())?;
    }
    let (_, file_path) = file.keep()?;

    Ok(file_path.to_string_lossy().to_string())
}

#[cfg(test)]
fn write_large_text_to_file(content: &str) -> Result<String, std::io::Error> {
    write_large_text_parts_to_file(&[content])
}

#[cfg(test)]
mod tests {
    use super::*;
    use rmcp::model::{Content, ErrorCode, ErrorData, Meta, RawContent};
    use std::borrow::Cow;
    use std::fs;
    use std::path::Path;

    #[test]
    fn test_small_text_response_passes_through() {
        // Create a small text response
        let small_text = "This is a small text response";
        let content = Content::text(small_text.to_string());

        let response = Ok(CallToolResult::success(vec![content]));

        // Process the response
        let processed = process_tool_response(response).unwrap();

        // Verify the response is unchanged
        assert_eq!(processed.content.len(), 1);
        if let Some(text_content) = processed.content[0].as_text() {
            assert_eq!(text_content.text, small_text);
        } else {
            panic!("Expected text content");
        }
    }

    #[test]
    fn test_large_text_response_redirected_to_file() {
        // Create a text larger than the threshold
        let large_text = "a".repeat(DEFAULT_LARGE_TEXT_THRESHOLD + 1000);
        let content = Content::text(large_text.clone());

        let response = Ok(CallToolResult::success(vec![content]));

        // Process the response
        let processed = process_tool_response(response).unwrap();

        // Verify the response contains a message about the file
        assert_eq!(processed.content.len(), 1);
        if let Some(text_content) = processed.content[0].as_text() {
            assert!(text_content
                .text
                .contains("The response returned from the tool call was larger"));
            assert!(text_content.text.contains("characters"));

            // Extract the file path from the message
            let file_path = text_content
                .text
                .rsplit_once(": ")
                .expect("spill message should contain a file path")
                .1;
            let path = Path::new(file_path.trim());
            assert!(path.exists());
            assert_eq!(fs::read_to_string(path).unwrap(), large_text);
            fs::remove_file(path).unwrap();
        } else {
            panic!("Expected text content");
        }
    }

    #[test]
    fn test_image_content_passes_through() {
        // Create an image content
        let image_content = Content::image("base64data".to_string(), "image/png".to_string());

        let response = Ok(CallToolResult::success(vec![image_content]));

        // Process the response
        let processed = process_tool_response(response).unwrap();

        // Verify the response is unchanged
        assert_eq!(processed.content.len(), 1);
        if let Some(img) = processed.content[0].as_image() {
            assert_eq!(img.data, "base64data");
            assert_eq!(img.mime_type, "image/png");
        } else {
            panic!("Expected image content");
        }
    }

    #[test]
    fn test_mixed_content_handled_correctly() {
        // Create a response with mixed content types
        let small_text = Content::text("Small text");
        let large_text_value = "a".repeat(DEFAULT_LARGE_TEXT_THRESHOLD + 1000);
        let large_text = Content::text(large_text_value.clone());
        let image = Content::image("image_data".to_string(), "image/jpeg".to_string());

        let response = Ok(CallToolResult::success(vec![small_text, large_text, image]));

        // Process the response
        let processed = process_tool_response(response).unwrap();

        // All text is stored as one bounded artifact; non-text content remains.
        assert_eq!(processed.content.len(), 2);

        if let Some(text_content) = processed.content[0].as_text() {
            assert!(text_content
                .text
                .contains("The response returned from the tool call was larger"));

            let file_path = text_content
                .text
                .rsplit_once(": ")
                .expect("spill message should contain a file path")
                .1;
            let artifact_path = Path::new(file_path.trim());
            assert_eq!(
                fs::read_to_string(artifact_path).unwrap(),
                format!("Small text{TEXT_CONTENT_BOUNDARY}{large_text_value}")
            );
            fs::remove_file(artifact_path).unwrap();
        } else {
            panic!("Expected text content");
        }

        if let Some(img) = processed.content[1].as_image() {
            assert_eq!(img.data, "image_data");
            assert_eq!(img.mime_type, "image/jpeg");
        } else {
            panic!("Expected image content");
        }
    }

    #[test]
    fn test_error_response_passes_through() {
        // Create an error response
        let error = ErrorData {
            code: ErrorCode::INTERNAL_ERROR,
            message: Cow::from("Test error"),
            data: None,
        };
        let response: Result<CallToolResult, ErrorData> = Err(error);

        // Process the response
        let processed = process_tool_response(response);

        // Verify the error is passed through unchanged
        assert!(processed.is_err());
        match processed {
            Err(err) => {
                assert_eq!(err.code, ErrorCode::INTERNAL_ERROR);
                assert_eq!(err.message, "Test error");
            }
            _ => panic!("Expected execution error"),
        }
    }

    #[test]
    fn aggregate_text_limit_cannot_be_bypassed_by_multiple_small_contents() {
        use std::cell::RefCell;

        let captured = RefCell::new(String::new());
        let response = Ok(CallToolResult::success(vec![
            Content::text("a".repeat(120)),
            Content::text("b".repeat(120)),
        ]));

        let processed = process_tool_response_with_limits(response, 200, usize::MAX, |parts| {
            captured.replace(parts.join(TEXT_CONTENT_BOUNDARY));
            Ok("bounded-artifact.txt".to_string())
        })
        .unwrap();
        let visible_chars: usize = processed
            .content
            .iter()
            .filter_map(|content| content.as_text())
            .map(|text| text.text.chars().count())
            .sum();

        assert!(visible_chars <= 200);
        assert_eq!(processed.content.len(), 1);
        assert!(processed.content[0]
            .as_text()
            .unwrap()
            .text
            .contains("bounded-artifact.txt"));
        assert_eq!(captured.borrow().chars().count(), 242);
    }

    #[test]
    fn spill_failure_returns_only_a_utf8_safe_bounded_prefix() {
        let secret = "敏感输出".repeat(100);
        let response = Ok(CallToolResult::success(vec![Content::text(secret.clone())]));

        let processed = process_tool_response_with_limits(response, 64, usize::MAX, |_| {
            Err(std::io::Error::other("simulated write failure"))
        })
        .unwrap();
        let visible = &processed.content[0].as_text().unwrap().text;

        assert!(visible.chars().count() <= 64);
        assert!(visible.contains("could not be stored"));
        assert_ne!(visible, &secret);
        assert!(!visible.contains(&secret));
    }

    #[test]
    fn non_text_and_structured_output_share_a_hard_serialized_limit() {
        let mut result =
            CallToolResult::success(vec![Content::image("a".repeat(100), "image/png")]);
        result.structured_content = Some(serde_json::json!({ "blob": "b".repeat(100) }));

        let processed = process_tool_response_with_limits(Ok(result), 256, 64, |_| {
            unreachable!("bounded omission notice does not require a text artifact")
        })
        .unwrap();

        assert!(processed.structured_content.is_none());
        assert!(processed
            .content
            .iter()
            .all(|content| content.as_image().is_none()));
        let notice = processed
            .content
            .iter()
            .find_map(|content| content.as_text())
            .expect("host must explain bounded non-text omission");
        assert!(notice.text.contains("non-text output or metadata"));
    }

    #[test]
    fn text_metadata_cannot_bypass_the_serialized_output_limit() {
        let mut content = Content::text("small");
        let RawContent::Text(text) = &mut content.raw else {
            unreachable!("fixture is text content");
        };
        text.meta = Some(
            serde_json::from_value::<Meta>(serde_json::json!({ "blob": "x".repeat(100) })).unwrap(),
        );

        let processed = process_tool_response_with_limits(
            Ok(CallToolResult::success(vec![content])),
            256,
            64,
            |_| unreachable!("bounded omission notice does not require a text artifact"),
        )
        .unwrap();

        assert_eq!(processed.content.len(), 1);
        let notice = processed.content[0]
            .as_text()
            .expect("oversized text metadata must be replaced with an omission notice");
        assert!(notice.text.contains("metadata"));
    }

    #[test]
    fn content_item_count_is_bounded_even_when_items_are_empty() {
        let response = Ok(CallToolResult::success(
            (0..300).map(|_| Content::text("")).collect(),
        ));

        let processed = process_tool_response_with_limits(response, 10_000, usize::MAX, |_| {
            unreachable!("empty contents do not need a text artifact")
        })
        .unwrap();

        assert!(processed.content.len() <= 256);
        assert!(processed
            .content
            .iter()
            .filter_map(|content| content.as_text())
            .any(|text| text.text.contains("tool output was omitted")));
    }

    #[test]
    fn test_large_response_files_have_unique_paths() {
        let first_path = write_large_text_to_file("first response").unwrap();
        let second_path = write_large_text_to_file("second response").unwrap();
        let paths_are_distinct = first_path != second_path;
        let first_content = fs::read_to_string(&first_path).unwrap();
        let second_content = fs::read_to_string(&second_path).unwrap();

        fs::remove_file(&first_path).unwrap();
        if paths_are_distinct {
            fs::remove_file(&second_path).unwrap();
        }

        assert!(paths_are_distinct);
        assert_eq!(first_content, "first response");
        assert_eq!(second_content, "second response");
    }

    #[cfg(unix)]
    #[test]
    fn test_large_response_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let file_path = write_large_text_to_file("sensitive response").unwrap();
        let metadata = fs::metadata(&file_path).unwrap();
        let mode = metadata.permissions().mode();
        let content = fs::read_to_string(&file_path).unwrap();
        fs::remove_file(&file_path).unwrap();

        assert_eq!(mode & 0o077, 0);
        assert_eq!(content, "sensitive response");
    }
}
