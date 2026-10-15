use super::*;
use goose_acp_macros::custom_methods;

#[custom_methods]
impl GooseAcpAgent {
    pub async fn dispatch_custom_request(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, agent_client_protocol::Error> {
        let result = async {
            let _session_permit = if let Some(session_id) =
                custom_request_session_id(method, &params)
                    .filter(|_| !custom_request_has_handler_access_guard(method))
            {
                let permit = self
                    .acquire_session_dispatch_access(session_id, false)
                    .await?;
                #[cfg(windows)]
                if matches!(
                    method,
                    workspace_lease::LIST_CLEANUP_RECOVERY_METHOD
                        | workspace_lease::RETRY_CLEANUP_RECOVERY_METHOD
                ) {
                    let session = self
                        .session_manager
                        .get_session(session_id, false)
                        .await
                        .map_err(|_| {
                            agent_client_protocol::Error::resource_not_found(Some(
                                session_id.to_string(),
                            ))
                        })?;
                    if session.session_type != crate::session::SessionType::CodePro {
                        return Err(agent_client_protocol::Error::invalid_params()
                            .data("cleanup recovery requires an active CodePro session"));
                    }
                }
                Some(permit)
            } else {
                None
            };
            #[cfg(all(test, windows))]
            workspace_lease_dispatch_tests::hold_custom_dispatch_after_permit_for_test(
                method,
                custom_request_session_id(method, &params),
            )
            .await;
            if <SaveRecipeRequest as agent_client_protocol::JsonRpcMessage>::matches_method(method)
            {
                let req = recipe::deserialize_save_recipe_request(params)?;
                let result = self.on_save_recipe(req).await?;
                return serde_json::to_value(&result).map_err(|e| {
                    agent_client_protocol::Error::internal_error().data(e.to_string())
                });
            }

            #[cfg(any(windows, target_os = "macos"))]
            if method == workspace_confirmation::REFRESH_METHOD {
                return self.refresh_workspace_confirmation(params).await;
            }
            #[cfg(target_os = "macos")]
            if method == workspace_lease::ALLOCATE_PROJECT_CHILD_METHOD {
                return self.allocate_project_container_child(params).await;
            }
            #[cfg(any(windows, target_os = "macos"))]
            if let Some(result) = dispatch_workspace_lease_request(method, params.clone()) {
                return result;
            }

            self.handle_custom_request(method, params).await
        }
        .await;

        if let Err(error) = &result {
            tracing::error!(method, error = ?error, "ACP custom request failed");
        }

        result
    }

    #[custom_method(AddSessionExtensionRequest)]
    async fn dispatch_add_session_extension(
        &self,
        req: AddSessionExtensionRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.on_add_session_extension(req).await
    }

    #[custom_method(RemoveSessionExtensionRequest)]
    async fn dispatch_remove_session_extension(
        &self,
        req: RemoveSessionExtensionRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.on_remove_session_extension(req).await
    }

    #[custom_method(GetToolsRequest)]
    async fn dispatch_get_tools(
        &self,
        req: GetToolsRequest,
    ) -> Result<GetToolsResponse, agent_client_protocol::Error> {
        self.on_get_tools(req).await
    }

    #[custom_method(CodeProRunGetRequest)]
    async fn dispatch_codepro_run_get(
        &self,
        req: CodeProRunGetRequest,
    ) -> Result<CodeProRunSnapshotResponse, agent_client_protocol::Error> {
        self.on_codepro_run_get(req).await
    }

    #[custom_method(CodeProRunControlRequest)]
    async fn dispatch_codepro_run_control(
        &self,
        req: CodeProRunControlRequest,
    ) -> Result<CodeProRunControlResponse, agent_client_protocol::Error> {
        self.on_codepro_run_control(req).await
    }

    #[custom_method(CodeProEffectResolveRequest)]
    async fn dispatch_codepro_effect_resolve(
        &self,
        req: CodeProEffectResolveRequest,
    ) -> Result<CodeProRunSnapshotResponse, agent_client_protocol::Error> {
        self.on_codepro_effect_resolve(req).await
    }

    #[custom_method(CodeProReviewSnapshotRequest)]
    async fn dispatch_codepro_review_snapshot(
        &self,
        req: CodeProReviewSnapshotRequest,
    ) -> Result<CodeProReviewSnapshotResponse, agent_client_protocol::Error> {
        self.on_codepro_review_snapshot(req).await
    }

    #[custom_method(CodeProReviewStartRequest)]
    async fn dispatch_codepro_review_start(
        &self,
        req: CodeProReviewStartRequest,
    ) -> Result<CodeProReviewResultResponse, agent_client_protocol::Error> {
        self.on_codepro_review_start(req).await
    }

    #[custom_method(CodeProReviewGetRequest)]
    async fn dispatch_codepro_review_get(
        &self,
        req: CodeProReviewGetRequest,
    ) -> Result<CodeProReviewResultResponse, agent_client_protocol::Error> {
        self.on_codepro_review_get(req).await
    }

    #[custom_method(CodeProReviewCancelRequest)]
    async fn dispatch_codepro_review_cancel(
        &self,
        req: CodeProReviewCancelRequest,
    ) -> Result<CodeProReviewResultResponse, agent_client_protocol::Error> {
        self.on_codepro_review_cancel(req).await
    }

    #[custom_method(CodeProMemoryListRequest)]
    async fn dispatch_codepro_memory_list(
        &self,
        req: CodeProMemoryListRequest,
    ) -> Result<CodeProMemoryListResponse, agent_client_protocol::Error> {
        self.on_codepro_memory_list(req).await
    }

    #[custom_method(CodeProMemoryUpdateRequest)]
    async fn dispatch_codepro_memory_update(
        &self,
        req: CodeProMemoryUpdateRequest,
    ) -> Result<CodeProMemoryRecordResponse, agent_client_protocol::Error> {
        self.on_codepro_memory_update(req).await
    }

    #[custom_method(CodeProMemoryDeleteRequest)]
    async fn dispatch_codepro_memory_delete(
        &self,
        req: CodeProMemoryDeleteRequest,
    ) -> Result<CodeProMemoryDeleteResponse, agent_client_protocol::Error> {
        self.on_codepro_memory_delete(req).await
    }

    #[custom_method(CodeProMemoryExportRequest)]
    async fn dispatch_codepro_memory_export(
        &self,
        req: CodeProMemoryExportRequest,
    ) -> Result<CodeProMemoryExportResponse, agent_client_protocol::Error> {
        self.on_codepro_memory_export(req).await
    }

    #[custom_method(CodeProMemoryGetRequest)]
    async fn dispatch_codepro_memory_get(
        &self,
        req: CodeProMemoryGetRequest,
    ) -> Result<CodeProMemoryGetResponse, agent_client_protocol::Error> {
        self.on_codepro_memory_get(req).await
    }

    #[custom_method(CodeProMemoryStatusRequest)]
    async fn dispatch_codepro_memory_status(
        &self,
        req: CodeProMemoryStatusRequest,
    ) -> Result<CodeProMemoryStatusResponse, agent_client_protocol::Error> {
        self.on_codepro_memory_status(req).await
    }

    #[custom_method(SetToolPermissionsRequest)]
    async fn dispatch_set_tool_permissions(
        &self,
        req: SetToolPermissionsRequest,
    ) -> Result<SetToolPermissionsResponse, agent_client_protocol::Error> {
        self.on_set_tool_permissions(req).await
    }

    #[custom_method(GrantCodeProRestrictedReadonlyRequest)]
    async fn dispatch_grant_codepro_restricted_readonly(
        &self,
        req: GrantCodeProRestrictedReadonlyRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.on_grant_codepro_restricted_readonly(req).await
    }

    #[custom_method(GooseToolCallRequest)]
    async fn dispatch_call_tool(
        &self,
        req: GooseToolCallRequest,
    ) -> Result<GooseToolCallResponse, agent_client_protocol::Error> {
        self.on_call_tool(req).await
    }

    #[custom_method(ReadResourceRequest)]
    async fn dispatch_read_resource(
        &self,
        req: ReadResourceRequest,
    ) -> Result<ReadResourceResponse, agent_client_protocol::Error> {
        self.on_read_resource(req).await
    }

    #[custom_method(AppsListRequest)]
    async fn dispatch_list_apps(
        &self,
        req: AppsListRequest,
    ) -> Result<AppsListResponse, agent_client_protocol::Error> {
        self.on_list_apps(req).await
    }

    #[custom_method(CapabilityUsageListRequest)]
    async fn dispatch_list_capability_usage(
        &self,
        req: CapabilityUsageListRequest,
    ) -> Result<CapabilityUsageListResponse, agent_client_protocol::Error> {
        self.on_list_capability_usage(req).await
    }

    #[custom_method(SkillManagementListRequest)]
    async fn dispatch_list_managed_skills(
        &self,
        req: SkillManagementListRequest,
    ) -> Result<SkillManagementListResponse, agent_client_protocol::Error> {
        self.on_list_managed_skills(req).await
    }

    #[custom_method(SkillManagementReadRequest)]
    async fn dispatch_read_managed_skill(
        &self,
        req: SkillManagementReadRequest,
    ) -> Result<SkillManagementReadResponse, agent_client_protocol::Error> {
        self.on_read_managed_skill(req).await
    }

    #[custom_method(SkillManagementPreviewRequest)]
    async fn dispatch_preview_skill_change(
        &self,
        req: SkillManagementPreviewRequest,
    ) -> Result<SkillManagementPreviewResponse, agent_client_protocol::Error> {
        self.on_preview_skill_change(req).await
    }

    #[custom_method(SkillManagementDownloadPreviewRequest)]
    async fn dispatch_preview_skill_download(
        &self,
        req: SkillManagementDownloadPreviewRequest,
    ) -> Result<SkillManagementPreviewResponse, agent_client_protocol::Error> {
        self.on_preview_skill_download(req).await
    }

    #[custom_method(SkillManagementApplyRequest)]
    async fn dispatch_apply_skill_change(
        &self,
        req: SkillManagementApplyRequest,
    ) -> Result<SkillManagementApplyResponse, agent_client_protocol::Error> {
        self.on_apply_skill_change(req).await
    }

    #[custom_method(SkillManagementRecoveryListRequest)]
    async fn dispatch_list_skill_recoveries(
        &self,
        req: SkillManagementRecoveryListRequest,
    ) -> Result<SkillManagementRecoveryListResponse, agent_client_protocol::Error> {
        self.on_list_skill_recoveries(req).await
    }

    #[custom_method(CapabilityUsageRecordRequest)]
    async fn dispatch_record_capability_usage(
        &self,
        req: CapabilityUsageRecordRequest,
    ) -> Result<CapabilityUsageRecordResponse, agent_client_protocol::Error> {
        self.on_record_capability_usage(req).await
    }

    #[custom_method(AppsExportRequest)]
    async fn dispatch_export_app(
        &self,
        req: AppsExportRequest,
    ) -> Result<AppsExportResponse, agent_client_protocol::Error> {
        self.on_export_app(req).await
    }

    #[custom_method(AppsImportRequest)]
    async fn dispatch_import_app(
        &self,
        req: AppsImportRequest,
    ) -> Result<AppsImportResponse, agent_client_protocol::Error> {
        self.on_import_app(req).await
    }

    #[custom_method(AppsDeleteRequest)]
    async fn dispatch_delete_app(
        &self,
        req: AppsDeleteRequest,
    ) -> Result<AppsDeleteResponse, agent_client_protocol::Error> {
        self.on_delete_app(req).await
    }

    #[custom_method(UpdateWorkingDirRequest)]
    async fn dispatch_update_working_dir(
        &self,
        req: UpdateWorkingDirRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.on_update_working_dir(req).await
    }

    #[custom_method(SetSessionSystemPromptRequest)]
    async fn dispatch_set_session_system_prompt(
        &self,
        req: SetSessionSystemPromptRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.on_set_session_system_prompt(req).await
    }

    #[custom_method(SteerSessionRequest)]
    async fn dispatch_steer_session(
        &self,
        req: SteerSessionRequest,
    ) -> Result<SteerSessionResponse, agent_client_protocol::Error> {
        self.on_steer_session(req).await
    }

    #[custom_method(DiagnosticsGetRequest)]
    async fn dispatch_get_diagnostics(
        &self,
        req: DiagnosticsGetRequest,
    ) -> Result<DiagnosticsGetResponse, agent_client_protocol::Error> {
        self.on_get_diagnostics(req).await
    }

    #[custom_method(ListPromptsRequest)]
    async fn dispatch_list_prompts(
        &self,
        req: ListPromptsRequest,
    ) -> Result<ListPromptsResponse, agent_client_protocol::Error> {
        self.on_list_prompts(req).await
    }

    #[custom_method(GetPromptRequest)]
    async fn dispatch_get_prompt(
        &self,
        req: GetPromptRequest,
    ) -> Result<GetPromptResponse, agent_client_protocol::Error> {
        self.on_get_prompt(req).await
    }

    #[custom_method(SavePromptRequest)]
    async fn dispatch_save_prompt(
        &self,
        req: SavePromptRequest,
    ) -> Result<PromptOperationResponse, agent_client_protocol::Error> {
        self.on_save_prompt(req).await
    }

    #[custom_method(ResetPromptRequest)]
    async fn dispatch_reset_prompt(
        &self,
        req: ResetPromptRequest,
    ) -> Result<PromptOperationResponse, agent_client_protocol::Error> {
        self.on_reset_prompt(req).await
    }

    #[custom_method(DeleteSessionRequest)]
    async fn dispatch_delete_session(
        &self,
        req: DeleteSessionRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.on_delete_session(req).await
    }

    #[custom_method(GetConfigExtensionsRequest)]
    async fn dispatch_get_config_extensions(
        &self,
    ) -> Result<GetConfigExtensionsResponse, agent_client_protocol::Error> {
        self.on_get_config_extensions().await
    }

    #[custom_method(GetAvailableExtensionsRequest)]
    async fn dispatch_get_available_extensions(
        &self,
    ) -> Result<GetAvailableExtensionsResponse, agent_client_protocol::Error> {
        self.on_get_available_extensions().await
    }

    #[custom_method(AddConfigExtensionRequest)]
    async fn dispatch_add_config_extension(
        &self,
        req: AddConfigExtensionRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.on_add_config_extension(req).await
    }

    #[custom_method(UpdateConfigExtensionRequest)]
    async fn dispatch_update_config_extension(
        &self,
        req: UpdateConfigExtensionRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.on_update_config_extension(req).await
    }

    #[custom_method(TestConfigExtensionRequest)]
    async fn dispatch_test_config_extension(
        &self,
        req: TestConfigExtensionRequest,
    ) -> Result<TestConfigExtensionResponse, agent_client_protocol::Error> {
        self.on_test_config_extension(req).await
    }

    #[custom_method(RemoveConfigExtensionRequest)]
    async fn dispatch_remove_config_extension(
        &self,
        req: RemoveConfigExtensionRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.on_remove_config_extension(req).await
    }

    #[custom_method(SetConfigExtensionEnabledRequest)]
    async fn dispatch_set_config_extension_enabled(
        &self,
        req: SetConfigExtensionEnabledRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.on_set_config_extension_enabled(req).await
    }

    #[custom_method(GetSessionExtensionsRequest)]
    async fn dispatch_get_session_extensions(
        &self,
        req: GetSessionExtensionsRequest,
    ) -> Result<GetSessionExtensionsResponse, agent_client_protocol::Error> {
        self.on_get_session_extensions(req).await
    }

    #[custom_method(ListProvidersRequest)]
    async fn dispatch_list_providers(
        &self,
        req: ListProvidersRequest,
    ) -> Result<ListProvidersResponse, agent_client_protocol::Error> {
        self.on_list_providers(req).await
    }

    #[custom_method(ProviderSupportedModelsListRequest)]
    async fn dispatch_list_provider_supported_models(
        &self,
        req: ProviderSupportedModelsListRequest,
    ) -> Result<ProviderSupportedModelsListResponse, agent_client_protocol::Error> {
        self.on_list_provider_supported_models(req).await
    }

    #[custom_method(ProviderCatalogListRequest)]
    async fn dispatch_list_provider_catalog(
        &self,
        req: ProviderCatalogListRequest,
    ) -> Result<ProviderCatalogListResponse, agent_client_protocol::Error> {
        self.on_list_provider_catalog(req).await
    }

    #[custom_method(ProviderSetupCatalogListRequest)]
    async fn dispatch_list_provider_setup_catalog(
        &self,
        req: ProviderSetupCatalogListRequest,
    ) -> Result<ProviderSetupCatalogListResponse, agent_client_protocol::Error> {
        self.on_list_provider_setup_catalog(req).await
    }

    #[custom_method(ProviderCatalogTemplateRequest)]
    async fn dispatch_get_provider_catalog_template(
        &self,
        req: ProviderCatalogTemplateRequest,
    ) -> Result<ProviderCatalogTemplateResponse, agent_client_protocol::Error> {
        self.on_get_provider_catalog_template(req).await
    }

    #[custom_method(CustomProviderCreateRequest)]
    async fn dispatch_create_custom_provider(
        &self,
        req: CustomProviderCreateRequest,
    ) -> Result<CustomProviderCreateResponse, agent_client_protocol::Error> {
        self.on_create_custom_provider(req).await
    }

    #[custom_method(CustomProviderDiscoverModelsRequest)]
    async fn dispatch_discover_custom_provider_models(
        &self,
        req: CustomProviderDiscoverModelsRequest,
    ) -> Result<CustomProviderDiscoverModelsResponse, agent_client_protocol::Error> {
        self.on_discover_custom_provider_models(req).await
    }

    #[custom_method(CustomProviderReadRequest)]
    async fn dispatch_read_custom_provider(
        &self,
        req: CustomProviderReadRequest,
    ) -> Result<CustomProviderReadResponse, agent_client_protocol::Error> {
        self.on_read_custom_provider(req).await
    }

    #[custom_method(CustomProviderUpdateRequest)]
    async fn dispatch_update_custom_provider(
        &self,
        req: CustomProviderUpdateRequest,
    ) -> Result<CustomProviderUpdateResponse, agent_client_protocol::Error> {
        self.on_update_custom_provider(req).await
    }

    #[custom_method(CustomProviderDeleteRequest)]
    async fn dispatch_delete_custom_provider(
        &self,
        req: CustomProviderDeleteRequest,
    ) -> Result<CustomProviderDeleteResponse, agent_client_protocol::Error> {
        self.on_delete_custom_provider(req).await
    }

    #[custom_method(RefreshProviderInventoryRequest)]
    async fn dispatch_refresh_provider_inventory(
        &self,
        req: RefreshProviderInventoryRequest,
    ) -> Result<RefreshProviderInventoryResponse, agent_client_protocol::Error> {
        self.on_refresh_provider_inventory(req).await
    }

    #[custom_method(ProviderConfigReadRequest)]
    async fn dispatch_read_provider_config(
        &self,
        req: ProviderConfigReadRequest,
    ) -> Result<ProviderConfigReadResponse, agent_client_protocol::Error> {
        self.on_read_provider_config(req).await
    }

    #[custom_method(ProviderConfigStatusRequest)]
    async fn dispatch_provider_config_status(
        &self,
        req: ProviderConfigStatusRequest,
    ) -> Result<ProviderConfigStatusResponse, agent_client_protocol::Error> {
        self.on_provider_config_status(req).await
    }

    #[custom_method(ProviderConfigSaveRequest)]
    async fn dispatch_save_provider_config(
        &self,
        req: ProviderConfigSaveRequest,
    ) -> Result<ProviderConfigChangeResponse, agent_client_protocol::Error> {
        self.on_save_provider_config(req).await
    }

    #[custom_method(ProviderConfigDeleteRequest)]
    async fn dispatch_delete_provider_config(
        &self,
        req: ProviderConfigDeleteRequest,
    ) -> Result<ProviderConfigChangeResponse, agent_client_protocol::Error> {
        self.on_delete_provider_config(req).await
    }

    #[custom_method(ProviderConfigAuthenticateRequest)]
    async fn dispatch_authenticate_provider_config(
        &self,
        req: ProviderConfigAuthenticateRequest,
    ) -> Result<ProviderConfigChangeResponse, agent_client_protocol::Error> {
        self.on_authenticate_provider_config(req).await
    }

    #[custom_method(ProviderSecretsListRequest)]
    async fn dispatch_list_provider_secrets(
        &self,
        req: ProviderSecretsListRequest,
    ) -> Result<ProviderSecretsListResponse, agent_client_protocol::Error> {
        self.on_list_provider_secrets(req).await
    }

    #[custom_method(ProviderSecretDeleteRequest)]
    async fn dispatch_delete_provider_secret(
        &self,
        req: ProviderSecretDeleteRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.on_delete_provider_secret(req).await
    }

    #[custom_method(CanonicalModelInfoRequest)]
    async fn dispatch_canonical_model_info(
        &self,
        req: CanonicalModelInfoRequest,
    ) -> Result<CanonicalModelInfoResponse, agent_client_protocol::Error> {
        self.on_canonical_model_info(req).await
    }

    #[custom_method(PreferencesReadRequest)]
    async fn dispatch_preferences_read(
        &self,
        req: PreferencesReadRequest,
    ) -> Result<PreferencesReadResponse, agent_client_protocol::Error> {
        self.on_preferences_read(req).await
    }

    #[custom_method(PreferencesSaveRequest)]
    async fn dispatch_preferences_save(
        &self,
        req: PreferencesSaveRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.on_preferences_save(req).await
    }

    #[custom_method(PreferencesRemoveRequest)]
    async fn dispatch_preferences_remove(
        &self,
        req: PreferencesRemoveRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.on_preferences_remove(req).await
    }

    #[custom_method(ConfigReadRequest)]
    async fn dispatch_config_read(
        &self,
        req: ConfigReadRequest,
    ) -> Result<ConfigReadResponse, agent_client_protocol::Error> {
        self.on_config_read(req).await
    }

    #[custom_method(ConfigUpsertRequest)]
    async fn dispatch_config_upsert(
        &self,
        req: ConfigUpsertRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.on_config_upsert(req).await
    }

    #[custom_method(ConfigRemoveRequest)]
    async fn dispatch_config_remove(
        &self,
        req: ConfigRemoveRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.on_config_remove(req).await
    }

    #[custom_method(ConfigReadAllRequest)]
    async fn dispatch_config_read_all(
        &self,
        req: ConfigReadAllRequest,
    ) -> Result<ConfigReadAllResponse, agent_client_protocol::Error> {
        self.on_config_read_all(req).await
    }

    #[custom_method(CodeProModelRoutingReadRequest)]
    async fn dispatch_codepro_model_routing_read(
        &self,
        req: CodeProModelRoutingReadRequest,
    ) -> Result<CodeProModelRoutingReadResponse, agent_client_protocol::Error> {
        self.on_codepro_model_routing_read(req).await
    }

    #[custom_method(CodeProModelRoutingSaveRequest)]
    async fn dispatch_codepro_model_routing_save(
        &self,
        req: CodeProModelRoutingSaveRequest,
    ) -> Result<CodeProModelRoutingConfig, agent_client_protocol::Error> {
        self.on_codepro_model_routing_save(req).await
    }

    #[custom_method(ModelCapabilityOverridesReadRequest)]
    async fn dispatch_model_capability_overrides_read(
        &self,
        req: ModelCapabilityOverridesReadRequest,
    ) -> Result<ModelCapabilityOverridesReadResponse, agent_client_protocol::Error> {
        self.on_model_capability_overrides_read(req).await
    }

    #[custom_method(ModelCapabilityOverridesSaveRequest)]
    async fn dispatch_model_capability_overrides_save(
        &self,
        req: ModelCapabilityOverridesSaveRequest,
    ) -> Result<ModelCapabilityOverridesConfig, agent_client_protocol::Error> {
        self.on_model_capability_overrides_save(req).await
    }

    #[custom_method(ModelCapabilityResolveRequest)]
    async fn dispatch_model_capability_resolve(
        &self,
        req: ModelCapabilityResolveRequest,
    ) -> Result<ModelCapabilityResolveResponse, agent_client_protocol::Error> {
        self.on_model_capability_resolve(req).await
    }

    #[custom_method(DefaultsReadRequest)]
    async fn dispatch_defaults_read(
        &self,
        req: DefaultsReadRequest,
    ) -> Result<DefaultsReadResponse, agent_client_protocol::Error> {
        self.on_defaults_read(req).await
    }

    #[custom_method(DefaultsSaveRequest)]
    async fn dispatch_defaults_save(
        &self,
        req: DefaultsSaveRequest,
    ) -> Result<DefaultsReadResponse, agent_client_protocol::Error> {
        self.on_defaults_save(req).await
    }

    #[custom_method(DefaultsClearRequest)]
    async fn dispatch_defaults_clear(
        &self,
        req: DefaultsClearRequest,
    ) -> Result<DefaultsReadResponse, agent_client_protocol::Error> {
        self.on_defaults_clear(req).await
    }

    #[custom_method(OnboardingImportScanRequest)]
    async fn dispatch_onboarding_import_scan(
        &self,
        req: OnboardingImportScanRequest,
    ) -> Result<OnboardingImportScanResponse, agent_client_protocol::Error> {
        self.on_onboarding_import_scan(req).await
    }

    #[custom_method(OnboardingImportApplyRequest)]
    async fn dispatch_onboarding_import_apply(
        &self,
        req: OnboardingImportApplyRequest,
    ) -> Result<OnboardingImportApplyResponse, agent_client_protocol::Error> {
        self.on_onboarding_import_apply(req).await
    }

    #[custom_method(ExportSessionRequest)]
    async fn dispatch_export_session(
        &self,
        req: ExportSessionRequest,
    ) -> Result<ExportSessionResponse, agent_client_protocol::Error> {
        self.on_export_session(req).await
    }

    #[custom_method(ImportSessionRequest)]
    async fn dispatch_import_session(
        &self,
        req: ImportSessionRequest,
    ) -> Result<ImportSessionResponse, agent_client_protocol::Error> {
        self.on_import_session(req).await
    }

    #[custom_method(ShareSessionNostrRequest)]
    async fn dispatch_share_session_nostr(
        &self,
        req: ShareSessionNostrRequest,
    ) -> Result<ShareSessionNostrResponse, agent_client_protocol::Error> {
        self.on_share_session_nostr(req).await
    }

    #[custom_method(EncodeRecipeRequest)]
    async fn dispatch_encode_recipe(
        &self,
        req: EncodeRecipeRequest,
    ) -> Result<EncodeRecipeResponse, agent_client_protocol::Error> {
        self.on_encode_recipe(req).await
    }

    #[custom_method(DecodeRecipeRequest)]
    async fn dispatch_decode_recipe(
        &self,
        req: DecodeRecipeRequest,
    ) -> Result<DecodeRecipeResponse, agent_client_protocol::Error> {
        self.on_decode_recipe(req).await
    }

    #[custom_method(ScanRecipeRequest)]
    async fn dispatch_scan_recipe(
        &self,
        req: ScanRecipeRequest,
    ) -> Result<ScanRecipeResponse, agent_client_protocol::Error> {
        self.on_scan_recipe(req).await
    }

    #[custom_method(ListRecipesRequest)]
    async fn dispatch_list_recipes(
        &self,
        req: ListRecipesRequest,
    ) -> Result<ListRecipesResponse, agent_client_protocol::Error> {
        self.on_list_recipes(req).await
    }

    #[custom_method(DeleteRecipeRequest)]
    async fn dispatch_delete_recipe(
        &self,
        req: DeleteRecipeRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.on_delete_recipe(req).await
    }

    #[custom_method(ScheduleRecipeRequest)]
    async fn dispatch_schedule_recipe(
        &self,
        req: ScheduleRecipeRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.on_schedule_recipe(req).await
    }

    #[custom_method(SetRecipeSlashCommandRequest)]
    async fn dispatch_set_recipe_slash_command(
        &self,
        req: SetRecipeSlashCommandRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.on_set_recipe_slash_command(req).await
    }

    #[custom_method(SaveRecipeRequest)]
    async fn dispatch_save_recipe(
        &self,
        req: SaveRecipeRequest,
    ) -> Result<SaveRecipeResponse, agent_client_protocol::Error> {
        self.on_save_recipe(req).await
    }

    #[custom_method(ParseRecipeRequest)]
    async fn dispatch_parse_recipe(
        &self,
        req: ParseRecipeRequest,
    ) -> Result<ParseRecipeResponse, agent_client_protocol::Error> {
        self.on_parse_recipe(req).await
    }

    #[custom_method(RecipeToYamlRequest)]
    async fn dispatch_recipe_to_yaml(
        &self,
        req: RecipeToYamlRequest,
    ) -> Result<RecipeToYamlResponse, agent_client_protocol::Error> {
        self.on_recipe_to_yaml(req).await
    }

    #[custom_method(ListSchedulesRequest)]
    async fn dispatch_list_schedules(
        &self,
        req: ListSchedulesRequest,
    ) -> Result<ListSchedulesResponse, agent_client_protocol::Error> {
        self.on_list_schedules(req).await
    }

    #[custom_method(ListScheduleSessionsRequest)]
    async fn dispatch_list_schedule_sessions(
        &self,
        req: ListScheduleSessionsRequest,
    ) -> Result<ListScheduleSessionsResponse, agent_client_protocol::Error> {
        self.on_list_schedule_sessions(req).await
    }

    #[custom_method(CreateScheduleRequest)]
    async fn dispatch_create_schedule(
        &self,
        req: CreateScheduleRequest,
    ) -> Result<CreateScheduleResponse, agent_client_protocol::Error> {
        self.on_create_schedule(req).await
    }

    #[custom_method(DeleteScheduleRequest)]
    async fn dispatch_delete_schedule(
        &self,
        req: DeleteScheduleRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.on_delete_schedule(req).await
    }

    #[custom_method(PauseScheduleRequest)]
    async fn dispatch_pause_schedule(
        &self,
        req: PauseScheduleRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.on_pause_schedule(req).await
    }

    #[custom_method(UnpauseScheduleRequest)]
    async fn dispatch_unpause_schedule(
        &self,
        req: UnpauseScheduleRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.on_unpause_schedule(req).await
    }

    #[custom_method(UpdateScheduleRequest)]
    async fn dispatch_update_schedule(
        &self,
        req: UpdateScheduleRequest,
    ) -> Result<UpdateScheduleResponse, agent_client_protocol::Error> {
        self.on_update_schedule(req).await
    }

    #[custom_method(RunScheduleNowRequest)]
    async fn dispatch_run_schedule_now(
        &self,
        req: RunScheduleNowRequest,
    ) -> Result<RunScheduleNowResponse, agent_client_protocol::Error> {
        self.on_run_schedule_now(req).await
    }

    #[custom_method(KillRunningJobRequest)]
    async fn dispatch_kill_running_job(
        &self,
        req: KillRunningJobRequest,
    ) -> Result<KillRunningJobResponse, agent_client_protocol::Error> {
        self.on_kill_running_job(req).await
    }

    #[custom_method(InspectRunningJobRequest)]
    async fn dispatch_inspect_running_job(
        &self,
        req: InspectRunningJobRequest,
    ) -> Result<InspectRunningJobResponse, agent_client_protocol::Error> {
        self.on_inspect_running_job(req).await
    }

    #[custom_method(GetSessionInfoRequest)]
    async fn dispatch_get_session_info(
        &self,
        req: GetSessionInfoRequest,
    ) -> Result<GetSessionInfoResponse, agent_client_protocol::Error> {
        self.on_get_session_info(req).await
    }

    #[custom_method(TruncateSessionConversationRequest)]
    async fn dispatch_truncate_session_conversation(
        &self,
        req: TruncateSessionConversationRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.on_truncate_session_conversation(req).await
    }

    #[custom_method(UpdateSessionProjectRequest)]
    async fn dispatch_update_session_project(
        &self,
        req: UpdateSessionProjectRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.on_update_session_project(req).await
    }

    #[custom_method(RenameSessionRequest)]
    async fn dispatch_rename_session(
        &self,
        req: RenameSessionRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.on_rename_session(req).await
    }

    #[custom_method(ArchiveSessionRequest)]
    async fn dispatch_archive_session(
        &self,
        req: ArchiveSessionRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.on_archive_session(req).await
    }

    #[custom_method(UnarchiveSessionRequest)]
    async fn dispatch_unarchive_session(
        &self,
        req: UnarchiveSessionRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.on_unarchive_session(req).await
    }

    #[custom_method(CreateSourceRequest)]
    async fn dispatch_create_source(
        &self,
        req: CreateSourceRequest,
    ) -> Result<CreateSourceResponse, agent_client_protocol::Error> {
        self.on_create_source(req).await
    }

    #[custom_method(ListSourcesRequest)]
    async fn dispatch_list_sources(
        &self,
        req: ListSourcesRequest,
    ) -> Result<ListSourcesResponse, agent_client_protocol::Error> {
        self.on_list_sources(req).await
    }

    #[custom_method(ListAgentMentionsRequest)]
    async fn dispatch_list_agent_mentions(
        &self,
        req: ListAgentMentionsRequest,
    ) -> Result<ListAgentMentionsResponse, agent_client_protocol::Error> {
        self.on_list_agent_mentions(req).await
    }

    #[custom_method(ListSlashCommandsRequest)]
    async fn dispatch_list_slash_commands(
        &self,
        req: ListSlashCommandsRequest,
    ) -> Result<ListSlashCommandsResponse, agent_client_protocol::Error> {
        self.on_list_slash_commands(req).await
    }

    #[custom_method(UpdateSourceRequest)]
    async fn dispatch_update_source(
        &self,
        req: UpdateSourceRequest,
    ) -> Result<UpdateSourceResponse, agent_client_protocol::Error> {
        self.on_update_source(req).await
    }

    #[custom_method(DeleteSourceRequest)]
    async fn dispatch_delete_source(
        &self,
        req: DeleteSourceRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.on_delete_source(req).await
    }

    #[custom_method(ExportSourceRequest)]
    async fn dispatch_export_source(
        &self,
        req: ExportSourceRequest,
    ) -> Result<ExportSourceResponse, agent_client_protocol::Error> {
        self.on_export_source(req).await
    }

    #[custom_method(ImportSourcesRequest)]
    async fn dispatch_import_sources(
        &self,
        req: ImportSourcesRequest,
    ) -> Result<ImportSourcesResponse, agent_client_protocol::Error> {
        self.on_import_sources(req).await
    }

    #[custom_method(DictationTranscribeRequest)]
    async fn dispatch_dictation_transcribe(
        &self,
        req: DictationTranscribeRequest,
    ) -> Result<DictationTranscribeResponse, agent_client_protocol::Error> {
        self.on_dictation_transcribe(req).await
    }

    #[custom_method(DictationConfigRequest)]
    async fn dispatch_dictation_config(
        &self,
        _req: DictationConfigRequest,
    ) -> Result<DictationConfigResponse, agent_client_protocol::Error> {
        self.on_dictation_config(_req).await
    }

    #[custom_method(DictationSecretSaveRequest)]
    async fn dispatch_dictation_secret_save(
        &self,
        req: DictationSecretSaveRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.on_dictation_secret_save(req).await
    }

    #[custom_method(DictationSecretDeleteRequest)]
    async fn dispatch_dictation_secret_delete(
        &self,
        req: DictationSecretDeleteRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.on_dictation_secret_delete(req).await
    }

    #[custom_method(DictationModelsListRequest)]
    async fn dispatch_dictation_models_list(
        &self,
        _req: DictationModelsListRequest,
    ) -> Result<DictationModelsListResponse, agent_client_protocol::Error> {
        self.on_dictation_models_list(_req).await
    }

    #[custom_method(DictationModelDownloadRequest)]
    async fn dispatch_dictation_model_download(
        &self,
        _req: DictationModelDownloadRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.on_dictation_model_download(_req).await
    }

    #[custom_method(DictationModelDownloadProgressRequest)]
    async fn dispatch_dictation_model_download_progress(
        &self,
        _req: DictationModelDownloadProgressRequest,
    ) -> Result<DictationModelDownloadProgressResponse, agent_client_protocol::Error> {
        self.on_dictation_model_download_progress(_req).await
    }

    #[custom_method(DictationModelCancelRequest)]
    async fn dispatch_dictation_model_cancel(
        &self,
        _req: DictationModelCancelRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.on_dictation_model_cancel(_req).await
    }

    #[custom_method(DictationModelDeleteRequest)]
    async fn dispatch_dictation_model_delete(
        &self,
        _req: DictationModelDeleteRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.on_dictation_model_delete(_req).await
    }

    #[custom_method(DictationModelSelectRequest)]
    async fn dispatch_dictation_model_select(
        &self,
        req: DictationModelSelectRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.on_dictation_model_select(req).await
    }

    #[custom_method(GitHubAuthStatusRequest)]
    async fn dispatch_github_auth_status(
        &self,
        req: GitHubAuthStatusRequest,
    ) -> Result<GitHubAuthStatusResponse, agent_client_protocol::Error> {
        self.on_github_auth_status(req).await
    }

    #[custom_method(GitHubAuthStartRequest)]
    async fn dispatch_github_auth_start(
        &self,
        req: GitHubAuthStartRequest,
    ) -> Result<GitHubAuthStartResponse, agent_client_protocol::Error> {
        self.on_github_auth_start(req).await
    }

    #[custom_method(GitHubAuthPollRequest)]
    async fn dispatch_github_auth_poll(
        &self,
        req: GitHubAuthPollRequest,
    ) -> Result<GitHubAuthPollResponse, agent_client_protocol::Error> {
        self.on_github_auth_poll(req).await
    }

    #[custom_method(GitHubAuthCancelRequest)]
    async fn dispatch_github_auth_cancel(
        &self,
        req: GitHubAuthCancelRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.on_github_auth_cancel(req).await
    }

    #[custom_method(GitHubAuthDisconnectRequest)]
    async fn dispatch_github_auth_disconnect(
        &self,
        req: GitHubAuthDisconnectRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.on_github_auth_disconnect(req).await
    }

    #[custom_method(GitHubPullRequestPreviewRequest)]
    async fn dispatch_github_pull_request_preview(
        &self,
        req: GitHubPullRequestPreviewRequest,
    ) -> Result<GitHubPullRequestPreviewResponse, agent_client_protocol::Error> {
        self.on_github_pull_request_preview(req).await
    }

    #[custom_method(GitHubDeliveryStatusRequest)]
    async fn dispatch_github_delivery_status(
        &self,
        req: GitHubDeliveryStatusRequest,
    ) -> Result<GitHubDeliveryStatusResponse, agent_client_protocol::Error> {
        self.on_github_delivery_status(req).await
    }

    #[custom_method(GitHubPullRequestCreateRequest)]
    async fn dispatch_github_pull_request_create(
        &self,
        req: GitHubPullRequestCreateRequest,
    ) -> Result<GitHubPullRequestCreateResponse, agent_client_protocol::Error> {
        self.on_github_pull_request_create(req).await
    }

    #[custom_method(GitHubPullRequestStatePreviewRequest)]
    async fn dispatch_github_pull_request_state_preview(
        &self,
        req: GitHubPullRequestStatePreviewRequest,
    ) -> Result<GitHubPullRequestStatePreviewResponse, agent_client_protocol::Error> {
        self.on_github_pull_request_state_preview(req).await
    }

    #[custom_method(GitHubPullRequestStateChangeRequest)]
    async fn dispatch_github_pull_request_state_change(
        &self,
        req: GitHubPullRequestStateChangeRequest,
    ) -> Result<GitHubPullRequestStateChangeResponse, agent_client_protocol::Error> {
        self.on_github_pull_request_state_change(req).await
    }

    #[custom_method(GitHubPullRequestContentPreviewRequest)]
    async fn dispatch_github_pull_request_content_preview(
        &self,
        req: GitHubPullRequestContentPreviewRequest,
    ) -> Result<GitHubPullRequestContentPreviewResponse, agent_client_protocol::Error> {
        self.on_github_pull_request_content_preview(req).await
    }

    #[custom_method(GitHubPullRequestContentUpdateRequest)]
    async fn dispatch_github_pull_request_content_update(
        &self,
        req: GitHubPullRequestContentUpdateRequest,
    ) -> Result<GitHubPullRequestContentUpdateResponse, agent_client_protocol::Error> {
        self.on_github_pull_request_content_update(req).await
    }

    #[custom_method(GitHubIssueListRequest)]
    async fn dispatch_github_issue_list(
        &self,
        req: GitHubIssueListRequest,
    ) -> Result<GitHubIssueListResponse, agent_client_protocol::Error> {
        self.on_github_issue_list(req).await
    }

    #[custom_method(GitHubIssueCreatePreviewRequest)]
    async fn dispatch_github_issue_create_preview(
        &self,
        req: GitHubIssueCreatePreviewRequest,
    ) -> Result<GitHubIssueCreatePreviewResponse, agent_client_protocol::Error> {
        self.on_github_issue_create_preview(req).await
    }

    #[custom_method(GitHubIssueCreateRequest)]
    async fn dispatch_github_issue_create(
        &self,
        req: GitHubIssueCreateRequest,
    ) -> Result<GitHubIssueCreateResponse, agent_client_protocol::Error> {
        self.on_github_issue_create(req).await
    }

    #[custom_method(GitHubIssueContentPreviewRequest)]
    async fn dispatch_github_issue_content_preview(
        &self,
        req: GitHubIssueContentPreviewRequest,
    ) -> Result<GitHubIssueContentPreviewResponse, agent_client_protocol::Error> {
        self.on_github_issue_content_preview(req).await
    }

    #[custom_method(GitHubIssueContentUpdateRequest)]
    async fn dispatch_github_issue_content_update(
        &self,
        req: GitHubIssueContentUpdateRequest,
    ) -> Result<GitHubIssueContentUpdateResponse, agent_client_protocol::Error> {
        self.on_github_issue_content_update(req).await
    }

    #[custom_method(GitHubIssueStatePreviewRequest)]
    async fn dispatch_github_issue_state_preview(
        &self,
        req: GitHubIssueStatePreviewRequest,
    ) -> Result<GitHubIssueStatePreviewResponse, agent_client_protocol::Error> {
        self.on_github_issue_state_preview(req).await
    }

    #[custom_method(GitHubIssueStateChangeRequest)]
    async fn dispatch_github_issue_state_change(
        &self,
        req: GitHubIssueStateChangeRequest,
    ) -> Result<GitHubIssueStateChangeResponse, agent_client_protocol::Error> {
        self.on_github_issue_state_change(req).await
    }

    #[custom_method(GitHubCiStatusRequest)]
    async fn dispatch_github_ci_status(
        &self,
        req: GitHubCiStatusRequest,
    ) -> Result<GitHubCiStatusResponse, agent_client_protocol::Error> {
        self.on_github_ci_status(req).await
    }

    #[custom_method(GitHubCiArtifactsRequest)]
    async fn dispatch_github_ci_artifacts(
        &self,
        req: GitHubCiArtifactsRequest,
    ) -> Result<GitHubCiArtifactsResponse, agent_client_protocol::Error> {
        self.on_github_ci_artifacts(req).await
    }

    #[custom_method(GitHubCiRerunPreviewRequest)]
    async fn dispatch_github_ci_rerun_preview(
        &self,
        req: GitHubCiRerunPreviewRequest,
    ) -> Result<GitHubCiRerunPreviewResponse, agent_client_protocol::Error> {
        self.on_github_ci_rerun_preview(req).await
    }

    #[custom_method(GitHubCiRerunRequest)]
    async fn dispatch_github_ci_rerun(
        &self,
        req: GitHubCiRerunRequest,
    ) -> Result<GitHubCiRerunResponse, agent_client_protocol::Error> {
        self.on_github_ci_rerun(req).await
    }

    #[custom_method(GitHubCiCancelPreviewRequest)]
    async fn dispatch_github_ci_cancel_preview(
        &self,
        req: GitHubCiCancelPreviewRequest,
    ) -> Result<GitHubCiCancelPreviewResponse, agent_client_protocol::Error> {
        self.on_github_ci_cancel_preview(req).await
    }

    #[custom_method(GitHubCiCancelRequest)]
    async fn dispatch_github_ci_cancel(
        &self,
        req: GitHubCiCancelRequest,
    ) -> Result<GitHubCiCancelResponse, agent_client_protocol::Error> {
        self.on_github_ci_cancel(req).await
    }

    #[custom_method(GitHubWorkflowDispatchCatalogRequest)]
    async fn dispatch_github_workflow_dispatch_catalog(
        &self,
        req: GitHubWorkflowDispatchCatalogRequest,
    ) -> Result<GitHubWorkflowDispatchCatalogResponse, agent_client_protocol::Error> {
        self.on_github_workflow_dispatch_catalog(req).await
    }

    #[custom_method(GitHubWorkflowDispatchPreviewRequest)]
    async fn dispatch_github_workflow_dispatch_preview(
        &self,
        req: GitHubWorkflowDispatchPreviewRequest,
    ) -> Result<GitHubWorkflowDispatchPreviewResponse, agent_client_protocol::Error> {
        self.on_github_workflow_dispatch_preview(req).await
    }

    #[custom_method(GitHubWorkflowDispatchRequest)]
    async fn dispatch_github_workflow_dispatch(
        &self,
        req: GitHubWorkflowDispatchRequest,
    ) -> Result<GitHubWorkflowDispatchResponse, agent_client_protocol::Error> {
        self.on_github_workflow_dispatch(req).await
    }

    #[custom_method(LocalInferenceModelsListRequest)]
    async fn dispatch_local_inference_models_list(
        &self,
        req: LocalInferenceModelsListRequest,
    ) -> Result<LocalInferenceModelsListResponse, agent_client_protocol::Error> {
        self.on_local_inference_models_list(req).await
    }

    #[custom_method(LocalInferenceModelDownloadRequest)]
    async fn dispatch_local_inference_model_download(
        &self,
        req: LocalInferenceModelDownloadRequest,
    ) -> Result<LocalInferenceModelDownloadResponse, agent_client_protocol::Error> {
        self.on_local_inference_model_download(req).await
    }

    #[custom_method(LocalInferenceModelDownloadProgressRequest)]
    async fn dispatch_local_inference_model_download_progress(
        &self,
        req: LocalInferenceModelDownloadProgressRequest,
    ) -> Result<LocalInferenceModelDownloadProgressResponse, agent_client_protocol::Error> {
        self.on_local_inference_model_download_progress(req).await
    }

    #[custom_method(LocalInferenceModelDownloadCancelRequest)]
    async fn dispatch_local_inference_model_download_cancel(
        &self,
        req: LocalInferenceModelDownloadCancelRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.on_local_inference_model_download_cancel(req).await
    }

    #[custom_method(LocalInferenceModelDeleteRequest)]
    async fn dispatch_local_inference_model_delete(
        &self,
        req: LocalInferenceModelDeleteRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.on_local_inference_model_delete(req).await
    }

    #[custom_method(LocalInferenceModelEvictRequest)]
    async fn dispatch_local_inference_model_evict(
        &self,
        req: LocalInferenceModelEvictRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.on_local_inference_model_evict(req).await
    }

    #[custom_method(LocalInferenceModelSettingsReadRequest)]
    async fn dispatch_local_inference_model_settings_read(
        &self,
        req: LocalInferenceModelSettingsReadRequest,
    ) -> Result<LocalInferenceModelSettingsReadResponse, agent_client_protocol::Error> {
        self.on_local_inference_model_settings_read(req).await
    }

    #[custom_method(LocalInferenceModelSettingsUpdateRequest)]
    async fn dispatch_local_inference_model_settings_update(
        &self,
        req: LocalInferenceModelSettingsUpdateRequest,
    ) -> Result<LocalInferenceModelSettingsUpdateResponse, agent_client_protocol::Error> {
        self.on_local_inference_model_settings_update(req).await
    }

    #[custom_method(LocalInferenceHuggingFaceSearchRequest)]
    async fn dispatch_local_inference_huggingface_search(
        &self,
        req: LocalInferenceHuggingFaceSearchRequest,
    ) -> Result<LocalInferenceHuggingFaceSearchResponse, agent_client_protocol::Error> {
        self.on_local_inference_huggingface_search(req).await
    }

    #[custom_method(LocalInferenceHuggingFaceRepoVariantsRequest)]
    async fn dispatch_local_inference_huggingface_repo_variants(
        &self,
        req: LocalInferenceHuggingFaceRepoVariantsRequest,
    ) -> Result<LocalInferenceHuggingFaceRepoVariantsResponse, agent_client_protocol::Error> {
        self.on_local_inference_huggingface_repo_variants(req).await
    }

    #[custom_method(LocalInferenceBuiltinChatTemplatesListRequest)]
    async fn dispatch_local_inference_builtin_chat_templates_list(
        &self,
        req: LocalInferenceBuiltinChatTemplatesListRequest,
    ) -> Result<LocalInferenceBuiltinChatTemplatesListResponse, agent_client_protocol::Error> {
        self.on_local_inference_builtin_chat_templates_list(req)
            .await
    }
}

fn custom_request_has_handler_access_guard(method: &str) -> bool {
    #[cfg(any(windows, target_os = "macos"))]
    if method == workspace_confirmation::REFRESH_METHOD {
        return true;
    }
    #[cfg(target_os = "macos")]
    if method == workspace_lease::ALLOCATE_PROJECT_CHILD_METHOD {
        return true;
    }
    // These handlers also protect direct calls. Holding an outer permit while
    // reacquiring in the handler can deadlock with load's lifecycle barrier.
    let guarded_methods: [fn(&str) -> bool; 12] = [
        <GetSessionInfoRequest as agent_client_protocol::JsonRpcMessage>::matches_method,
        <AddSessionExtensionRequest as agent_client_protocol::JsonRpcMessage>::matches_method,
        <RemoveSessionExtensionRequest as agent_client_protocol::JsonRpcMessage>::matches_method,
        <GetSessionExtensionsRequest as agent_client_protocol::JsonRpcMessage>::matches_method,
        <GetToolsRequest as agent_client_protocol::JsonRpcMessage>::matches_method,
        <GooseToolCallRequest as agent_client_protocol::JsonRpcMessage>::matches_method,
        <ReadResourceRequest as agent_client_protocol::JsonRpcMessage>::matches_method,
        <AppsListRequest as agent_client_protocol::JsonRpcMessage>::matches_method,
        <ListAgentMentionsRequest as agent_client_protocol::JsonRpcMessage>::matches_method,
        <ListSlashCommandsRequest as agent_client_protocol::JsonRpcMessage>::matches_method,
        <GrantCodeProRestrictedReadonlyRequest as agent_client_protocol::JsonRpcMessage>::matches_method,
        <SteerSessionRequest as agent_client_protocol::JsonRpcMessage>::matches_method,
    ];
    guarded_methods.into_iter().any(|matches| matches(method))
}

fn custom_request_session_id<'a>(method: &str, params: &'a serde_json::Value) -> Option<&'a str> {
    if matches!(
        method,
        "session/delete" | "_goose/unstable/session/archive" | "_goose/unstable/session/unarchive"
    ) {
        return None;
    }
    params
        .get("sessionId")
        .or_else(|| params.get("capability")?.get("sessionId"))
        .and_then(serde_json::Value::as_str)
}

