//! Format-agnostic HTTP status → `ProviderError` mapping.
//!
//! Used by providers regardless of their wire format (OpenAI, Anthropic,
//! Google, etc.). Parses both `{"error":{"message":"..."}}` and
//! `{"message":"..."}` error shapes.

use std::time::{Duration, SystemTime};

use crate::errors::ProviderError;
use chrono::{DateTime, NaiveDateTime, TimeZone, Utc};
use reqwest::header::{HeaderMap, RETRY_AFTER};
use reqwest::{Response, StatusCode};
use serde_json::Value;

/// Strip credentials and sensitive query parameters from a URL for safe
/// inclusion in error messages and logs. Drops userinfo (`user:pass@`) and
/// all query parameters (which may contain API keys like `?key=...`).
/// Returns the original string unchanged if it doesn't parse as a URL
/// (e.g. a bare path like "v1/models").
pub fn sanitize_url(raw: &str) -> String {
    let Ok(mut url) = url::Url::parse(raw) else {
        return raw.to_string();
    };
    if !url.username().is_empty() || url.password().is_some() {
        let _ = url.set_username("");
        let _ = url.set_password(None);
    }
    url.set_query(None);
    url.to_string()
}

/// Hard cap on retry delays we'll honor from remote responses. A malformed
/// 429 with `retry_after_seconds: 1e30` (or a far-future HTTP-date) should
/// degrade to "no retry hint" rather than freeze the agent or panic when
/// converting to `Duration`. One hour is well past any legitimate
/// rate-limit window.
const MAX_RETRY_AFTER_SECS: f64 = 3600.0;
const MAX_ERROR_BODY_BYTES: usize = 64 * 1024;

/// Extract a retry delay from a 429 response. Prefers the body's
/// `error.metadata.retry_after_seconds` (OpenRouter shape, more precise than
/// the integer header) and falls back to the RFC 7231 `Retry-After` header
/// in either its delay-seconds form or its HTTP-date form.
fn extract_retry_after(headers: &HeaderMap, payload: Option<&Value>) -> Option<Duration> {
    if let Some(secs) = payload
        .and_then(|p| p.get("error"))
        .and_then(|e| e.get("metadata"))
        .and_then(|m| m.get("retry_after_seconds"))
        .and_then(|v| v.as_f64())
    {
        if let Some(d) = duration_from_finite_secs(secs) {
            return Some(d);
        }
    }

    headers
        .get(RETRY_AFTER)
        .and_then(|h| h.to_str().ok())
        .and_then(|s| parse_retry_after_header(s.trim()))
}

/// Convert a finite, non-negative, in-range seconds value to a `Duration`.
/// Returns `None` for NaN, negative, infinite, or absurdly large inputs —
/// `Duration::from_secs_f64` panics on the latter.
fn duration_from_finite_secs(secs: f64) -> Option<Duration> {
    if !secs.is_finite() || secs < 0.0 {
        return None;
    }
    let clamped = secs.min(MAX_RETRY_AFTER_SECS);
    Some(Duration::from_secs_f64(clamped))
}

/// Parse `Retry-After` per RFC 7231 §7.1.3: either a non-negative integer
/// number of seconds, or an HTTP-date (interpreted as the absolute time at
/// which the request may be retried). A past date is honored as "retry
/// now" (`Duration::ZERO`) rather than dropped — clock skew or near-now
/// timestamps plus network latency commonly produce an HTTP-date that is
/// already in the past, and falling back to exponential backoff would
/// add unnecessary delay against an explicit server hint.
fn parse_retry_after_header(value: &str) -> Option<Duration> {
    if let Ok(secs) = value.parse::<u64>() {
        return duration_from_finite_secs(secs as f64);
    }
    let target = parse_http_date(value)?;
    let delay = target
        .duration_since(SystemTime::now())
        .unwrap_or(Duration::ZERO);
    duration_from_finite_secs(delay.as_secs_f64())
}

