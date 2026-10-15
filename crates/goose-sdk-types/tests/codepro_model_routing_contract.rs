use agent_client_protocol::JsonRpcMessage;
use goose_sdk_types::custom_requests::{
    CodeProModelRoute, CodeProModelRoutingConfig, CodeProModelRoutingReadRequest,
    CodeProModelRoutingReadResponse, CodeProModelRoutingRole, CodeProModelRoutingSaveRequest,
    CodeProVisionRoute, CodeProVisionRoutingMode, DefaultsSaveRequest, ImageInputOverride,
    ModelCapabilityOverride, ModelCapabilityOverridesConfig, ModelCapabilityOverridesReadRequest,
    ModelCapabilityOverridesSaveRequest, ModelCapabilityResolveRequest,
    CODEPRO_MODEL_ROUTING_CONFIG_KEY, CODEPRO_MODEL_ROUTING_CONFIG_VERSION,
    MODEL_CAPABILITY_OVERRIDES_CONFIG_KEY,
};

fn enabled_routing() -> CodeProModelRoutingConfig {
    CodeProModelRoutingConfig {
        version: CODEPRO_MODEL_ROUTING_CONFIG_VERSION,
        advanced_routing_enabled: true,
        routes: vec![
            CodeProModelRoute {
                role: CodeProModelRoutingRole::Planner,
                provider_id: "anthropic".to_string(),
                model_id: "claude-sonnet-4-5".to_string(),
            },
            CodeProModelRoute {
                role: CodeProModelRoutingRole::Coder,
                provider_id: "openai".to_string(),
                model_id: "gpt-5-codex".to_string(),
            },
            CodeProModelRoute {
                role: CodeProModelRoutingRole::Tester,
                provider_id: "openai".to_string(),
                model_id: "gpt-5".to_string(),
            },
            CodeProModelRoute {
                role: CodeProModelRoutingRole::Reviewer,
                provider_id: "anthropic".to_string(),
                model_id: "claude-opus-4-1".to_string(),
            },
        ],
        vision_route: CodeProVisionRoute {
            enabled: true,
            mode: CodeProVisionRoutingMode::Auto,
            provider_id: Some("configured-vision-provider".into()),
            model_id: Some("configured-vision-model".into()),
        },
        max_parallel_coders: 2,
    }
}

#[test]
fn typed_routing_methods_and_camel_case_payloads_are_stable() {
    assert_eq!(
        CodeProModelRoutingReadRequest::default().method(),
        "_goose/unstable/codepro/model-routing/read"
    );
    assert_eq!(
        CodeProModelRoutingSaveRequest {
            config: enabled_routing(),
        }
        .method(),
        "_goose/unstable/codepro/model-routing/save"
    );
    assert_eq!(
        CODEPRO_MODEL_ROUTING_CONFIG_KEY,
        "GOOSE_CODEPRO_MODEL_ROUTING"
    );
    assert_eq!(CODEPRO_MODEL_ROUTING_CONFIG_VERSION, 2);

    let payload = serde_json::to_value(CodeProModelRoutingSaveRequest {
        config: enabled_routing(),
    })
    .unwrap();
    assert_eq!(payload["config"]["version"], 2);
    assert_eq!(payload["config"]["visionRoute"]["mode"], "auto");
    assert_eq!(payload["config"]["advancedRoutingEnabled"], true);
    assert_eq!(payload["config"]["maxParallelCoders"], 2);
    assert_eq!(payload["config"]["routes"][0]["role"], "planner");
    assert_eq!(payload["config"]["routes"][0]["providerId"], "anthropic");
    assert_eq!(
        payload["config"]["routes"][0]["modelId"],
        "claude-sonnet-4-5"
    );

    let read = serde_json::to_value(CodeProModelRoutingReadResponse {
        config: Some(enabled_routing()),
    })
    .unwrap();
    assert!(read["config"].is_object());
}