#[cfg(target_os = "macos")]
impl GooseAcpAgent {
    async fn allocate_project_container_child(
        &self,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, agent_client_protocol::Error> {
        if self.client_project_containers.get() != Some(&true) {
            return Err(agent_client_protocol::Error::invalid_params()
                .data("Upgrade the client and negotiate projectContainers version 1"));
        }
        let request: workspace_lease::AllocateWorkspaceChildRequest =
            serde_json::from_value(params)
                .map_err(|e| agent_client_protocol::Error::invalid_params().data(e.to_string()))?;
        let session_id = request.capability.session_id.clone();
        let _lifecycle = workspace_lease::lock_session_lifecycle(&session_id)
            .await
            .internal_err_ctx("Failed to lock project container session")?;
        // Reject a committed close/archive before opening a rollback transaction.
        drop(workspace_lease::acquire_session_access(&session_id).invalid_params_err()?);
        // Idle maintenance also occupies active_prompt_runs after prompt completion.
        // Drain actual session users through the shared lifecycle barrier instead.
        let transaction = workspace_lease::begin_session_lifecycle_transaction(&session_id)
            .internal_err_ctx("Failed to suspend container session")?;
        transaction.wait_for_idle().await.internal_err()?;
        let session = self
            .session_manager
            .get_session(&session_id, false)
            .await
            .internal_err()?;
        if session.session_type != SessionType::CodePro
            || session.archived_at.is_some()
            || self.closed_session_ids.lock().await.contains(&session_id)
        {
            return Err(agent_client_protocol::Error::invalid_params()
                .data("Project allocation requires an active CodePro session"));
        }
        let binding = CodeProWorkspaceBinding::from_extension_data_strict(&session.extension_data)
            .invalid_params_err_ctx("Invalid workspace binding")?;
        match binding {
            Some(
                CodeProWorkspaceBinding::Unbound | CodeProWorkspaceBinding::RootContainer { .. },
            ) => {}
            Some(CodeProWorkspaceBinding::ProjectContainer { path })
                if path == request.container_path => {}
            _ => {
                return Err(agent_client_protocol::Error::invalid_params()
                    .data("This session cannot select another project container"))
            }
        }
        let container = PathBuf::from(&request.container_path);
        let response = workspace_lease::allocate_workspace_child(request)
            .map_err(workspace_allocation_dispatch_error)?;
        let mut extension_data = session.extension_data.clone();
        let persist = async {
            CodeProWorkspaceBinding::ProjectContainer {
                path: container.to_string_lossy().into_owned(),
            }
            .to_extension_data(&mut extension_data)?;
            self.session_manager
                .update(&session_id)
                .working_dir(container)
                .extension_data(extension_data)
                .apply()
                .await?;
            Ok::<_, anyhow::Error>(())
        }
        .await;
        if let Err(error) = persist {
            workspace_lease::release_workspace_lease(&response.lease_id)
                .internal_err_ctx("Container persistence failed and child rollback failed")?;
            return Err(agent_client_protocol::Error::internal_error().data(error.to_string()));
        }
        workspace_lease::schedule_workspace_lease_expiry(response.lease_id.clone());
        transaction.commit_reopened().internal_err()?;
        serde_json::to_value(response).internal_err()
    }
}

#[cfg(any(windows, target_os = "macos"))]
fn workspace_allocation_dispatch_error(error: anyhow::Error) -> agent_client_protocol::Error {
    match workspace_lease::workspace_allocation_permission_error_data(&error) {
        Some(data) => agent_client_protocol::Error::invalid_params().data(data),
        None => agent_client_protocol::Error::invalid_params().data(error.to_string()),
    }
}

#[cfg(any(windows, target_os = "macos"))]
fn dispatch_workspace_lease_request(
    method: &str,
    params: serde_json::Value,
) -> Option<Result<serde_json::Value, agent_client_protocol::Error>> {
    #[cfg(target_os = "macos")]
    if matches!(
        method,
        workspace_lease::EXECUTE_CLEANUP_METHOD
            | workspace_lease::PERMANENT_CLEANUP_METHOD
            | workspace_lease::RESTORE_QUARANTINE_METHOD
            | workspace_lease::LIST_CLEANUP_RECOVERY_METHOD
            | workspace_lease::RETRY_CLEANUP_RECOVERY_METHOD
    ) {
        return Some(Err(agent_client_protocol::Error::invalid_params().data(
            serde_json::json!({"code": "cleanup_read_only", "executionAvailable": false}),
        )));
    }
    if method == workspace_lease::AUDIT_CLEANUP_METHOD {
        return Some(
            serde_json::from_value::<workspace_lease::AuditRootCleanupRequest>(params)
                .map_err(|error| {
                    agent_client_protocol::Error::invalid_params().data(error.to_string())
                })
                .and_then(|request| {
                    workspace_lease::audit_root_cleanup(request).map_err(|error| {
                        agent_client_protocol::Error::invalid_params().data(error.to_string())
                    })
                })
                .and_then(|response| {
                    serde_json::to_value(response).map_err(|error| {
                        agent_client_protocol::Error::internal_error().data(error.to_string())
                    })
                }),
        );
    }
    #[cfg(windows)]
    if method == workspace_lease::EXECUTE_CLEANUP_METHOD {
        return Some(
            serde_json::from_value::<workspace_lease::ExecuteRootCleanupRequest>(params)
                .map_err(|error| {
                    agent_client_protocol::Error::invalid_params().data(error.to_string())
                })
                .and_then(|request| {
                    workspace_lease::execute_root_cleanup(request).map_err(|error| {
                        agent_client_protocol::Error::invalid_params().data(error.to_string())
                    })
                })
                .and_then(|response| {
                    serde_json::to_value(response).map_err(|error| {
                        agent_client_protocol::Error::internal_error().data(error.to_string())
                    })
                }),
        );
    }
    #[cfg(windows)]
    if method == workspace_lease::PERMANENT_CLEANUP_METHOD {
        return Some(
            serde_json::from_value::<workspace_lease::PermanentlyDeleteQuarantineRequest>(params)
                .map_err(|error| {
                    agent_client_protocol::Error::invalid_params().data(error.to_string())
                })
                .and_then(|request| {
                    workspace_lease::permanently_delete_quarantined_cleanup(request).map_err(
                        |error| {
                            agent_client_protocol::Error::invalid_params().data(error.to_string())
                        },
                    )
                })
                .map(|()| serde_json::json!({})),
        );
    }
    #[cfg(windows)]
    if method == workspace_lease::RESTORE_QUARANTINE_METHOD {
        return Some(
            serde_json::from_value::<workspace_lease::PermanentlyDeleteQuarantineRequest>(params)
                .map_err(|error| {
                    agent_client_protocol::Error::invalid_params().data(error.to_string())
                })
                .and_then(|request| {
                    workspace_lease::restore_quarantined_cleanup_by_request(request).map_err(
                        |error| {
                            agent_client_protocol::Error::invalid_params().data(error.to_string())
                        },
                    )
                })
                .map(|()| serde_json::json!({})),
        );
    }
    if method == workspace_lease::CANCEL_CLEANUP_METHOD {
        return Some(
            serde_json::from_value::<workspace_lease::ExecuteRootCleanupRequest>(params)
                .map_err(|error| {
                    agent_client_protocol::Error::invalid_params().data(error.to_string())
                })
                .and_then(|request| {
                    workspace_lease::cancel_root_cleanup(request).map_err(|error| {
                        agent_client_protocol::Error::invalid_params().data(error.to_string())
                    })
                })
                .map(|()| serde_json::json!({})),
        );
    }
    #[cfg(windows)]
    if method == workspace_lease::LIST_CLEANUP_RECOVERY_METHOD {
        return Some(
            serde_json::from_value::<workspace_lease::ListCleanupRecoveryRequest>(params)
                .map_err(|error| {
                    agent_client_protocol::Error::invalid_params().data(error.to_string())
                })
                .and_then(|request| {
                    workspace_lease::list_cleanup_recovery_diagnostics(request).map_err(|error| {
                        agent_client_protocol::Error::invalid_params().data(error.to_string())
                    })
                })
                .and_then(|response| {
                    serde_json::to_value(response).map_err(|error| {
                        agent_client_protocol::Error::internal_error().data(error.to_string())
                    })
                }),
        );
    }
    #[cfg(windows)]
    if method == workspace_lease::RETRY_CLEANUP_RECOVERY_METHOD {
        return Some(
            serde_json::from_value::<workspace_lease::RetryCleanupRecoveryRequest>(params)
                .map_err(|error| {
                    agent_client_protocol::Error::invalid_params().data(error.to_string())
                })
                .and_then(|request| {
                    workspace_lease::retry_cleanup_recovery_original(request).map_err(|error| {
                        agent_client_protocol::Error::invalid_params().data(error.to_string())
                    })
                })
                .and_then(|response| {
                    serde_json::to_value(response).map_err(|error| {
                        agent_client_protocol::Error::internal_error().data(error.to_string())
                    })
                }),
        );
    }
    #[cfg(windows)]
    if method == workspace_lease::ALLOCATE_CHILD_METHOD {
        return Some(
            serde_json::from_value::<workspace_lease::AllocateWorkspaceChildRequest>(params)
                .map_err(|error| {
                    agent_client_protocol::Error::invalid_params().data(error.to_string())
                })
                .and_then(|request| {
                    workspace_lease::allocate_workspace_child(request)
                        .map_err(workspace_allocation_dispatch_error)
                })
                .inspect(|response| {
                    workspace_lease::schedule_workspace_lease_expiry(response.lease_id.clone());
                })
                .and_then(|response| {
                    serde_json::to_value(response).map_err(|error| {
                        agent_client_protocol::Error::internal_error().data(error.to_string())
                    })
                }),
        );
    }
    if method == workspace_lease::ACQUIRE_METHOD {
        return Some(
            serde_json::from_value::<workspace_lease::AcquireWorkspaceLeaseRequest>(params)
                .map_err(|error| {
                    agent_client_protocol::Error::invalid_params().data(error.to_string())
                })
                .and_then(|request| {
                    workspace_lease::acquire_workspace_lease(request).map_err(|error| {
                        agent_client_protocol::Error::invalid_params().data(error.to_string())
                    })
                })
                .inspect(|response| {
                    workspace_lease::schedule_workspace_lease_expiry(response.lease_id.clone());
                })
                .and_then(|response| {
                    serde_json::to_value(response).map_err(|error| {
                        agent_client_protocol::Error::internal_error().data(error.to_string())
                    })
                }),
        );
    }
    if method == workspace_lease::RELEASE_METHOD {
        return Some(
            serde_json::from_value::<workspace_lease::ReleaseWorkspaceLeaseRequest>(params)
                .map_err(|error| {
                    agent_client_protocol::Error::invalid_params().data(error.to_string())
                })
                .and_then(|request| {
                    workspace_lease::release_workspace_lease(&request.lease_id).map_err(|error| {
                        agent_client_protocol::Error::invalid_params().data(error.to_string())
                    })
                })
                .map(|()| serde_json::json!({})),
        );
    }
    None
}

#[cfg(all(test, target_os = "macos"))]
mod workspace_lease_macos_dispatch_tests {
    #[test]
    fn cleanup_api_dispatch_accepts_only_audit_cancel_and_rejects_writes() {
        for method in [
            workspace_lease::AUDIT_CLEANUP_METHOD,
            workspace_lease::CANCEL_CLEANUP_METHOD,
        ] {
            assert!(matches!(
                dispatch_workspace_lease_request(method, serde_json::json!({})),
                Some(Err(_))
            ));
        }
        for method in [
            workspace_lease::EXECUTE_CLEANUP_METHOD,
            workspace_lease::PERMANENT_CLEANUP_METHOD,
            workspace_lease::RESTORE_QUARANTINE_METHOD,
            workspace_lease::LIST_CLEANUP_RECOVERY_METHOD,
            workspace_lease::RETRY_CLEANUP_RECOVERY_METHOD,
        ] {
            let error = dispatch_workspace_lease_request(
                method,
                serde_json::json!({"auditToken":"old-client-token"}),
            )
            .unwrap()
            .unwrap_err();
            assert_eq!(error.data.unwrap()["code"], "cleanup_read_only");
        }
    }