/// Parse the three HTTP-date forms RFC 7231 §7.1.1.1 requires recipients to
/// accept: IMF-fixdate (`Sun, 06 Nov 1994 08:49:37 GMT`), the obsolete RFC 850
/// form (`Sunday, 06-Nov-94 08:49:37 GMT`), and asctime (`Sun Nov  6 08:49:37
/// 1994`). All three are interpreted as GMT.
fn parse_http_date(value: &str) -> Option<SystemTime> {
    let value = value.trim();
    if let Ok(dt) = DateTime::parse_from_rfc2822(value) {
        return Some(SystemTime::from(dt));
    }
    if let Some(body) = value.strip_suffix(" GMT") {
        if let Ok(naive) = NaiveDateTime::parse_from_str(body, "%A, %d-%b-%y %H:%M:%S") {
            return Some(SystemTime::from(Utc.from_utc_datetime(&naive)));
        }
    }
    if let Ok(naive) = NaiveDateTime::parse_from_str(value, "%a %b %e %H:%M:%S %Y") {
        return Some(SystemTime::from(Utc.from_utc_datetime(&naive)));
    }
    None
}

pub fn is_context_length_exceeded_message(text: &str) -> bool {
    let text_lower = text.to_lowercase();

    let direct_context_phrases = [
        "context length",
        "context_length_exceeded",
        "context window",
        "context_window_exceeded",
        "context limit",
        "maximum context",
        "max context",
        "maximum prompt length",
        "max prompt length",
    ];
    if direct_context_phrases
        .iter()
        .any(|phrase| text_lower.contains(phrase))
    {
        return true;
    }

    if text_lower.contains("reduce the length")
        && ["message", "messages", "input", "prompt"]
            .iter()
            .any(|word| text_lower.contains(word))
    {
        return true;
    }

    if [
        "input is too long",
        "input too long",
        "prompt is too long",
        "prompt too long",
    ]
    .iter()
    .any(|phrase| text_lower.contains(phrase))
    {
        return true;
    }

    let mentions_prompt_input_tokens = [
        "input token",
        "input length",
        "prompt token",
        "prompt length",
        "message token",
        "messages token",
        "request token",
        "total token",
    ]
    .iter()
    .any(|phrase| text_lower.contains(phrase));
    let mentions_limit = [
        "model limit",
        "model's limit",
        "maximum allowed",
        "max allowed",
        "maximum number of tokens",
        "token limit",
        "tokens limit",
    ]
    .iter()
    .any(|phrase| text_lower.contains(phrase));
    let mentions_overflow = ["exceed", "too long", "too large", "over the limit"]
        .iter()
        .any(|phrase| text_lower.contains(phrase));

    mentions_prompt_input_tokens && mentions_limit && mentions_overflow
}

fn is_image_input_unsupported_message(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    [
        "does not support image",
        "does not support vision",
        "image_url is not supported",
        "image_url is only supported",
        "only text input",
        "image input is not supported",
        "vision is not supported",
    ]
    .iter()
    .any(|phrase| message.contains(phrase))
}

pub fn map_http_error_to_provider_error(
    status: StatusCode,
    payload: Option<Value>,
    url: &str,
) -> ProviderError {
    let url = sanitize_url(url);
    let extract_message = || -> String {
        payload
            .as_ref()
            .and_then(|p| {
                p.get("error")
                    .and_then(|e| e.get("message"))
                    .or_else(|| p.get("message"))
                    .and_then(|m| m.as_str())
                    .map(String::from)
            })
            .unwrap_or_else(|| payload.as_ref().map(|p| p.to_string()).unwrap_or_default())
    };

    let error = match status {
        StatusCode::OK => unreachable!("Should not call this function with OK status"),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => ProviderError::Authentication(format!(
            "Authentication failed for {url}. Check the configured provider credentials and try again."
        )),
        StatusCode::NOT_FOUND => ProviderError::RequestFailed(format!(
            "The provider endpoint or model was not found at {url}. Check the endpoint and model configuration."
        )),
        StatusCode::PAYMENT_REQUIRED => ProviderError::CreditsExhausted {
            details: "The provider rejected the request for billing or credit reasons. Check the provider billing status and try again.".to_string(),
            top_up_url: None,
        },
        StatusCode::PAYLOAD_TOO_LARGE => ProviderError::ContextLengthExceeded(
            "The provider rejected the request size. Send a smaller prompt or fewer attachments."
                .to_string(),
        ),
        StatusCode::BAD_REQUEST => {
            let payload_str = extract_message();
            if is_context_length_exceeded_message(&payload_str) {
                ProviderError::ContextLengthExceeded(
                    "The request exceeds the provider context limit. Send a smaller prompt or fewer attachments."
                        .to_string(),
                )
            } else if is_image_input_unsupported_message(&payload_str) {
                // Keep a bounded capability signal for vision fallback without reflecting server data.
                ProviderError::RequestFailed(
                    "The selected model does not support image input. Choose an image-capable model or configure auxiliary vision.".to_string(),
                )
            } else {
                ProviderError::RequestFailed(
                    "The provider rejected the request. Check the model and request settings, then try again."
                        .to_string(),
                )
            }
        }
        StatusCode::TOO_MANY_REQUESTS => ProviderError::RateLimitExceeded {
            details: "The provider rate limit was reached. Wait and try again.".to_string(),
            retry_delay: None,
        },
        _ if status.is_server_error() => ProviderError::ServerError(format!(
            "Provider service error ({status}) at {url}. Try again later."
        )),
        _ => ProviderError::RequestFailed(format!(
            "Request failed with status {status} at {url}. Check the provider endpoint and request settings."
        )),
    };

    if !status.is_success() {
        tracing::warn!(
            status = %status,
            category = error.telemetry_type(),
            "Provider request failed"
        );
    }

    error
}