#[test]
fn routing_contract_rejects_unknown_fields_and_non_versioned_shapes() {
    let valid = serde_json::to_value(enabled_routing()).unwrap();
    let mut cases = Vec::new();

    let mut missing_role = valid.clone();
    missing_role["routes"].as_array_mut().unwrap().pop();
    cases.push(("enabled routing missing role", missing_role));

    let mut missing_enabled = valid.clone();
    missing_enabled
        .as_object_mut()
        .unwrap()
        .remove("advancedRoutingEnabled");
    cases.push(("missing advanced routing flag", missing_enabled));

    let mut missing_routes = valid.clone();
    missing_routes.as_object_mut().unwrap().remove("routes");
    cases.push(("missing routes", missing_routes));

    let mut missing_parallel = valid.clone();
    missing_parallel
        .as_object_mut()
        .unwrap()
        .remove("maxParallelCoders");
    cases.push(("missing parallel coder ceiling", missing_parallel));

    let mut missing_route_role = valid.clone();
    missing_route_role["routes"][0]
        .as_object_mut()
        .unwrap()
        .remove("role");
    cases.push(("route missing role", missing_route_role));

    let mut missing_route_provider = valid.clone();
    missing_route_provider["routes"][0]
        .as_object_mut()
        .unwrap()
        .remove("providerId");
    cases.push(("route missing provider", missing_route_provider));

    let mut missing_route_model = valid.clone();
    missing_route_model["routes"][0]
        .as_object_mut()
        .unwrap()
        .remove("modelId");
    cases.push(("route missing model", missing_route_model));

    let mut duplicate_role = valid.clone();
    duplicate_role["routes"][3]["role"] = serde_json::json!("coder");
    cases.push(("duplicate role", duplicate_role));

    let mut unknown_role = valid.clone();
    unknown_role["routes"][0]["role"] = serde_json::json!("architect");
    cases.push(("unknown role", unknown_role));

    let mut unknown_config_field = valid.clone();
    unknown_config_field["legacyFallbackProvider"] = serde_json::json!("ollama_cloud");
    cases.push(("unknown config field", unknown_config_field));

    let mut unknown_route_field = valid.clone();
    unknown_route_field["routes"][0]["fallbackModelId"] = serde_json::json!("glm-5.2");
    cases.push(("unknown route field", unknown_route_field));

    let mut blank_provider = valid.clone();
    blank_provider["routes"][0]["providerId"] = serde_json::json!("  ");
    cases.push(("blank provider", blank_provider));

    let mut blank_model = valid.clone();
    blank_model["routes"][0]["modelId"] = serde_json::json!("\t");
    cases.push(("blank model", blank_model));

    let mut unsupported_version = valid.clone();
    unsupported_version["version"] = serde_json::json!(3);
    cases.push(("unsupported version", unsupported_version));

    let mut missing_version = valid.clone();
    missing_version.as_object_mut().unwrap().remove("version");
    cases.push(("missing version", missing_version));

    let mut zero_parallel = valid.clone();
    zero_parallel["maxParallelCoders"] = serde_json::json!(0);
    cases.push(("zero parallel coders", zero_parallel));

    let mut excessive_parallel = valid;
    excessive_parallel["maxParallelCoders"] = serde_json::json!(5);
    cases.push(("excessive parallel coders", excessive_parallel));

    for (name, payload) in cases {
        assert!(
            serde_json::from_value::<CodeProModelRoutingConfig>(payload).is_err(),
            "strict routing shape accepted {name}"
        );
    }
}

#[test]
fn disabled_routing_remembers_preferences_but_still_validates_their_structure() {
    let mut remembered = enabled_routing();
    remembered.advanced_routing_enabled = false;
    for routes in [
        remembered.routes.clone(),
        remembered.routes[..1].to_vec(),
        vec![],
    ] {
        remembered.routes = routes;
        let payload = serde_json::to_value(&remembered).unwrap();
        assert_eq!(
            serde_json::from_value::<CodeProModelRoutingConfig>(payload).unwrap(),
            remembered
        );
    }
    let mut invalid = serde_json::to_value(enabled_routing()).unwrap();
    invalid["advancedRoutingEnabled"] = serde_json::json!(false);
    invalid["routes"][3]["role"] = serde_json::json!("coder");
    assert!(serde_json::from_value::<CodeProModelRoutingConfig>(invalid).is_err());
    let mut invalid = serde_json::to_value(enabled_routing()).unwrap();
    invalid["advancedRoutingEnabled"] = serde_json::json!(false);
    invalid["routes"][0]["modelId"] = serde_json::json!(" ");
    assert!(serde_json::from_value::<CodeProModelRoutingConfig>(invalid).is_err());
}

#[test]
fn main_route_is_optional_for_legacy_configs_and_round_trips_when_selected() {
    let legacy = enabled_routing();
    assert_eq!(
        serde_json::from_value::<CodeProModelRoutingConfig>(serde_json::to_value(&legacy).unwrap())
            .unwrap(),
        legacy
    );
    let mut current = legacy;
    current.routes.push(CodeProModelRoute {
        role: CodeProModelRoutingRole::Main,
        provider_id: "main-provider".into(),
        model_id: "main-model".into(),
    });
    assert_eq!(
        serde_json::from_value::<CodeProModelRoutingConfig>(
            serde_json::to_value(&current).unwrap()
        )
        .unwrap(),
        current
    );
    current.routes.push(current.routes.last().unwrap().clone());
    assert!(serde_json::from_value::<CodeProModelRoutingConfig>(
        serde_json::to_value(current).unwrap()
    )
    .is_err());
}