    use super::*;

    #[tokio::test]
    async fn project_container_dispatch_negotiates_and_persists_no_parent_write_authority() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let scheduler_sessions = Arc::new(SessionManager::new(root.join("scheduler-sessions")));
        let scheduler =
            crate::scheduler::Scheduler::new(root.join("scheduler"), scheduler_sessions)
                .await
                .unwrap();
        let provider_factory: AcpProviderFactory = Arc::new(|_, _, _| {
            Box::pin(async { Err(anyhow::anyhow!("provider access is forbidden in this test")) })
        });
        let agent = GooseAcpAgent::new(GooseAcpAgentOptions {
            provider_factory,
            builtins: Vec::new(),
            data_dir: root.join("data"),
            config_dir: root.join("config"),
            disable_session_naming: true,
            goose_platform: GoosePlatform::GooseCli,
            additional_source_roots: Vec::new(),
            scheduler,
        })
        .await
        .unwrap();
        let parent = root.join("父目录 空格");
        std::fs::create_dir(&parent).unwrap();
        let session = agent
            .session_manager
            .create_session(
                root.clone(),
                "container".into(),
                SessionType::CodePro,
                GooseMode::default(),
            )
            .await
            .unwrap();
        let mut data = session.extension_data.clone();
        CodeProWorkspaceBinding::Unbound
            .to_extension_data(&mut data)
            .unwrap();
        agent
            .session_manager
            .update(&session.id)
            .extension_data(data)
            .apply()
            .await
            .unwrap();
        let capability = workspace_lease::issue_root_capability(
            &session.id,
            "run",
            "message",
            None,
            workspace_lease::RootCapabilityKind::AllocateChild,
        )
        .unwrap();
        let params = serde_json::json!({"containerPath":parent,"suggestedName":"中文项目","capability":capability});
        assert!(agent
            .dispatch_custom_request(
                workspace_lease::ALLOCATE_PROJECT_CHILD_METHOD,
                params.clone()
            )
            .await
            .is_err());
        assert!(!parent.join("中文项目").exists());
        agent.client_project_containers.set(true).unwrap();
        // This fixture creates storage directly; production session/new reopens
        // access even when another isolated manager previously used the same ID.
        workspace_lease::reopen_session_access(&session.id).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o500)).unwrap();
        let denied = agent
            .dispatch_custom_request(
                workspace_lease::ALLOCATE_PROJECT_CHILD_METHOD,
                params.clone(),
            )
            .await;
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(
            denied.unwrap_err().data,
            Some(serde_json::json!({
                "code": "workspace_permission_denied", "retryable": true, "capabilityPreserved": true,
            }))
        );
        assert!(!parent.join("中文项目").exists());
        let denied_session = agent
            .session_manager
            .get_session(&session.id, false)
            .await
            .unwrap();
        assert!(matches!(
            CodeProWorkspaceBinding::from_extension_data_strict(&denied_session.extension_data)
                .unwrap(),
            Some(CodeProWorkspaceBinding::Unbound)
        ));
        // Turn-end maintenance can remain registered while confirmation arrives.
        agent.active_prompt_runs.lock().await.insert(
            session.id.clone(),
            ActivePromptRun {
                run_id: "idle-maintenance".into(),
                cancel_token: CancellationToken::new(),
                stop_reason: ActivePromptStopReason::None,
                durable_execution_bound: false,
            },
        );
        let access = workspace_lease::acquire_session_access(&session.id).unwrap();
        let allocation = agent.dispatch_custom_request(
            workspace_lease::ALLOCATE_PROJECT_CHILD_METHOD,
            params.clone(),
        );
        tokio::pin!(allocation);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(30), &mut allocation)
                .await
                .is_err()
        );
        assert!(!parent.join("中文项目").exists());
        let mut latest = agent
            .session_manager
            .get_session(&session.id, false)
            .await
            .unwrap()
            .extension_data;
        latest.set_extension_state(
            "maintenance_regression",
            "v1",
            serde_json::json!("preserved"),
        );
        agent
            .session_manager
            .update(&session.id)
            .extension_data(latest)
            .apply()
            .await
            .unwrap();
        drop(access);
        let response = tokio::time::timeout(std::time::Duration::from_secs(5), allocation)
            .await
            .expect("allocation must proceed after session access drains")
            .unwrap();
        let saved = agent
            .session_manager
            .get_session(&session.id, false)
            .await
            .unwrap();
        assert_eq!(saved.working_dir, parent);
        assert_eq!(
            saved
                .extension_data
                .get_extension_state("maintenance_regression", "v1"),
            Some(&serde_json::json!("preserved"))
        );
        assert!(matches!(
            CodeProWorkspaceBinding::from_extension_data_strict(&saved.extension_data).unwrap(),
            Some(CodeProWorkspaceBinding::ProjectContainer { .. })
        ));
        assert!(!workspace_lease::session_has_workspace_lease(&session.id).unwrap());
        assert!(agent
            .acquire_session_dispatch_access(&session.id, true)
            .await
            .is_err());
        assert_eq!(
            agent
                .dispatch_custom_request(workspace_lease::ALLOCATE_PROJECT_CHILD_METHOD, params)
                .await
                .unwrap(),
            response
        );
        workspace_lease::release_workspace_lease(response["leaseId"].as_str().unwrap()).unwrap();
        assert!(!parent.join("中文项目").exists());
    }

    #[tokio::test]
    async fn archive_delete_and_failure_preserve_session_lifecycle_contract() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let scheduler_sessions = Arc::new(SessionManager::new(root.join("scheduler-sessions")));
        let scheduler =
            crate::scheduler::Scheduler::new(root.join("scheduler"), scheduler_sessions)
                .await
                .unwrap();
        let provider_factory: AcpProviderFactory = Arc::new(|_, _, _| {
            Box::pin(async { Err(anyhow::anyhow!("provider access is forbidden in this test")) })
        });
        let agent = GooseAcpAgent::new(GooseAcpAgentOptions {
            provider_factory,
            builtins: Vec::new(),
            data_dir: root.join("data"),
            config_dir: root.join("config"),
            disable_session_naming: true,
            goose_platform: GoosePlatform::GooseCli,
            additional_source_roots: Vec::new(),
            scheduler,
        })
        .await
        .unwrap();
        let workspace = root.join("project");
        std::fs::create_dir(&workspace).unwrap();
        let session = agent
            .session_manager
            .create_session(
                workspace.clone(),
                "Mac lifecycle".into(),
                SessionType::Acp,
                GooseMode::default(),
            )
            .await
            .unwrap();
        workspace_lease::reacquire_existing_session_workspace_lease(&session.id, &workspace)
            .unwrap();
        agent
            .on_archive_session(ArchiveSessionRequest {
                session_id: session.id.clone(),
            })
            .await
            .unwrap();
        assert!(!workspace_lease::session_has_workspace_lease(&session.id).unwrap());
        assert!(workspace_lease::acquire_session_access(&session.id).is_err());
        agent
            .on_unarchive_session(UnarchiveSessionRequest {
                session_id: session.id.clone(),
            })
            .await
            .unwrap();
        drop(workspace_lease::acquire_session_access(&session.id).unwrap());
        workspace_lease::reacquire_existing_session_workspace_lease(&session.id, &workspace)
            .unwrap();
        agent
            .on_delete_session(DeleteSessionRequest {
                session_id: session.id.clone(),
            })
            .await
            .unwrap();
        assert!(!workspace_lease::session_has_workspace_lease(&session.id).unwrap());
        let missing = format!("missing-{}", Uuid::new_v4());
        assert!(agent
            .on_delete_session(DeleteSessionRequest {
                session_id: missing.clone()
            })
            .await
            .is_err());
        drop(workspace_lease::acquire_session_access(&missing).unwrap());
    }

    #[tokio::test]
    async fn native_acquire_release_handlers_validate_and_return_real_leases() {
        let invalid = dispatch_workspace_lease_request(
            workspace_lease::ACQUIRE_METHOD,
            serde_json::json!({}),
        )
        .expect("Mac must register acquire")
        .unwrap_err();
        assert_eq!(
            invalid.code,
            agent_client_protocol::Error::invalid_params().code
        );
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().canonicalize().unwrap();
        let response = dispatch_workspace_lease_request(workspace_lease::ACQUIRE_METHOD, serde_json::json!({
            "requestedPath": workspace, "expectedIdentity": workspace, "expectedState": "empty-directory",
        })).unwrap().unwrap();
        assert_eq!(response["workingDir"], workspace.to_string_lossy().as_ref());
        let lease_id = response["leaseId"].as_str().unwrap();
        dispatch_workspace_lease_request(
            workspace_lease::RELEASE_METHOD,
            serde_json::json!({"leaseId": lease_id}),
        )
        .unwrap()
        .unwrap();
        assert!(dispatch_workspace_lease_request(
            workspace_lease::RELEASE_METHOD,
            serde_json::json!({"leaseId": lease_id})
        )
        .unwrap()
        .is_err());
    }
}