async fn read_bounded_error_body(response: &mut Response) -> Vec<u8> {
    let capacity = response
        .content_length()
        .and_then(|length| usize::try_from(length).ok())
        .unwrap_or(MAX_ERROR_BODY_BYTES)
        .min(MAX_ERROR_BODY_BYTES);
    let mut body = Vec::with_capacity(capacity);

    while body.len() < MAX_ERROR_BODY_BYTES {
        let chunk = match response.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) | Err(_) => break,
        };
        let remaining = MAX_ERROR_BODY_BYTES - body.len();
        let bytes_to_copy = chunk.len().min(remaining);
        body.extend_from_slice(&chunk[..bytes_to_copy]);
        if bytes_to_copy < chunk.len() {
            break;
        }
    }

    body
}

pub async fn handle_status(mut response: Response) -> Result<Response, ProviderError> {
    let status = response.status();
    if !status.is_success() {
        let url = sanitize_url(response.url().as_str());
        let headers = response.headers().clone();
        let body = read_bounded_error_body(&mut response).await;
        let payload = serde_json::from_slice::<Value>(&body).ok();
        let mut err = map_http_error_to_provider_error(status, payload.clone(), &url);
        if let ProviderError::RateLimitExceeded { details, .. } = &err {
            err = ProviderError::RateLimitExceeded {
                details: details.clone(),
                retry_delay: extract_retry_after(&headers, payload.as_ref()),
            };
        }
        return Err(err);
    }
    Ok(response)
}