#[test]
fn version_one_routing_migrates_without_enabling_unconfigured_vision() {
    let legacy = serde_json::json!({
        "version": 1,
        "advancedRoutingEnabled": false,
        "routes": [],
        "maxParallelCoders": 1
    });
    let migrated: CodeProModelRoutingConfig = serde_json::from_value(legacy).unwrap();
    assert_eq!(migrated.version, 2);
    assert!(!migrated.vision_route.enabled);
    assert_eq!(
        migrated.vision_route.mode,
        CodeProVisionRoutingMode::Disabled
    );
    assert!(migrated.vision_route.provider_id.is_none());
    assert!(migrated.vision_route.model_id.is_none());
    assert_eq!(serde_json::to_value(migrated).unwrap()["version"], 2);
}

#[test]
fn implicit_legacy_vision_is_disabled_without_losing_agent_routes() {
    let mut original = CodeProModelRoutingConfig::default();
    original.routes.push(CodeProModelRoute {
        role: CodeProModelRoutingRole::Main,
        provider_id: "saved-provider".into(),
        model_id: "saved-model".into(),
    });
    let mut payload = serde_json::to_value(&original).unwrap();
    payload["visionRoute"] = serde_json::json!({"enabled":true,"mode":"auto"});
    let migrated: CodeProModelRoutingConfig = serde_json::from_value(payload.clone()).unwrap();
    assert_eq!(migrated.routes, original.routes);
    assert!(!migrated.vision_route.enabled);
    payload["visionRoute"] = serde_json::json!({"enabled":true,"mode":"auto","providerId":"chosen-provider","modelId":"chosen-model"});
    let configured: CodeProModelRoutingConfig = serde_json::from_value(payload).unwrap();
    assert!(configured.vision_route.enabled);
    assert_eq!(
        configured.vision_route.provider_id.as_deref(),
        Some("chosen-provider")
    );
    assert_eq!(
        configured.vision_route.model_id.as_deref(),
        Some("chosen-model")
    );
}

#[test]
fn defaults_save_requires_an_explicit_non_optional_model_field() {
    let request = DefaultsSaveRequest {
        provider_id: " openai ".to_string(),
        model_id: " gpt-5 ".to_string(),
    };
    let payload = serde_json::to_value(request).unwrap();
    assert_eq!(payload["providerId"], " openai ");
    assert_eq!(payload["modelId"], " gpt-5 ");
}

#[test]
fn model_capability_override_contract_is_strict_and_versioned() {
    let config = ModelCapabilityOverridesConfig {
        version: 1,
        overrides: vec![ModelCapabilityOverride {
            provider_id: "custom_1".to_string(),
            model_id: "kimi-k3".to_string(),
            image_input: ImageInputOverride::ForceSupported,
        }],
    };
    assert_eq!(
        MODEL_CAPABILITY_OVERRIDES_CONFIG_KEY,
        "GOOSE_MODEL_CAPABILITY_OVERRIDES"
    );
    assert_eq!(
        ModelCapabilityOverridesReadRequest::default().method(),
        "_goose/unstable/model-capabilities/read"
    );
    assert_eq!(
        ModelCapabilityOverridesSaveRequest {
            config: config.clone(),
        }
        .method(),
        "_goose/unstable/model-capabilities/save"
    );
    assert_eq!(
        ModelCapabilityResolveRequest {
            provider_id: "custom_1".to_string(),
            model_id: "kimi-k3".to_string(),
        }
        .method(),
        "_goose/unstable/model-capabilities/resolve"
    );
    let payload = serde_json::to_value(&config).unwrap();
    assert_eq!(payload["overrides"][0]["imageInput"], "force_supported");

    let mut duplicate = payload.clone();
    duplicate["overrides"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({
            "providerId": "CUSTOM_1",
            "modelId": "KIMI-K3",
            "imageInput": "force_unsupported"
        }));
    assert!(serde_json::from_value::<ModelCapabilityOverridesConfig>(duplicate).is_err());

    let mut unknown_field = payload;
    unknown_field["legacyImageSupport"] = serde_json::json!(true);
    assert!(serde_json::from_value::<ModelCapabilityOverridesConfig>(unknown_field).is_err());
}