#[cfg(all(test, windows))]
mod workspace_lease_dispatch_tests {
    use super::*;
    use crate::agents::codepro_workspace_binding::CodeProWorkspaceBinding;
    use crate::session::extension_data::ExtensionState;
    use std::sync::{Mutex, OnceLock};

    struct CustomDispatchPermitHook {
        method: &'static str,
        session_id: String,
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    }

    fn custom_dispatch_permit_hook() -> &'static Mutex<Option<CustomDispatchPermitHook>> {
        static HOOK: OnceLock<Mutex<Option<CustomDispatchPermitHook>>> = OnceLock::new();
        HOOK.get_or_init(|| Mutex::new(None))
    }

    struct CustomDispatchPermitHookGuard;

    impl CustomDispatchPermitHookGuard {
        fn enter(
            method: &'static str,
            session_id: String,
        ) -> (Self, Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>) {
            let entered = Arc::new(tokio::sync::Notify::new());
            let release = Arc::new(tokio::sync::Notify::new());
            let previous =
                custom_dispatch_permit_hook()
                    .lock()
                    .unwrap()
                    .replace(CustomDispatchPermitHook {
                        method,
                        session_id,
                        entered: Arc::clone(&entered),
                        release: Arc::clone(&release),
                    });
            assert!(
                previous.is_none(),
                "custom dispatch test hook already active"
            );
            (Self, entered, release)
        }
    }

    impl Drop for CustomDispatchPermitHookGuard {
        fn drop(&mut self) {
            custom_dispatch_permit_hook().lock().unwrap().take();
        }
    }

    pub(super) async fn hold_custom_dispatch_after_permit_for_test(
        method: &str,
        session_id: Option<&str>,
    ) {
        let hook = custom_dispatch_permit_hook()
            .lock()
            .unwrap()
            .as_ref()
            .filter(|hook| hook.method == method && Some(hook.session_id.as_str()) == session_id)
            .map(|hook| (Arc::clone(&hook.entered), Arc::clone(&hook.release)));
        if let Some((entered, release)) = hook {
            entered.notify_one();
            release.notified().await;
        }
    }

    async fn create_unbound_codepro_session(
        agent: &GooseAcpAgent,
        working_dir: std::path::PathBuf,
        name: &str,
    ) -> crate::session::Session {
        std::fs::create_dir_all(&working_dir).unwrap();
        let session = agent
            .session_manager
            .create_session(
                working_dir,
                name.to_string(),
                SessionType::CodePro,
                GooseMode::default(),
            )
            .await
            .unwrap();
        let mut extension_data = session.extension_data.clone();
        CodeProWorkspaceBinding::Unbound
            .to_extension_data(&mut extension_data)
            .unwrap();
        agent
            .session_manager
            .update(&session.id)
            .extension_data(extension_data)
            .apply()
            .await
            .unwrap();
        agent
            .session_manager
            .get_session(&session.id, false)
            .await
            .unwrap()
    }

    async fn test_agent(root: &std::path::Path) -> GooseAcpAgent {
        let scheduler_sessions = Arc::new(SessionManager::new(root.join("scheduler-sessions")));
        let scheduler =
            crate::scheduler::Scheduler::new(root.join("scheduler"), scheduler_sessions)
                .await
                .unwrap();
        let provider_factory: AcpProviderFactory = Arc::new(|_, _, _| {
            Box::pin(async { Err(anyhow::anyhow!("provider access is forbidden in this test")) })
        });
        GooseAcpAgent::new(GooseAcpAgentOptions {
            provider_factory,
            builtins: Vec::new(),
            data_dir: root.join("data"),
            config_dir: root.join("config"),
            disable_session_naming: true,
            goose_platform: GoosePlatform::GooseCli,
            additional_source_roots: Vec::new(),
            scheduler,
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn session_info_recovers_metadata_without_granting_missing_workspace_access() {
        let temp = tempfile::tempdir().unwrap();
        let agent = test_agent(temp.path()).await;
        let cwd = temp.path().join("missing-project");
        let session = agent
            .session_manager
            .create_session(
                cwd.clone(),
                "missing project".to_string(),
                SessionType::CodePro,
                GooseMode::default(),
            )
            .await
            .unwrap();
        let mut extension_data = session.extension_data.clone();
        CodeProWorkspaceBinding::WritableProject {
            path: cwd.to_string_lossy().into_owned(),
            lease_id: "expired-fixture-lease".to_string(),
        }
        .to_extension_data(&mut extension_data)
        .unwrap();
        agent
            .session_manager
            .update(&session.id)
            .extension_data(extension_data.clone())
            .apply()
            .await
            .unwrap();

        let info = agent
            .dispatch_custom_request(
                "_goose/unstable/session/info",
                serde_json::json!({"sessionId": session.id}),
            )
            .await
            .unwrap();
        assert_eq!(info["session"]["cwd"], cwd.to_string_lossy().as_ref());
        assert!(!cwd.exists());
        assert!(!workspace_lease::session_has_workspace_lease(&session.id).unwrap());
        assert!(agent
            .acquire_session_dispatch_access(&session.id, true)
            .await
            .is_err());
        let stored = agent
            .session_manager
            .get_session(&session.id, false)
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(&stored.extension_data).unwrap(),
            serde_json::to_value(&extension_data).unwrap()
        );
        assert_eq!(stored.working_dir, cwd);
    }

    #[tokio::test]
    async fn session_info_metadata_still_rejects_missing_and_closed_sessions() {
        let temp = tempfile::tempdir().unwrap();
        let _journal = workspace_lease::TestCleanupJournalRootGuard::enter(
            temp.path().join("cleanup-journal"),
        );
        let agent = test_agent(temp.path()).await;
        assert!(agent
            .dispatch_custom_request(
                "_goose/unstable/session/info",
                serde_json::json!({"sessionId":"missing-metadata-session"})
            )
            .await
            .is_err());
        let session = create_unbound_codepro_session(
            &agent,
            temp.path().join("closed-project"),
            "closed metadata",
        )
        .await;
        let close = workspace_lease::begin_session_close(&session.id).unwrap();
        assert!(agent
            .dispatch_custom_request(
                "_goose/unstable/session/info",
                serde_json::json!({"sessionId":session.id})
            )
            .await
            .is_err());
        drop(close);
        workspace_lease::reopen_session_access(&session.id).unwrap();
    }

    #[tokio::test]
    #[serial_test::serial(custom_dispatch_permit_hook)]
    async fn session_extension_dispatch_does_not_deadlock_with_load_barrier() {
        let temp = tempfile::tempdir().unwrap();
        let _journal = workspace_lease::TestCleanupJournalRootGuard::enter(
            temp.path().join("cleanup-journal"),
        );
        let agent = test_agent(temp.path()).await;
        let session = agent
            .session_manager
            .create_session(
                temp.path().to_path_buf(),
                "load race".to_string(),
                SessionType::User,
                GooseMode::default(),
            )
            .await
            .unwrap();
        let method = "_goose/unstable/session/extensions/list";
        let (_hook, entered, release) =
            CustomDispatchPermitHookGuard::enter(method, session.id.clone());
        let dispatch =
            agent.dispatch_custom_request(method, serde_json::json!({ "sessionId": session.id }));
        tokio::pin!(dispatch);
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            tokio::select! {
                _ = entered.notified() => {}
                result = &mut dispatch => panic!("dispatch bypassed test barrier: {result:?}"),
            }
        })
        .await
        .expect("dispatch must reach its test barrier");
        let lifecycle = workspace_lease::lock_session_lifecycle(&session.id)
            .await
            .unwrap();
        let transaction =
            workspace_lease::begin_session_lifecycle_transaction(&session.id).unwrap();
        release.notify_one();
        let load_barrier = async move {
            transaction.wait_for_idle().await.unwrap();
            transaction.commit_reopened().unwrap();
            drop(lifecycle);
        };
        let (_, response) = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            tokio::join!(load_barrier, &mut dispatch)
        })
        .await
        .expect("load and extension dispatch must not wait on each other");
        assert!(response.unwrap()["extensions"].is_array());
    }

    #[tokio::test]
    async fn handler_guarded_dispatch_preserves_workspace_and_closing_checks() {
        let temp = tempfile::tempdir().unwrap();
        let _journal = workspace_lease::TestCleanupJournalRootGuard::enter(
            temp.path().join("cleanup-journal"),
        );
        let agent = test_agent(temp.path()).await;
        let session =
            create_unbound_codepro_session(&agent, temp.path().join("unbound"), "guard coverage")
                .await;
        let methods = [
            ("_goose/unstable/session/extensions/add", true),
            ("_goose/unstable/session/extensions/remove", true),
            ("_goose/unstable/session/extensions/list", true),
            ("_goose/unstable/tools/list", true),
            ("_goose/unstable/tools/call", true),
            ("_goose/unstable/resources/read", true),
            ("_goose/unstable/apps/list", true),
            ("_goose/unstable/agent-mentions/list", true),
            ("_goose/unstable/slash-commands/list", true),
            (
                "_goose/unstable/codepro/workspace/grant-restricted-readonly",
                false,
            ),
            ("_goose/unstable/session/steer", false),
        ];
        let params = serde_json::json!({
            "sessionId": session.id,
            "extension": { "type": "platform", "name": "analyze" },
            "name": "analyze", "uri": "file:///must-not-be-read", "extensionName": "analyze",
            "prompt": [{ "type": "text", "text": "must not execute" }],
            "expectedRunId": "no-active-run"
        });
        for (method, require_writable) in methods {
            if require_writable {
                let error = agent
                    .dispatch_custom_request(method, params.clone())
                    .await
                    .unwrap_err();
                assert!(
                    serde_json::to_string(&error)
                        .unwrap()
                        .contains("CodePro extension access requires a writable project binding"),
                    "{method}: {error:?}"
                );
            }
            let mut missing = params.clone();
            missing["sessionId"] = serde_json::json!("missing-handler-guard-session");
            let error = agent
                .dispatch_custom_request(method, missing)
                .await
                .unwrap_err();
            assert_eq!(
                error.code,
                agent_client_protocol::Error::resource_not_found(None).code,
                "{method}: missing session must be rejected before handler work"
            );
        }
        let transaction =
            workspace_lease::begin_session_lifecycle_transaction(&session.id).unwrap();
        transaction.wait_for_idle().await.unwrap();
        for (method, _) in methods {
            let error = agent
                .dispatch_custom_request(method, params.clone())
                .await
                .unwrap_err();
            assert!(
                serde_json::to_string(&error)
                    .unwrap()
                    .contains("Session access denied"),
                "{method}: {error:?}"
            );
        }
        drop(transaction);
        assert!(workspace_lease::acquire_session_access(&session.id).is_ok());
    }

    #[test]
    fn workspace_lease_methods_are_registered_and_invalid_requests_are_diagnostic() {
        let cleanup = dispatch_workspace_lease_request(
            workspace_lease::AUDIT_CLEANUP_METHOD,
            serde_json::json!({ "rootPath": "D:\\", "targets": [] }),
        );
        assert!(matches!(cleanup, Some(Err(_))));

        let allocate = dispatch_workspace_lease_request(
            workspace_lease::ALLOCATE_CHILD_METHOD,
            serde_json::json!({ "containerPath": "C:\\not-a-root", "suggestedName": "app" }),
        );
        assert!(matches!(allocate, Some(Err(_))));

        let acquire = dispatch_workspace_lease_request(
            workspace_lease::ACQUIRE_METHOD,
            serde_json::json!({}),
        );
        assert!(matches!(acquire, Some(Err(_))));

        let release = dispatch_workspace_lease_request(
            workspace_lease::RELEASE_METHOD,
            serde_json::json!({ "leaseId": "missing" }),
        );
        assert!(matches!(release, Some(Err(_))));
        assert!(
            dispatch_workspace_lease_request("_goose/unknown", serde_json::json!({})).is_none()
        );
    }

    #[test]
    fn r4_core5_allocate_permission_dispatch_error_has_exact_path_free_data_contract() {
        let classified = workspace_lease::path_free_workspace_permission_error(anyhow::anyhow!(
            r"Access is denied: D:\private\project"
        ));
        let error = workspace_allocation_dispatch_error(classified);

        assert_eq!(
            error.data.as_ref(),
            Some(&serde_json::json!({
                "code": "workspace_permission_denied",
                "retryable": true,
                "capabilityPreserved": true,
            }))
        );
        let serialized = serde_json::to_string(&error).unwrap();
        assert!(!serialized.contains("private"));
        assert!(!serialized.contains("project"));
    }

    #[tokio::test]
    async fn recovery_custom_dispatch_rejects_missing_non_codepro_and_closing_sessions() {
        let temp = tempfile::tempdir().unwrap();
        let _journal = workspace_lease::TestCleanupJournalRootGuard::enter(
            temp.path().join("cleanup-journal"),
        );
        let agent = test_agent(temp.path()).await;

        let missing = agent
            .dispatch_custom_request(
                workspace_lease::LIST_CLEANUP_RECOVERY_METHOD,
                serde_json::json!({}),
            )
            .await;
        assert!(missing.is_err());

        let ordinary = agent
            .session_manager
            .create_session(
                temp.path().join("ordinary"),
                "ordinary".to_string(),
                SessionType::Acp,
                GooseMode::default(),
            )
            .await
            .unwrap();
        let ordinary_request = serde_json::json!({
            "capability": {
                "sessionId": ordinary.id,
                "runId": "run-1",
                "sourceMessageId": "message-1",
                "nonce": "nonce-1"
            }
        });
        assert!(agent
            .dispatch_custom_request(
                workspace_lease::LIST_CLEANUP_RECOVERY_METHOD,
                ordinary_request,
            )
            .await
            .is_err());

        let closing = agent
            .session_manager
            .create_session(
                temp.path().join("closing"),
                "closing".to_string(),
                SessionType::CodePro,
                GooseMode::default(),
            )
            .await
            .unwrap();
        let close = workspace_lease::begin_session_close(&closing.id).unwrap();
        let closing_request = serde_json::json!({
            "capability": {
                "sessionId": closing.id,
                "runId": "run-2",
                "sourceMessageId": "message-2",
                "nonce": "nonce-2"
            }
        });
        assert!(agent
            .dispatch_custom_request(
                workspace_lease::RETRY_CLEANUP_RECOVERY_METHOD,
                closing_request,
            )
            .await
            .is_err());
        drop(close);
        workspace_lease::reopen_session_access(&closing.id).unwrap();
        assert!(workspace_lease::acquire_session_access(&closing.id).is_ok());
    }

    #[tokio::test]
    #[serial_test::serial(custom_dispatch_permit_hook)]
    async fn r4_core5_recovery_dispatch_uses_real_journal_authority_and_permit_lifetime() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .components()
            .take(2)
            .collect::<std::path::PathBuf>();
        let temp = tempfile::Builder::new()
            .prefix("codepro-dispatch-recovery-")
            .tempdir_in(&root)
            .unwrap();
        let _journal = workspace_lease::TestCleanupJournalRootGuard::enter(
            temp.path().join("cleanup-journal"),
        );
        let agent = Arc::new(test_agent(temp.path()).await);
        let session = create_unbound_codepro_session(
            &agent,
            temp.path().join("codepro-session"),
            "recovery owner",
        )
        .await;
        let target = temp.path().join("dispatch-recovery.tmp");
        std::fs::write(&target, b"dispatch recovery").unwrap();
        let capability = workspace_lease::issue_root_capability(
            &session.id,
            "dispatch-run",
            "dispatch-message",
            Some(&root),
            workspace_lease::RootCapabilityKind::CleanupAudit,
        )
        .unwrap();

        let audit = agent
            .dispatch_custom_request(
                workspace_lease::AUDIT_CLEANUP_METHOD,
                serde_json::json!({
                    "rootPath": root,
                    "targets": [target],
                    "capability": capability,
                }),
            )
            .await
            .expect("valid CodePro audit dispatch");
        let audit_token = audit["auditToken"].as_str().unwrap().to_string();
        let quarantine = agent
            .dispatch_custom_request(
                workspace_lease::EXECUTE_CLEANUP_METHOD,
                serde_json::json!({
                    "auditToken": audit_token,
                    "capability": capability,
                }),
            )
            .await
            .expect("valid CodePro execute dispatch");
        let quarantine_token = quarantine["quarantineToken"].as_str().unwrap().to_string();
        assert!(!target.exists());
        workspace_lease::abandon_cleanup_quarantine_for_test(&quarantine_token).unwrap();

        let list_params = serde_json::json!({ "capability": capability });
        let listed = agent
            .dispatch_custom_request(
                workspace_lease::LIST_CLEANUP_RECOVERY_METHOD,
                list_params.clone(),
            )
            .await
            .expect("real recovery list handler");
        assert_eq!(listed["recoveries"].as_array().unwrap().len(), 1);
        assert_eq!(listed["recoveries"][0]["quarantineToken"], quarantine_token);
        assert_eq!(listed["recoveries"][0]["retryOriginalAvailable"], true);

        let wrong_session = create_unbound_codepro_session(
            &agent,
            temp.path().join("wrong-session"),
            "wrong recovery owner",
        )
        .await;
        let mut wrong_capability = capability.clone();
        wrong_capability.session_id = wrong_session.id.clone();
        let wrong_list = agent
            .dispatch_custom_request(
                workspace_lease::LIST_CLEANUP_RECOVERY_METHOD,
                serde_json::json!({ "capability": wrong_capability }),
            )
            .await
            .expect("wrong active session reaches the real list handler");
        assert!(wrong_list["recoveries"].as_array().unwrap().is_empty());
        assert!(agent
            .dispatch_custom_request(
                workspace_lease::RETRY_CLEANUP_RECOVERY_METHOD,
                serde_json::json!({
                    "capability": wrong_capability,
                    "quarantineToken": quarantine_token,
                }),
            )
            .await
            .is_err());

        let (_hook, entered, release) = CustomDispatchPermitHookGuard::enter(
            workspace_lease::LIST_CLEANUP_RECOVERY_METHOD,
            session.id.clone(),
        );
        let dispatch_agent = Arc::clone(&agent);
        let held_list = tokio::spawn(async move {
            dispatch_agent
                .dispatch_custom_request(workspace_lease::LIST_CLEANUP_RECOVERY_METHOD, list_params)
                .await
        });
        entered.notified().await;
        let close = workspace_lease::begin_session_lifecycle_transaction(&session.id).unwrap();
        let closing = tokio::spawn(async move {
            close.wait_for_idle().await.unwrap();
            close
        });
        tokio::task::yield_now().await;
        assert!(
            !closing.is_finished(),
            "LIST must retain its session permit"
        );
        release.notify_one();
        assert!(held_list.await.unwrap().is_ok());
        let close = closing.await.unwrap();
        drop(close);

        let retry = agent
            .dispatch_custom_request(
                workspace_lease::RETRY_CLEANUP_RECOVERY_METHOD,
                serde_json::json!({
                    "capability": capability,
                    "quarantineToken": quarantine_token,
                }),
            )
            .await
            .expect("authorized real retry handler");
        assert_eq!(retry["restored"], true);
        assert_eq!(std::fs::read(&target).unwrap(), b"dispatch recovery");

        let closed_session = create_unbound_codepro_session(
            &agent,
            temp.path().join("closed-session"),
            "closed recovery owner",
        )
        .await;
        let closed =
            workspace_lease::begin_session_lifecycle_transaction(&closed_session.id).unwrap();
        closed.wait_for_idle().await.unwrap();
        closed.commit_closed();
        assert!(agent
            .dispatch_custom_request(
                workspace_lease::LIST_CLEANUP_RECOVERY_METHOD,
                serde_json::json!({
                    "capability": {
                        "sessionId": closed_session.id,
                        "runId": "closed-run",
                        "sourceMessageId": "closed-message",
                        "nonce": "closed-nonce"
                    }
                }),
            )
            .await
            .is_err());
        workspace_lease::reopen_session_access(&closed_session.id).unwrap();

        agent.session_manager.storage().close_for_test().await;
        drop(closed_session);
        drop(wrong_session);
        drop(session);
        drop(agent);
        drop(_journal);
        temp.close()
            .expect("dispatch recovery test workspace must be removed");
    }

    #[tokio::test]
    async fn session_teardown_failures_reopen_and_unarchive_reopens_dispatch_access() {
        let temp = tempfile::tempdir().unwrap();
        let _journal = workspace_lease::TestCleanupJournalRootGuard::enter(
            temp.path().join("cleanup-journal"),
        );
        let agent = test_agent(temp.path()).await;

        let missing_delete = format!("missing-delete-{}", Uuid::new_v4());
        assert!(agent
            .on_delete_session(DeleteSessionRequest {
                session_id: missing_delete.clone(),
            })
            .await
            .is_err());
        assert!(workspace_lease::acquire_session_access(&missing_delete).is_ok());

        let missing_archive = format!("missing-archive-{}", Uuid::new_v4());
        assert!(agent
            .on_archive_session(ArchiveSessionRequest {
                session_id: missing_archive.clone(),
            })
            .await
            .is_err());
        assert!(workspace_lease::acquire_session_access(&missing_archive).is_ok());

        let session = agent
            .session_manager
            .create_session(
                temp.path().join("archive-roundtrip"),
                "archive roundtrip".to_string(),
                SessionType::Acp,
                GooseMode::default(),
            )
            .await
            .unwrap();
        agent
            .on_archive_session(ArchiveSessionRequest {
                session_id: session.id.clone(),
            })
            .await
            .unwrap();
        assert!(workspace_lease::acquire_session_access(&session.id).is_err());
        agent
            .on_unarchive_session(UnarchiveSessionRequest {
                session_id: session.id.clone(),
            })
            .await
            .unwrap();
        assert!(workspace_lease::acquire_session_access(&session.id).is_ok());
    }
}