pub async fn handle_response(response: Response) -> Result<Value, ProviderError> {
    let response = handle_status(response).await?;

    response.json::<Value>().await.map_err(|e| {
        ProviderError::RequestFailed(format!("Response body is not valid JSON: {}", e))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn empty_headers() -> HeaderMap {
        HeaderMap::new()
    }

    fn headers_with_retry_after(value: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(RETRY_AFTER, value.parse().unwrap());
        h
    }

    #[test]
    fn image_rejection_survives_redaction_for_ollama_and_openai_shapes() {
        for payload in [
            json!({"error":"model does not support images reflected-secret"}),
            json!({"error":{"message":"image_url is only supported by vision models reflected-secret"}}),
        ] {
            let error = map_http_error_to_provider_error(
                StatusCode::BAD_REQUEST,
                Some(payload),
                "https://ollama.com/v1/chat/completions",
            );
            assert!(error.to_string().contains("does not support image input"));
            assert!(!error.to_string().contains("reflected-secret"));
        }
        for message in [
            "invalid image format",
            "invalid API key",
            "invalid parameter",
            "image too large",
        ] {
            let error = map_http_error_to_provider_error(
                StatusCode::BAD_REQUEST,
                Some(json!({"error":message})),
                "https://ollama.com/v1/chat/completions",
            );
            assert!(!error.to_string().contains("does not support image input"));
        }
    }

    #[test]
    fn retry_after_prefers_body_seconds_over_header() {
        let payload = json!({
            "error": {
                "metadata": { "retry_after_seconds": 22.148 }
            }
        });
        let headers = headers_with_retry_after("5");
        let delay = extract_retry_after(&headers, Some(&payload));
        assert_eq!(delay, Some(Duration::from_secs_f64(22.148)));
    }

    #[test]
    fn retry_after_falls_back_to_header_when_body_missing() {
        let headers = headers_with_retry_after("17");
        let delay = extract_retry_after(&headers, None);
        assert_eq!(delay, Some(Duration::from_secs(17)));
    }

    #[test]
    fn retry_after_returns_none_when_neither_present() {
        let payload = json!({ "error": { "message": "rate limited" } });
        let delay = extract_retry_after(&empty_headers(), Some(&payload));
        assert!(delay.is_none());
    }

    #[test]
    fn retry_after_ignores_negative_or_nan_body_seconds() {
        let payload = json!({ "error": { "metadata": { "retry_after_seconds": -1.0 } } });
        assert!(extract_retry_after(&empty_headers(), Some(&payload)).is_none());

        let payload = json!({ "error": { "metadata": { "retry_after_seconds": "not a number" } } });
        assert!(extract_retry_after(&empty_headers(), Some(&payload)).is_none());
    }

    #[test]
    fn retry_after_past_http_date_means_retry_now() {
        // RFC 7231 allows an HTTP-date in `Retry-After`; a past date means
        // "you may retry now" — surface that as `Duration::ZERO` rather
        // than `None`, so we honor the server hint instead of dropping
        // back to exponential backoff (clock skew or near-now timestamps
        // plus latency commonly land us here).
        let headers = headers_with_retry_after("Fri, 31 Dec 1999 23:59:59 GMT");
        let delay = extract_retry_after(&headers, None);
        assert_eq!(delay, Some(Duration::ZERO));
    }

    #[test]
    fn retry_after_future_http_date_parsed() {
        // A future HTTP-date should produce a positive duration up to the cap.
        let target = chrono::Utc::now() + chrono::Duration::seconds(45);
        let header_value = target.format("%a, %d %b %Y %H:%M:%S GMT").to_string();
        let headers = headers_with_retry_after(&header_value);
        let delay = extract_retry_after(&headers, None).expect("should parse future HTTP-date");
        // Allow some slack for the clock advancing between header creation and parse.
        assert!(
            delay >= Duration::from_secs(30) && delay <= Duration::from_secs(60),
            "expected ~45s, got {delay:?}"
        );
    }

    #[test]
    fn retry_after_parses_rfc850_http_date() {
        // RFC 7231 recipients must accept the obsolete RFC 850 date syntax.
        // Build a future date in that form and assert it round-trips.
        let target = chrono::Utc::now() + chrono::Duration::seconds(90);
        let header_value = target.format("%A, %d-%b-%y %H:%M:%S GMT").to_string();
        let headers = headers_with_retry_after(&header_value);
        let delay = extract_retry_after(&headers, None).expect("rfc850 date should parse");
        assert!(
            delay >= Duration::from_secs(60) && delay <= Duration::from_secs(120),
            "expected ~90s, got {delay:?}"
        );
    }

    #[test]
    fn retry_after_parses_asctime_http_date() {
        // The third HTTP-date form RFC 7231 requires recipients to accept.
        // asctime has no timezone marker; we interpret it as GMT.
        let target = chrono::Utc::now() + chrono::Duration::seconds(120);
        let header_value = target.format("%a %b %e %H:%M:%S %Y").to_string();
        let headers = headers_with_retry_after(&header_value);
        let delay = extract_retry_after(&headers, None).expect("asctime date should parse");
        assert!(
            delay >= Duration::from_secs(90) && delay <= Duration::from_secs(150),
            "expected ~120s, got {delay:?}"
        );
    }

    #[test]
    fn retry_after_clamps_absurd_body_seconds() {
        // `Duration::from_secs_f64(1e30)` panics; the clamp keeps the agent alive.
        let payload = json!({ "error": { "metadata": { "retry_after_seconds": 1e30 } } });
        let delay = extract_retry_after(&empty_headers(), Some(&payload));
        assert_eq!(delay, Some(Duration::from_secs_f64(MAX_RETRY_AFTER_SECS)));
    }

    #[test]
    fn retry_after_clamps_infinite_body_seconds() {
        let payload = json!({ "error": { "metadata": { "retry_after_seconds": f64::INFINITY } } });
        assert!(extract_retry_after(&empty_headers(), Some(&payload)).is_none());
    }

    #[test]
    fn context_length_classifier_accepts_context_window_errors() {
        let messages = [
            "This request exceeds the maximum context length",
            "context_length_exceeded",
            "context window exceeded",
            "Input token count exceeds the maximum number of tokens allowed",
            "Please reduce the length of the messages",
            "prompt is too long for this model",
        ];

        for message in messages {
            assert!(
                is_context_length_exceeded_message(message),
                "expected context-length match for: {message}"
            );
        }
    }

    #[test]
    fn context_length_classifier_rejects_generic_bad_request_errors() {
        let messages = [
            "max_tokens must be less than or equal to 4096",
            "Requested max_tokens exceeds the model output limit",
            "Current token count exceeds your organization quota",
            "temperature exceeds maximum allowed value",
            "schema is too long",
            "metadata length exceeds maximum allowed",
        ];

        for message in messages {
            assert!(
                !is_context_length_exceeded_message(message),
                "expected generic bad request for: {message}"
            );
        }
    }

    #[test]
    fn auth_and_rate_limit_errors_are_actionable_without_reflected_secrets() {
        const REFLECTED_SECRET: &str = "cp05-fixture-secret-must-not-escape";
        let cases = [
            (StatusCode::UNAUTHORIZED, "auth", "credential"),
            (StatusCode::TOO_MANY_REQUESTS, "rate_limit", "try again"),
        ];

        for (status, expected_category, expected_action) in cases {
            let error = map_http_error_to_provider_error(
                status,
                Some(json!({ "error": { "message": REFLECTED_SECRET } })),
                "https://ollama.com/v1/chat/completions?api_key=also-secret",
            );
            let rendered = error.to_string();

            assert_eq!(error.telemetry_type(), expected_category);
            assert!(
                rendered.to_ascii_lowercase().contains(expected_action),
                "{status} must tell the user how to recover: {rendered}"
            );
            assert!(
                !rendered.contains(REFLECTED_SECRET) && !rendered.contains("also-secret"),
                "{status} must not expose reflected or URL secrets: {rendered}"
            );
        }
    }

    #[test]
    fn every_remote_failure_class_is_bounded_and_drops_untrusted_response_text() {
        const CANARY: &str = "cp05-upstream-body-canary-must-not-escape";
        let cases = [
            (StatusCode::BAD_REQUEST, "request", "request settings"),
            (StatusCode::PAYMENT_REQUIRED, "credits_exhausted", "billing"),
            (StatusCode::NOT_FOUND, "request", "endpoint or model"),
            (StatusCode::PAYLOAD_TOO_LARGE, "context_length", "smaller"),
            (StatusCode::INTERNAL_SERVER_ERROR, "server", "try again"),
            (StatusCode::IM_A_TEAPOT, "request", "request failed"),
        ];

        for (status, expected_category, expected_action) in cases {
            let error = map_http_error_to_provider_error(
                status,
                Some(json!({ "error": { "message": CANARY } })),
                "https://ollama.com/v1/chat/completions?token=url-canary",
            );
            let rendered = error.to_string();

            assert_eq!(error.telemetry_type(), expected_category);
            assert!(
                rendered.to_ascii_lowercase().contains(expected_action),
                "{status} must provide a stable recovery action: {rendered}"
            );
            assert!(!rendered.contains(CANARY));
            assert!(!rendered.contains("url-canary"));
            assert!(rendered.len() <= 512, "{status} error is not bounded");
        }
    }

    #[tokio::test]
    async fn handle_status_does_not_parse_error_metadata_beyond_64_kib() {
        const ERROR_BODY_LIMIT: usize = 64 * 1024;
        const CANARY: &str = "cp05-large-error-body-canary-must-not-escape";

        let server = MockServer::start().await;
        let body = format!(
            "{{\"padding\":\"{}\",\"error\":{{\"message\":\"{CANARY}\",\"metadata\":{{\"retry_after_seconds\":31}}}}}}",
            "x".repeat(ERROR_BODY_LIMIT)
        );
        Mock::given(method("GET"))
            .and(path("/large-error"))
            .respond_with(ResponseTemplate::new(429).set_body_raw(body, "application/json"))
            .mount(&server)
            .await;

        let response = reqwest::Client::new()
            .get(format!("{}/large-error", server.uri()))
            .send()
            .await
            .unwrap();
        let error = handle_status(response).await.unwrap_err();
        let rendered = error.to_string();

        assert_eq!(error.telemetry_type(), "rate_limit");
        assert!(!rendered.contains(CANARY));
        assert!(matches!(
            error,
            ProviderError::RateLimitExceeded {
                retry_delay: None,
                ..
            }
        ));
    }
}
