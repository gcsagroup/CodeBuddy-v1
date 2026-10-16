//! Small read-only queries, executed through the normal platform tool boundary.
use anyhow::Result;
use chrono::{DateTime, Local, Utc};
use rmcp::model::{
    CallToolResult, Content, Implementation, InitializeResult, JsonObject, ListToolsResult,
    ServerCapabilities, Tool,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

pub const EXTENSION_NAME: &str = "commonqueries";
pub const CONFIG_KEY: &str = "CODEBUDDY_COMMON_QUERIES";
const GEOCODING_URL: &str = "https://geocoding-api.open-meteo.com/v1/search";
const WEATHER_URL: &str = "https://api.open-meteo.com/v1/forecast";
const MAX_RESPONSE_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct QuerySettings {
    pub network_enabled: bool,
    pub default_city: String,
    pub country_code: String,
    pub units: Units,
    /// A user-selected display timezone; never evidence of physical location.
    pub timezone: String,
}

impl Default for QuerySettings {
    fn default() -> Self {
        Self {
            network_enabled: true,
            default_city: String::new(),
            country_code: String::new(),
            units: Units::Metric,
            timezone: String::new(),
        }
    }
}

impl QuerySettings {
    pub fn validate(&self) -> std::result::Result<(), String> {
        if self.default_city.chars().count() > 120 {
            return Err("Default city must be at most 120 characters".into());
        }
        validate_country(&self.country_code)?;
        if !self.timezone.is_empty() {
            self.timezone
                .parse::<chrono_tz::Tz>()
                .map_err(|_| "Use an IANA timezone such as Asia/Shanghai".to_string())?;
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Units {
    #[default]
    Metric,
    Imperial,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct TimeParams {
    /// IANA timezone, e.g. Asia/Shanghai or America/New_York. Omit for configured timezone or host local time.
    timezone: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct LocationParams {
    /// City or district name supplied by the user, not inferred from the computer timezone.
    query: String,
    /// Optional two-letter ISO country code to narrow the results.
    country_code: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Coordinates {
    latitude: f64,
    longitude: f64,
    /// Name of the place confirmed by the user or returned by location_resolve.
    name: String,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
enum QueryKind {
    #[default]
    Current,
    Forecast,
    Both,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct WeatherParams {
    /// City supplied by the user. Omit to use their configured default query city.
    location: Option<String>,
    /// Use coordinates from location_resolve or the user when choosing an ambiguous place. Do not invent coordinates.
    coordinates: Option<Coordinates>,
    country_code: Option<String>,
    #[serde(default)]
    query_kind: QueryKind,
    units: Option<Units>,
    /// Forecast days including today, between 1 and 7; defaults to 3.
    days: Option<u8>,
}

fn failure(status: &str, message: &str) -> Value {
    json!({"status":status, "message":message})
}

pub fn time_at(now: DateTime<Utc>, timezone: Option<&str>) -> std::result::Result<Value, String> {
    let (local, zone, source, weekday) =
        if let Some(zone) = timezone.filter(|zone| !zone.is_empty()) {
            let tz = zone
                .parse::<chrono_tz::Tz>()
                .map_err(|_| "Unknown IANA timezone".to_string())?;
            let local = now.with_timezone(&tz);
            (
                local.fixed_offset(),
                zone.to_string(),
                "configured_or_requested_timezone",
                local.format("%A").to_string(),
            )
        } else {
            let local = now.with_timezone(&Local);
            (
                local.fixed_offset(),
                "host_local".to_string(),
                "host_system_timezone",
                local.format("%A").to_string(),
            )
        };
    Ok(
        json!({"status":"ok", "utc":now.to_rfc3339(), "local_time":local.to_rfc3339(),
        "date":local.format("%Y-%m-%d").to_string(), "weekday":weekday,
        "utc_offset_seconds":local.offset().local_minus_utc(), "timezone":zone, "timezone_source":source,
        "source":"host_system_clock", "sampled_at":now.to_rfc3339(), "cached":false,
        "location_known":false}),
    )
}

fn validate_country(country: &str) -> std::result::Result<(), String> {
    if !country.is_empty()
        && (country.len() != 2 || !country.bytes().all(|byte| byte.is_ascii_alphabetic()))
    {
        return Err("country_code must be a two-letter ISO code".into());
    }
    Ok(())
}

struct CachedQuery {
    inserted: Instant,
    value: Value,
}

pub struct CommonQueriesClient {
    info: InitializeResult,
    http: reqwest::Client,
    geocoding_url: String,
    weather_url: String,
    cache: Mutex<HashMap<String, CachedQuery>>,
    retry_after: Mutex<Option<Instant>>,
}

impl CommonQueriesClient {
    fn with_endpoints(geocoding_url: String, weather_url: String) -> Result<Self> {
        Ok(Self {
            info: InitializeResult::new(ServerCapabilities::builder().enable_tools().build())
                .with_server_info(
                    Implementation::new(EXTENSION_NAME, "1.0.0").with_title("Common queries"),
                ),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(12))
                .connect_timeout(Duration::from_secs(5))
                .redirect(reqwest::redirect::Policy::none())
                .user_agent("CodeBuddy/1.43 common-queries")
                .build()?,
            geocoding_url,
            weather_url,
            cache: Mutex::new(HashMap::new()),
            retry_after: Mutex::new(None),
        })
    }

    pub fn tools() -> Vec<Tool> {
        vec![
            Tool::new("time_now", "Read the host clock, date and weekday in local or requested IANA timezone. Timezone does not establish user location.", serde_json::to_value(schemars::schema_for!(TimeParams)).unwrap().as_object().unwrap().clone()).annotate(rmcp::model::ToolAnnotations::from_raw(Some("time_now".into()), Some(true), Some(false), Some(true), Some(false))),
            Tool::new("location_resolve", "Look up user-specified cities or districts. Return candidates with coordinates; ask the user to disambiguate, never assume current physical location.", serde_json::to_value(schemars::schema_for!(LocationParams)).unwrap().as_object().unwrap().clone()).annotate(rmcp::model::ToolAnnotations::from_raw(Some("location_resolve".into()), Some(true), Some(false), Some(true), Some(true))),
            Tool::new("weather_get", "Query current weather or a 1-7 day forecast from Open-Meteo. Cite city, units, data time and source; stale data is not current. Omitted location uses configured default city, not detected physical location. Ask user on needs_location. Free endpoint is for non-commercial use.", serde_json::to_value(schemars::schema_for!(WeatherParams)).unwrap().as_object().unwrap().clone()).annotate(rmcp::model::ToolAnnotations::from_raw(Some("weather_get".into()), Some(true), Some(false), Some(true), Some(true))),
        ]
    }

    async fn request(
        &self,
        url: &str,
        params: &[(String, String)],
    ) -> std::result::Result<Value, Value> {
        if let Some(until) = *self.retry_after.lock().await {
            if until > Instant::now() {
                return Err(
                    json!({"status":"rate_limited", "retry_after_seconds":until.saturating_duration_since(Instant::now()).as_secs().saturating_add(1), "message":"Provider retry window is still active"}),
                );
            }
        }
        let mut url = reqwest::Url::parse(url).expect("fixed provider URL");
        url.query_pairs_mut()
            .extend_pairs(params.iter().map(|(key, value)| (key, value)));
        let mut response = self.http.get(url).send().await.map_err(|_| {
            failure(
                "provider_unavailable",
                "Weather service request failed or timed out",
            )
        })?;
        if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            let retry = response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned);
            let seconds = retry
                .as_deref()
                .and_then(|value| {
                    value.parse::<u64>().ok().or_else(|| {
                        chrono::DateTime::parse_from_rfc2822(value)
                            .ok()
                            .map(|date| {
                                (date.with_timezone(&Utc) - Utc::now()).num_seconds().max(1) as u64
                            })
                    })
                })
                .unwrap_or(60)
                .clamp(1, 86400);
            *self.retry_after.lock().await = Some(Instant::now() + Duration::from_secs(seconds));
            return Err(
                json!({"status":"rate_limited", "retry_after":retry, "message":"Provider rate limit reached; do not retry immediately"}),
            );
        }
        if !response.status().is_success() {
            return Err(failure(
                "provider_unavailable",
                "Weather service returned an unsuccessful status",
            ));
        }
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| failure("provider_unavailable", "Weather response was interrupted"))?
        {
            if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err(failure(
                    "invalid_response",
                    "Weather response exceeds the size limit",
                ));
            }
            body.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&body)
            .map_err(|_| failure("invalid_response", "Weather service returned invalid JSON"))
    }

    async fn cached(&self, key: &str, ttl: Duration) -> Option<Value> {
        let cache = self.cache.lock().await;
        let entry = cache.get(key)?;
        if entry.inserted.elapsed() >= ttl {
            return None;
        }
        if entry.value["daily"].is_object() {
            if let (Some(zone), Some(fetched)) = (
                entry.value["timezone"]
                    .as_str()
                    .and_then(|zone| zone.parse::<chrono_tz::Tz>().ok()),
                entry.value["fetched_at"]
                    .as_str()
                    .and_then(|time| DateTime::parse_from_rfc3339(time).ok()),
            ) {
                if fetched.with_timezone(&zone).date_naive()
                    != Utc::now().with_timezone(&zone).date_naive()
                {
                    return None;
                }
            }
        }
        let mut value = entry.value.clone();
        value["cached"] = json!(true);
        Some(value)
    }

    async fn store(&self, key: String, value: &Value) {
        let mut cache = self.cache.lock().await;
        if cache.len() >= 256 {
            if let Some(oldest) = cache
                .iter()
                .min_by_key(|(_, item)| item.inserted)
                .map(|(key, _)| key.clone())
            {
                cache.remove(&oldest);
            }
        }
        cache.insert(
            key,
            CachedQuery {
                inserted: Instant::now(),
                value: value.clone(),
            },
        );
    }

    async fn resolve(&self, params: LocationParams) -> std::result::Result<Value, Value> {
        let query = params.query.trim();
        if query.chars().count() < 2 || query.chars().count() > 120 {
            return Err(failure(
                "invalid_arguments",
                "Location query must contain 2 to 120 characters",
            ));
        }
        let country = params.country_code.unwrap_or_default().to_uppercase();
        validate_country(&country).map_err(|e| failure("invalid_arguments", &e))?;
        let key = format!("geo:{query}:{country}:zh");
        if let Some(value) = self.cached(&key, Duration::from_secs(86400)).await {
            return Ok(value);
        }
        let mut query_params = vec![
            ("name".into(), query.into()),
            ("count".into(), "10".into()),
            ("language".into(), "zh".into()),
            ("format".into(), "json".into()),
        ];
        if !country.is_empty() {
            query_params.push(("countryCode".into(), country));
        }
        let response = self.request(&self.geocoding_url, &query_params).await?;
        let mut candidates = Vec::new();
        if let Some(results) = response.get("results") {
            for place in results
                .as_array()
                .ok_or_else(|| failure("invalid_response", "Invalid location results"))?
            {
                let lat = place["latitude"].as_f64();
                let lon = place["longitude"].as_f64();
                if !lat.is_some_and(|n| (-90.0..=90.0).contains(&n))
                    || !lon.is_some_and(|n| (-180.0..=180.0).contains(&n))
                    || !place["name"].is_string()
                {
                    return Err(failure("invalid_response", "Invalid location coordinates"));
                }
                candidates.push(json!({"id":place["id"],"name":place["name"], "latitude":lat,"longitude":lon,
                    "country":place["country"], "country_code":place["country_code"],"admin1":place["admin1"],"admin2":place["admin2"],"timezone":place["timezone"]}));
            }
        } else if !response.is_object() || response.get("error").is_some() {
            return Err(failure("invalid_response", "Invalid location response"));
        }
        let mut result = json!({"status":if candidates.is_empty() {"not_found"} else {"ok"}, "candidates":candidates,
            "provider":"open-meteo", "location_source":"geocoding_query", "source_url":"https://open-meteo.com/en/docs/geocoding-api",
            "fetched_at":Utc::now().to_rfc3339(), "cached":false,"stale":false});
        if candidates.is_empty() {
            result["message"] = json!("No matching place was returned by this provider. Avoid repeated spelling or language variants without new evidence. Ask for a clearer location, or resolve a known parent city and explicitly label any weather as city-level reference, not an exact district forecast. Do not invent coordinates.");
        }
        self.store(key, &result).await;
        Ok(result)
    }

    async fn weather(
        &self,
        params: WeatherParams,
        settings: &QuerySettings,
    ) -> std::result::Result<Value, Value> {
        let days = params.days.unwrap_or(3);
        if !(1..=7).contains(&days) {
            return Err(failure("invalid_arguments", "days must be between 1 and 7"));
        }
        if params.coordinates.is_some() && params.location.is_some() {
            return Err(failure(
                "invalid_arguments",
                "Provide location or coordinates, not both",
            ));
        }
        let units = params.units.unwrap_or(settings.units);
        let (coordinates, location_source) = if let Some(coords) = params.coordinates {
            (coords, "explicit_coordinates")
        } else {
            let explicit = params.location.is_some();
            let city = params
                .location
                .unwrap_or_else(|| settings.default_city.clone());
            if city.trim().is_empty() {
                return Err(failure("needs_location", "Ask the user for a city. No default query city is configured; timezone is not location."));
            }
            let location = self
                .resolve(LocationParams {
                    query: city,
                    country_code: params.country_code.or_else(|| {
                        (!explicit && !settings.country_code.is_empty())
                            .then(|| settings.country_code.clone())
                    }),
                })
                .await?;
            let candidates = location["candidates"]
                .as_array()
                .expect("normalized locations");
            if candidates.len() != 1 {
                return Err(
                    json!({"status":"needs_location", "message":"Ask the user to choose or narrow the place; do not assume the first candidate", "candidates":candidates}),
                );
            }
            let place = &candidates[0];
            (
                Coordinates {
                    latitude: place["latitude"].as_f64().unwrap(),
                    longitude: place["longitude"].as_f64().unwrap(),
                    name: format!(
                        "{}, {}, {}",
                        place["name"].as_str().unwrap(),
                        place["admin1"].as_str().unwrap_or(""),
                        place["country"].as_str().unwrap_or("")
                    ),
                },
                if explicit {
                    "explicit_city"
                } else {
                    "configured_default_city"
                },
            )
        };
        if !(-90.0..=90.0).contains(&coordinates.latitude)
            || !(-180.0..=180.0).contains(&coordinates.longitude)
            || coordinates.name.trim().is_empty()
            || coordinates.name.chars().count() > 300
        {
            return Err(failure(
                "invalid_arguments",
                "Provide valid coordinates and a location name",
            ));
        }
        let unit = match units {
            Units::Metric => "celsius",
            Units::Imperial => "fahrenheit",
        };
        // Include the UTC date so cached daily forecasts never cross midnight silently.
        let key = format!(
            "weather:{}:{}:{unit}:{:?}:{days}:{}",
            coordinates.latitude,
            coordinates.longitude,
            params.query_kind,
            Utc::now().date_naive()
        );
        if let Some(mut value) = self.cached(&key, Duration::from_secs(300)).await {
            value["location"] = json!(coordinates);
            value["location_source"] = json!(location_source);
            return Ok(value);
        }
        let mut query = vec![
            ("latitude".into(), coordinates.latitude.to_string()),
            ("longitude".into(), coordinates.longitude.to_string()),
            ("timezone".into(), "auto".into()),
            ("temperature_unit".into(), unit.into()),
            ("forecast_days".into(), days.to_string()),
        ];
        if matches!(params.query_kind, QueryKind::Current | QueryKind::Both) {
            query.push(("current".into(), "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m".into()));
        }
        if matches!(params.query_kind, QueryKind::Forecast | QueryKind::Both) {
            query.push((
                "daily".into(),
                "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max"
                    .into(),
            ));
        }
        let response = self.request(&self.weather_url, &query).await;
        let response = match response {
            Ok(value) => value,
            Err(error) => {
                let cache = self.cache.lock().await;
                if let Some(entry) = cache
                    .get(&key)
                    .filter(|entry| entry.inserted.elapsed() < Duration::from_secs(3600))
                {
                    let mut value = entry.value.clone();
                    value["status"] = json!("stale");
                    value["stale"] = json!(true);
                    value["cached"] = json!(true);
                    value["refresh_error"] = error;
                    value["location"] = json!(coordinates);
                    value["location_source"] = json!(location_source);
                    return Ok(value);
                }
                return Err(error);
            }
        };
        if !response["timezone"].is_string()
            || (matches!(params.query_kind, QueryKind::Current | QueryKind::Both)
                && (!response["current"].is_object() || !response["current_units"].is_object()))
            || (matches!(params.query_kind, QueryKind::Forecast | QueryKind::Both)
                && (!response["daily"].is_object() || !response["daily_units"].is_object()))
        {
            return Err(failure(
                "invalid_response",
                "Weather service response is missing requested data or units",
            ));
        }
        let result = json!({"status":"ok", "location":coordinates,"location_source":location_source,
            "timezone":response["timezone"],"utc_offset_seconds":response["utc_offset_seconds"],
            "current":response["current"],"current_units":response["current_units"],"daily":response["daily"],"daily_units":response["daily_units"],
            "valid_at":response["current"]["time"],"observed_at":Value::Null,"fetched_at":Utc::now().to_rfc3339(),
            "provider":"open-meteo","data_kind":"weather_model", "cached":false,"stale":false,
            "source_url":"https://open-meteo.com/","attribution":"Weather data by Open-Meteo.com (CC BY 4.0)"});
        self.store(key, &result).await;
        Ok(result)
    }

    async fn execute(
        &self,
        name: &str,
        arguments: Option<JsonObject>,
        settings: &QuerySettings,
    ) -> std::result::Result<Value, Value> {
        let args = Value::Object(arguments.unwrap_or_default());
        if name == "time_now" {
            let params: TimeParams = serde_json::from_value(args)
                .map_err(|_| failure("invalid_arguments", "Expected an optional IANA timezone"))?;
            return time_at(
                Utc::now(),
                params.timezone.as_deref().or(Some(&settings.timezone)),
            )
            .map_err(|e| failure("invalid_arguments", &e));
        }
        if !settings.network_enabled {
            return Err(failure(
                "network_disabled",
                "Online common queries are disabled in settings",
            ));
        }
        match name {
            "location_resolve" => {
                self.resolve(serde_json::from_value(args).map_err(|_| {
                    failure("invalid_arguments", "Invalid location query parameters")
                })?)
                .await
            }
            "weather_get" => {
                self.weather(
                    serde_json::from_value(args).map_err(|_| {
                        failure("invalid_arguments", "Invalid weather query parameters")
                    })?,
                    settings,
                )
                .await
            }
            _ => Err(failure("unknown_tool", "Unknown common query tool")),
        }
    }
}

/// Standalone MCP projection of the existing query implementation. The host owns
/// the per-request metadata; tool arguments cannot change network policy.
pub struct CommonQueriesServer {
    client: CommonQueriesClient,
}

impl CommonQueriesServer {
    pub fn new() -> Result<Self> {
        Ok(Self {
            client: CommonQueriesClient::with_endpoints(GEOCODING_URL.into(), WEATHER_URL.into())?,
        })
    }

    async fn query(
        &self,
        name: &str,
        arguments: Option<JsonObject>,
        metadata: Option<Value>,
        cancellation: CancellationToken,
    ) -> CallToolResult {
        let settings = (|| {
            let metadata =
                metadata.ok_or_else(|| anyhow::anyhow!("Missing query settings metadata"))?;
            let settings: QuerySettings = serde_json::from_value(metadata)?;
            settings.validate().map_err(anyhow::Error::msg)?;
            Ok::<_, anyhow::Error>(settings)
        })();
        let result = match settings {
            Ok(settings) => tokio::select! {
                biased;
                _ = cancellation.cancelled() => Err(failure("cancelled", "Query cancelled")),
                result = tokio::time::timeout(Duration::from_secs(25), self.client.execute(name, arguments, &settings)) => result.unwrap_or_else(|_| Err(failure("provider_unavailable", "Query deadline exceeded"))),
            },
            Err(_) => Err(failure(
                "invalid_configuration",
                "Common query settings metadata is missing or invalid",
            )),
        };
        match result {
            Ok(value) => CallToolResult::success(vec![Content::text(value.to_string())]),
            Err(value) => CallToolResult::error(vec![Content::text(value.to_string())]),
        }
    }
}

impl rmcp::ServerHandler for CommonQueriesServer {
    fn get_info(&self) -> rmcp::model::ServerInfo {
        self.client.info.clone()
    }

    async fn list_tools(
        &self,
        _pagination: Option<rmcp::model::PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> Result<ListToolsResult, rmcp::ErrorData> {
        Ok(ListToolsResult {
            tools: CommonQueriesClient::tools(),
            next_cursor: None,
            meta: None,
        })
    }

    async fn call_tool(
        &self,
        request: rmcp::model::CallToolRequestParams,
        context: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        Ok(self
            .query(
                &request.name,
                request.arguments,
                context
                    .meta
                    .0
                    .get("codebuddy/common-query-settings")
                    .cloned(),
                context.ct,
            )
            .await)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::{
        matchers::{method, path, query_param},
        Mock, MockServer, ResponseTemplate,
    };

    #[tokio::test]
    async fn standalone_queries_reload_policy_and_reject_invalid_settings() {
        let server = CommonQueriesServer::new().unwrap();
        let mut settings = json!({"network_enabled":false,"timezone":"Asia/Shanghai"});
        let time = server
            .query(
                "time_now",
                None,
                Some(settings.clone()),
                CancellationToken::new(),
            )
            .await;
        assert_eq!(time.is_error, Some(false));
        assert!(serde_json::to_string(&time)
            .unwrap()
            .contains("Asia/Shanghai"));
        let weather = server
            .query(
                "weather_get",
                None,
                Some(settings.clone()),
                CancellationToken::new(),
            )
            .await;
        assert_eq!(weather.is_error, Some(true));
        assert!(serde_json::to_string(&weather)
            .unwrap()
            .contains("network_disabled"));
        settings["timezone"] = json!("UTC");
        let time = server
            .query("time_now", None, Some(settings), CancellationToken::new())
            .await;
        assert!(serde_json::to_string(&time).unwrap().contains("UTC"));
        for metadata in [
            None,
            Some(json!({"network_enabled":"false"})),
            Some(json!({"timezone":"invalid"})),
        ] {
            let invalid = server
                .query("weather_get", None, metadata, CancellationToken::new())
                .await;
            assert_eq!(invalid.is_error, Some(true));
            assert!(serde_json::to_string(&invalid)
                .unwrap()
                .contains("invalid_configuration"));
        }
    }

    fn args(value: Value) -> Option<JsonObject> {
        Some(value.as_object().unwrap().clone())
    }
    fn current(temperature: Value) -> Value {
        json!({"timezone":"Asia/Shanghai", "utc_offset_seconds":28800,
            "current":{"time":"2026-10-12T12:00","temperature_2m":temperature,"precipitation":null},
            "current_units":{"time":"iso8601","temperature_2m":"°C","precipitation":"mm"}})
    }
    async fn client() -> (MockServer, CommonQueriesClient) {
        let server = MockServer::start().await;
        let client = CommonQueriesClient::with_endpoints(
            format!("{}/geo", server.uri()),
            format!("{}/weather", server.uri()),
        )
        .unwrap();
        (server, client)
    }
    fn coordinate_args() -> Value {
        json!({"coordinates":{"name":"广州","latitude":23.13,"longitude":113.26}})
    }

    #[test]
    fn common_queries_clock_handles_midnight_dst_and_invalid_zones() {
        let now: DateTime<Utc> = "2026-03-08T06:59:59Z".parse().unwrap();
        assert_eq!(
            time_at(now, Some("America/New_York")).unwrap()["local_time"],
            "2026-03-08T01:59:59-05:00"
        );
        assert_eq!(
            time_at(now + chrono::Duration::seconds(1), Some("America/New_York")).unwrap()
                ["local_time"],
            "2026-03-08T03:00:00-04:00"
        );
        let midnight = time_at(
            "2026-10-12T16:00:00Z".parse().unwrap(),
            Some("Asia/Shanghai"),
        )
        .unwrap();
        assert_eq!(midnight["date"], "2026-10-13");
        assert_eq!(midnight["weekday"], "Tuesday");
        assert_eq!(midnight["location_known"], false);
        assert!(time_at(now, Some("Not/AZone")).is_err());
    }

    #[tokio::test]
    async fn common_queries_network_denial_also_blocks_cached_results_but_not_clock() {
        let (server, client) = client().await;
        Mock::given(path("/weather"))
            .respond_with(ResponseTemplate::new(200).set_body_json(current(json!(26.1))))
            .expect(1)
            .mount(&server)
            .await;
        client
            .execute(
                "weather_get",
                args(coordinate_args()),
                &QuerySettings::default(),
            )
            .await
            .unwrap();
        let settings = QuerySettings {
            network_enabled: false,
            ..Default::default()
        };
        assert_eq!(
            client
                .execute("weather_get", args(coordinate_args()), &settings)
                .await
                .unwrap_err()["status"],
            "network_disabled"
        );
        assert_eq!(
            client.execute("time_now", None, &settings).await.unwrap()["status"],
            "ok"
        );
    }

    #[tokio::test]
    async fn common_queries_missing_district_does_not_invent_coordinates_or_query_weather() {
        let (server, client) = client().await;
        Mock::given(path("/geo"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({"generationtime_ms": 0.2})),
            )
            .expect(1)
            .mount(&server)
            .await;
        let result = client
            .execute(
                "location_resolve",
                args(json!({"query":"广州市天河区","country_code":"CN"})),
                &QuerySettings::default(),
            )
            .await
            .unwrap();
        assert_eq!(result["status"], "not_found");
        assert_eq!(result["candidates"], json!([]));
        assert!(result["message"]
            .as_str()
            .unwrap()
            .contains("city-level reference"));
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn common_queries_unknown_and_ambiguous_locations_make_no_weather_request() {
        let (server, client) = client().await;
        assert_eq!(
            client
                .execute("weather_get", args(json!({})), &QuerySettings::default())
                .await
                .unwrap_err()["status"],
            "needs_location"
        );
        Mock::given(path("/geo"))
            .and(query_param("countryCode", "US"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"results":[
            {"name":"Springfield","latitude":39.78,"longitude":-89.65,"admin1":"Illinois"},
            {"name":"Springfield","latitude":42.1,"longitude":-72.59,"admin1":"Massachusetts"}]})))
            .expect(1)
            .mount(&server)
            .await;
        let result = client
            .execute(
                "weather_get",
                args(json!({"location":"Springfield","country_code":"US"})),
                &QuerySettings::default(),
            )
            .await
            .unwrap_err();
        assert_eq!(result["status"], "needs_location");
        assert_eq!(result["candidates"].as_array().unwrap().len(), 2);
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn common_queries_units_cache_missing_values_and_source_are_preserved() {
        let (server, client) = client().await;
        Mock::given(method("GET"))
            .and(path("/weather"))
            .and(query_param("temperature_unit", "celsius"))
            .respond_with(ResponseTemplate::new(200).set_body_json(current(json!(26.1))))
            .expect(1)
            .mount(&server)
            .await;
        let settings = QuerySettings::default();
        let first = client
            .execute("weather_get", args(coordinate_args()), &settings)
            .await
            .unwrap();
        assert_eq!(first["current"]["temperature_2m"], 26.1);
        assert!(first["current"]["precipitation"].is_null());
        assert_eq!(first["data_kind"], "weather_model");
        assert!(first["observed_at"].is_null());
        assert_eq!(first["cached"], false);
        let second = client
            .execute("weather_get", args(coordinate_args()), &settings)
            .await
            .unwrap();
        assert_eq!(second["cached"], true);
        assert_eq!(first["fetched_at"], second["fetched_at"]);
        let mut imperial = coordinate_args();
        imperial["units"] = json!("imperial");
        Mock::given(path("/weather"))
            .and(query_param("temperature_unit", "fahrenheit"))
            .respond_with(ResponseTemplate::new(429).insert_header("Retry-After", "60"))
            .expect(1)
            .mount(&server)
            .await;
        let limited = client
            .execute("weather_get", args(imperial), &settings)
            .await
            .unwrap_err();
        assert_eq!(limited["status"], "rate_limited");
        assert_eq!(limited["retry_after"], "60");
        let mut retry = coordinate_args();
        retry["units"] = json!("imperial");
        assert_eq!(
            client
                .execute("weather_get", args(retry), &settings)
                .await
                .unwrap_err()["status"],
            "rate_limited"
        );
    }

    #[tokio::test]
    async fn common_queries_expired_cache_is_marked_stale_after_failure() {
        let (server, client) = client().await;
        Mock::given(path("/weather"))
            .respond_with(ResponseTemplate::new(200).set_body_json(current(json!(19.5))))
            .mount(&server)
            .await;
        let original = client
            .execute(
                "weather_get",
                args(coordinate_args()),
                &QuerySettings::default(),
            )
            .await
            .unwrap();
        for item in client.cache.lock().await.values_mut() {
            item.inserted = Instant::now() - Duration::from_secs(301);
        }
        server.reset().await;
        Mock::given(path("/weather"))
            .respond_with(ResponseTemplate::new(503))
            .expect(1)
            .mount(&server)
            .await;
        let stale = client
            .execute(
                "weather_get",
                args(coordinate_args()),
                &QuerySettings::default(),
            )
            .await
            .unwrap();
        assert_eq!(stale["status"], "stale");
        assert_eq!(stale["stale"], true);
        assert_eq!(stale["fetched_at"], original["fetched_at"]);
        assert_eq!(stale["refresh_error"]["status"], "provider_unavailable");
    }

    #[tokio::test]
    async fn common_queries_invalid_parameters_and_invalid_provider_data() {
        let (server, client) = client().await;
        let settings = QuerySettings::default();
        for value in [
            json!({"days":0}),
            json!({"days":8}),
            json!({"units":"kelvin"}),
            json!({"coordinates":{"latitude":91,"longitude":20,"name":"x"}}),
        ] {
            assert_eq!(
                client
                    .execute("weather_get", args(value), &settings)
                    .await
                    .unwrap_err()["status"],
                "invalid_arguments"
            );
        }
        assert!(server.received_requests().await.unwrap().is_empty());
        Mock::given(path("/weather"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"current":{}})))
            .mount(&server)
            .await;
        assert_eq!(
            client
                .execute("weather_get", args(coordinate_args()), &settings)
                .await
                .unwrap_err()["status"],
            "invalid_response"
        );
    }

    #[tokio::test]
    async fn common_queries_default_city_is_labelled_as_preference_not_detection() {
        let (server, client) = client().await;
        Mock::given(path("/geo")).and(query_param("name","Guangzhou")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"results":[{"name":"广州","latitude":23.13,"longitude":113.26,"country":"中国","admin1":"广东"}]}))).mount(&server).await;
        Mock::given(path("/weather"))
            .respond_with(ResponseTemplate::new(200).set_body_json(current(json!(23))))
            .mount(&server)
            .await;
        let settings = QuerySettings {
            default_city: "Guangzhou".into(),
            ..Default::default()
        };
        let result = client
            .execute("weather_get", args(json!({})), &settings)
            .await
            .unwrap();
        assert_eq!(result["location_source"], "configured_default_city");
    }

    #[tokio::test]
    async fn common_queries_timeout_and_cancellation_do_not_fabricate_data() {
        let (server, mut client) = client().await;
        client.http = reqwest::Client::builder()
            .timeout(Duration::from_millis(30))
            .build()
            .unwrap();
        Mock::given(path("/weather"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(Duration::from_millis(200))
                    .set_body_json(current(json!(24))),
            )
            .expect(1)
            .mount(&server)
            .await;
        assert_eq!(
            client
                .execute(
                    "weather_get",
                    args(coordinate_args()),
                    &QuerySettings::default()
                )
                .await
                .unwrap_err()["status"],
            "provider_unavailable"
        );
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        let result = CommonQueriesServer { client }
            .query(
                "weather_get",
                args(coordinate_args()),
                Some(serde_json::to_value(QuerySettings::default()).unwrap()),
                cancellation,
            )
            .await;
        assert_eq!(result.is_error, Some(true));
        assert!(result
            .content
            .iter()
            .filter_map(|item| item.as_text())
            .any(|item| item.text.contains("cancelled")));
    }

    #[tokio::test]
    #[ignore = "calls the public Open-Meteo service"]
    async fn common_queries_live_provider() {
        let client =
            CommonQueriesClient::with_endpoints(GEOCODING_URL.into(), WEATHER_URL.into()).unwrap();
        let result = client
            .execute(
                "location_resolve",
                args(json!({"query":"Guangzhou","country_code":"CN"})),
                &QuerySettings::default(),
            )
            .await
            .unwrap();
        assert!(!result["candidates"].as_array().unwrap().is_empty());
        let mut weather = coordinate_args();
        weather["query_kind"] = json!("both");
        weather["days"] = json!(3);
        let weather = client
            .execute("weather_get", args(weather), &QuerySettings::default())
            .await
            .unwrap();
        assert!(weather["current"]["temperature_2m"].is_number());
        assert_eq!(weather["daily"]["time"].as_array().unwrap().len(), 3);
        println!("{weather}");
    }
}