#[cfg(test)]
mod github_contract_tests {
    use super::*;

    #[test]
    fn session_scoped_custom_requests_are_detected_centrally() {
        assert_eq!(
            custom_request_session_id(
                "_goose/session/update",
                &serde_json::json!({
                    "sessionId": "session-1"
                })
            ),
            Some("session-1")
        );
        assert_eq!(
            custom_request_session_id(
                "_goose/unstable/root-cleanup/audit",
                &serde_json::json!({
                    "capability": { "sessionId": "session-2" }
                })
            ),
            Some("session-2")
        );
        assert_eq!(
            custom_request_session_id(
                "session/delete",
                &serde_json::json!({
                    "sessionId": "session-1"
                })
            ),
            None
        );
    }

    #[test]
    fn github_auth_custom_methods_are_registered() {
        let mut generator = schemars::SchemaGenerator::default();
        let methods = GooseAcpAgent::custom_method_schemas(&mut generator)
            .into_iter()
            .map(|schema| schema.method)
            .collect::<std::collections::HashSet<_>>();

        for expected in [
            "_goose/unstable/github/auth/status",
            "_goose/unstable/github/auth/start",
            "_goose/unstable/github/auth/poll",
            "_goose/unstable/github/auth/cancel",
            "_goose/unstable/github/auth/disconnect",
            "_goose/unstable/github/pull-request/preview",
            "_goose/unstable/github/pull-request/create",
            "_goose/unstable/github/delivery/status",
            "_goose/unstable/github/ci/status",
            "_goose/unstable/github/ci/rerun-failed-jobs/preview",
            "_goose/unstable/github/ci/rerun-failed-jobs",
        ] {
            assert!(
                methods.contains(expected),
                "missing custom method {expected}"
            );
        }
    }
}
