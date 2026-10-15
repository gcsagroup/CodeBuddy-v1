use super::*;
use crate::providers::inventory::ensure_refresh_identity_current;

fn committed_provider_model_config_options(
    provider_id: &str,
    model_id: &str,
    thinking_effort: Option<goose_providers::thinking::ThinkingEffort>,
) -> Vec<SessionConfigOption> {
    let mut options = vec![
        SessionConfigOption::select(
            "provider",
            "Provider",
            provider_id.to_string(),
            vec![SessionConfigSelectOption::new(
                provider_id.to_string(),
                provider_id.to_string(),
            )],
        ),
        SessionConfigOption::select(
            "model",
            "Model",
            model_id.to_string(),
            vec![SessionConfigSelectOption::new(
                model_id.to_string(),
                model_id.to_string(),
            )],
        )
        .category(SessionConfigOptionCategory::Model),
    ];
    if let Some(effort) = thinking_effort {
        let effort = effort.to_string();
        options.push(
            SessionConfigOption::select(
                "thinking_effort",
                "Thinking effort",
                effort.clone(),
                vec![SessionConfigSelectOption::new(effort.clone(), effort)],
            )
            .category(SessionConfigOptionCategory::ThoughtLevel),
        );
    }
    options
}

fn tolerate_committed_notification_failure<E>(
    result: Result<(), E>,
    committed: bool,
) -> Result<(), E> {
    if committed && result.is_err() {
        Ok(())
    } else {
        result
    }
}

impl HandleDispatchFrom<Client> for GooseAcpHandler {
    fn describe_chain(&self) -> impl std::fmt::Debug {
        "goose-acp"
    }

    fn handle_dispatch_from(
        &mut self,
        message: Dispatch,
        cx: ConnectionTo<Client>,
    ) -> impl std::future::Future<Output = Result<Handled<Dispatch>, agent_client_protocol::Error>> + Send
    {
        let agent = self.agent.clone();

        // The MatchDispatchFrom chain produces an ~85KB async state machine.
        // Box::pin moves it to the heap so it doesn't overflow the tokio worker stack.
        Box::pin(async move {
            // Capture the connection handle so handlers can lazily activate
            // sessions that exist on disk but were never activated via
            // new_session/load_session on this connection. Set-once per
            // connection; the result is ignored on later requests.
            let _ = agent.client_cx.set(cx.clone());

            // InitializeRequest runs inline: it sets connection-scoped state
            // (client fs/terminal capabilities) that later handlers read with
            // defaults, so a pipelined NewSessionRequest must not race ahead of it.
            MatchDispatchFrom::new(message, &cx)
                .if_request(
                    |req: InitializeRequest, responder: Responder<InitializeResponse>| async {
                        responder.respond_with_result(agent.on_initialize(req).await)
                    },
                )
                .await
                .if_request(
                    |_req: AuthenticateRequest, responder: Responder<AuthenticateResponse>| async {
                        responder.respond(AuthenticateResponse::new())
                    },
                )
                .await
                .if_request(
                    |req: NewSessionRequest, responder: Responder<NewSessionResponse>| async {
                        let agent = agent.clone();
                        let cx_clone = cx.clone();
                        cx.spawn(async move {
                            responder.respond_with_result(agent.on_new_session(&cx_clone, req).await)?;
                            Ok(())
                        })?;
                        Ok(())
                    },
                )
                .await
                .if_request(
                    |req: LoadSessionRequest, responder: Responder<LoadSessionResponse>| async {
                        let agent = agent.clone();
                        let cx_clone = cx.clone();
                        cx.spawn(async move {
                            let session_id = req.session_id.0.to_string();
                            match agent.on_load_session(&cx_clone, req).await {
                                Ok(response) => {
                                    responder.respond(response)?;
                                }
                                Err(e) => {
                                    tracing::error!(
                                        session_id = %session_id,
                                        error = ?e,
                                        "ACP load_session failed"
                                    );
                                    responder.respond_with_error(e)?;
                                }
                            }
                            Ok(())
                        })?;
                        Ok(())
                    },
                )
                .await
                .if_request(
                    |req: PromptRequest, responder: Responder<PromptResponse>| async {
                        let agent = agent.clone();
                        let cx_clone = cx.clone();
                        cx.spawn(async move {
                            match agent.on_prompt(&cx_clone, req).await {
                                Ok(response) => {
                                    responder.respond(response)?;
                                }
                                Err(e) => {
                                    responder.respond_with_error(e)?;
                                }
                            }
                            Ok(())
                        })?;
                        Ok(())
                    },
                )
                .await
                .if_notification(|notif: CancelNotification| async {
                    let agent = agent.clone();
                    agent.on_cancel(notif).await?;
                    Ok(())
                })
                .await
                // set_config_option (SACP 11) and set_mode; custom _goose/* in otherwise.
                .if_request({
                    let agent = agent.clone();
                    let cx = cx.clone();
                    |req: SetSessionConfigOptionRequest, responder: Responder<SetSessionConfigOptionResponse>| async move {
                        let cx_spawn = cx.clone();
                        cx.spawn(async move {
                            let cx = cx_spawn;
                            let value_id = match req.value.as_value_id() {
                                Some(value_id) => value_id.clone(),
                                None => {
                                    responder.respond_with_error(
                                        agent_client_protocol::Error::invalid_params().data("Expected a value ID")
                                    )?;
                                    return Ok(());
                                }
                            };
                            let session_id = req.session_id.clone();
                            let session_permit = match agent
                                .acquire_session_dispatch_access(&session_id.0, false)
                                .await
                            {
                                Ok(permit) => permit,
                                Err(error) => {
                                    responder.respond_with_error(error)?;
                                    return Ok(());
                                }
                            };
                            let sid = sid_short(session_id.0.as_ref());
                            let config_id = req.config_id.0.to_string();
                            let t_handler = std::time::Instant::now();
                            let mut selected_provider_id = None;
                            let mut committed_provider_model = None;
                            match config_id.as_ref() {
                                "provider" => {
                                    Config::global().invalidate_secrets_cache();
                                    match agent.update_provider(&session_id.0, &value_id.0, None, None, None).await {
                                        Ok(_) => selected_provider_id = Some(value_id.0.to_string()),
                                        Err(e) => { responder.respond_with_error(e)?; return Ok(()); }
                                    }
                                }
                                "provider_model" => {
                                    #[derive(serde::Deserialize)]
                                    #[serde(rename_all = "camelCase", deny_unknown_fields)]
                                    struct ProviderModelSelection {
                                        provider_id: String,
                                        model_id: String,
                                        thinking_effort: Option<goose_providers::thinking::ThinkingEffort>,
                                    }

                                    let selection = match serde_json::from_str::<ProviderModelSelection>(&value_id.0) {
                                        Ok(selection) => selection,
                                        Err(error) => {
                                            responder.respond_with_error(
                                                agent_client_protocol::Error::invalid_params().data(format!(
                                                    "Invalid provider/model selection: {error}"
                                                ))
                                            )?;
                                            return Ok(());
                                        }
                                    };
                                    let provider_id = selection.provider_id.trim().to_string();
                                    let model_id = selection.model_id.trim().to_string();
                                    if provider_id.is_empty() || model_id.is_empty() {
                                        responder.respond_with_error(
                                            agent_client_protocol::Error::invalid_params()
                                                .data("providerId and modelId must both be non-empty"),
                                        )?;
                                        return Ok(());
                                    }
                                    let request_params = selection.thinking_effort.map(|effort| {
                                        std::collections::HashMap::from([(
                                            "thinking_effort".to_string(),
                                            serde_json::json!(effort.to_string()),
                                        )])
                                    });
                                    selected_provider_id = Some(provider_id.clone());
                                    if let Err(error) = agent
                                        .update_provider(
                                            &session_id.0,
                                            &provider_id,
                                            Some(&model_id),
                                            None,
                                            request_params,
                                        )
                                        .await
                                    {
                                        responder.respond_with_error(error)?;
                                        return Ok(());
                                    }
                                    committed_provider_model = Some((
                                        provider_id,
                                        model_id,
                                        selection.thinking_effort,
                                    ));
                                }
                                "mode" => {
                                    match agent.on_set_mode(&session_id.0, &value_id.0).await {
                                        Ok(_) => {}
                                        Err(e) => { responder.respond_with_error(e)?; return Ok(()); }
                                    }
                                }
                                "model" => {
                                    match agent.on_set_model(&session_id.0, &value_id.0).await {
                                        Ok(_) => {}
                                        Err(e) => { responder.respond_with_error(e)?; return Ok(()); }
                                    }
                                }
                                "thinking_effort" => {
                                    match agent.on_set_thinking_effort(&session_id.0, &value_id.0).await {
                                        Ok(_) => {}
                                        Err(e) => { responder.respond_with_error(e)?; return Ok(()); }
                                    }
                                }
                                other => {
                                    responder.respond_with_error(
                                        agent_client_protocol::Error::invalid_params().data(format!("Unsupported config option: {}", other))
                                    )?;
                                    return Ok(());
                                }
                            }
                            // Respond immediately using the current provider inventory snapshot.
                            let (notification, config_options) = match agent.build_config_update(&session_id).await {
                                Ok((notification, options)) => (Some(notification), options),
                                Err(e) => {
                                    warn!(
                                        sid = %sid,
                                        config_id = %config_id,
                                        error = ?e,
                                        "failed to build config update after config change"
                                    );
                                    match committed_provider_model.as_ref() {
                                        Some((provider, model, effort)) => (
                                            None,
                                            committed_provider_model_config_options(
                                                provider,
                                                model,
                                                *effort,
                                            ),
                                        ),
                                        None => {
                                            responder.respond_with_error(e)?;
                                            return Ok(());
                                        }
                                    }
                                }
                            };
                            if let Some(notification) = notification {
                                let notification_result = cx.send_notification(notification);
                                if let Err(error) = notification_result.as_ref() {
                                    warn!(
                                        sid = %sid,
                                        config_id = %config_id,
                                        error = ?error,
                                        "failed to send config update after config change"
                                    );
                                }
                                tolerate_committed_notification_failure(
                                    notification_result,
                                    committed_provider_model.is_some(),
                                )?;
                            }
                            responder.respond(SetSessionConfigOptionResponse::new(config_options))?;

                            let maybe_refresh = if let Some(provider_id) = selected_provider_id {
                                agent
                                    .provider_inventory
                                    .plan_refresh_jobs(std::slice::from_ref(&provider_id))
                                    .await
                                    .ok()
                                    .and_then(|plan| {
                                        plan.started
                                            .into_iter()
                                            .find(|job| job.provider_id == provider_id)
                                    })
                            } else {
                                None
                            };
                            if let Some(refresh_job) = maybe_refresh {
                                let agent_bg = agent.clone();
                                let cx_bg = cx.clone();
                                let session_id_bg = session_id.clone();
                                tokio::spawn(async move {
                                    // Keep archive/delete behind the lifecycle barrier until
                                    // every provider/session access in this refresh is finished.
                                    let _session_permit = session_permit;
                                    let refresh_identity = refresh_job.identity;
                                    let refresh_provider_id = refresh_job.provider_id;
                                    let mut refresh_guard =
                                        agent_bg.provider_inventory.refresh_guard(&refresh_identity);
                                    let provider_result: Result<Arc<dyn Provider>> =
                                        AssertUnwindSafe(async {
                                            let session_agent =
                                                agent_bg.get_session_agent(&session_id_bg.0).await?;
                                            let provider = session_agent
                                                .provider()
                                                .await
                                                .map_err(|e| anyhow::anyhow!(e.to_string()))?;
                                            let provider_name = provider.get_name().to_string();
                                            if provider_name != refresh_provider_id {
                                                return Err(anyhow::anyhow!(
                                                    "provider changed before inventory refresh completed"
                                                ));
                                            }
                                            Ok(provider)
                                        })
                                        .catch_unwind()
                                .await
                                .map_err(|_| {
                                    anyhow::anyhow!("provider inventory refresh task panicked")
                                })
                                .and_then(|result| result);

                                let fetch_result = match provider_result {
                                    Ok(provider) => {
                                        match ensure_refresh_identity_current(
                                            &refresh_provider_id,
                                            &refresh_identity,
                                        )
                                        .await
                                        {
                                            Ok(()) => match AssertUnwindSafe(
                                                provider.fetch_recommended_models(
                                                    crate::model_config::global_toolshim(),
                                                ),
                                            )
                                            .catch_unwind()
                                            .await
                                            {
                                                Ok(Ok(models)) => Ok(models),
                                                Ok(Err(error)) => {
                                                    Err(anyhow::anyhow!(error.to_string()))
                                                }
                                                Err(_) => Err(anyhow::anyhow!(
                                                    "provider inventory refresh task panicked"
                                                )),
                                            },
                                            Err(error) => Err(error),
                                        }
                                    }
                                    Err(error) => Err(error),
                                };

                                match fetch_result {
                                    Ok(models) => match agent_bg
                                        .provider_inventory
                                        .store_refreshed_models_for_identity(
                                            &refresh_identity,
                                            &models,
                                        )
                                        .await
                                    {
                                        Ok(()) => {
                                            refresh_guard.complete();
                                            match agent_bg.build_config_update(&session_id_bg).await
                                            {
                                                Ok((fresh_notification, _)) => {
                                                    let _ = cx_bg
                                                        .send_notification(fresh_notification);
                                                }
                                                Err(error) => warn!(
                                                    provider = %refresh_provider_id,
                                                    error = %error,
                                                    "failed to build config update after provider inventory refresh"
                                                ),
                                            }
                                        }
                                        Err(error) => warn!(
                                            provider = %refresh_provider_id,
                                            error = %error,
                                            "failed to store refreshed provider inventory after config change"
                                        ),
                                    },
                                    Err(error) => {
                                        let error_message = error.to_string();
                                        match agent_bg
                                            .provider_inventory
                                            .store_refresh_error_for_identity(
                                                &refresh_identity,
                                                error_message.clone(),
                                            )
                                            .await
                                        {
                                            Ok(()) => refresh_guard.complete(),
                                            Err(store_error) => warn!(
                                                provider = %refresh_provider_id,
                                                error = %store_error,
                                                refresh_error = %error_message,
                                                "failed to store provider inventory refresh error after config change"
                                            ),
                                        }
                                        warn!(
                                            provider = %refresh_provider_id,
                                            error = %error_message,
                                            "provider inventory refresh failed after config change"
                                        );
                                    }
                                }
                                });
                            }

                            debug!(target: "perf", sid = %sid, ms = t_handler.elapsed().as_millis() as u64, config_id = %config_id, "perf: set_config_option done");
                            Ok(())
                        })?;
                        Ok(())
                    }
                })
                .await
                .if_request({
                    let agent = agent.clone();
                    let cx = cx.clone();
                    |req: SetSessionModeRequest, responder: Responder<SetSessionModeResponse>| async move {
                        let cx_spawn = cx.clone();
                        cx.spawn(async move {
                            let cx = cx_spawn;
                            let session_id = req.session_id.clone();
                            let _session_permit = match agent
                                .acquire_session_dispatch_access(&session_id.0, false)
                                .await
                            {
                                Ok(permit) => permit,
                                Err(error) => {
                                    responder.respond_with_error(error)?;
                                    return Ok(());
                                }
                            };
                            let mode_id = req.mode_id.clone();
                            match agent.on_set_mode(&session_id.0, &mode_id.0).await {
                                Ok(resp) => {
                                    // Notify before responding so clients see the mode update before block_task unblocks.
                                    cx.send_notification(SessionNotification::new(
                                        session_id,
                                        SessionUpdate::CurrentModeUpdate(
                                            CurrentModeUpdate::new(mode_id),
                                        ),
                                    ))?;
                                    responder.respond(resp)?;
                                }
                                Err(e) => {
                                    responder.respond_with_error(e)?;
                                }
                            }
                            Ok(())
                        })?;
                        Ok(())
                    }
                })
                .await
                .if_request({
                    let agent = agent.clone();
                    let cx = cx.clone();
                    |req: ListSessionsRequest, responder: Responder<ListSessionsResponse>| async move {
                        cx.spawn(async move {
                            match agent.on_list_sessions(req).await {
                                Ok(response) => responder.respond(response)?,
                                Err(e) => responder.respond_with_error(e)?,
                            }
                            Ok(())
                        })?;
                        Ok(())
                    }
                })
                .await
                .if_request({
                    let agent = agent.clone();
                    let cx = cx.clone();
                    |req: CloseSessionRequest, responder: Responder<CloseSessionResponse>| async move {
                        cx.spawn(async move {
                            match agent.on_close_session(&req.session_id.0).await {
                                Ok(response) => responder.respond(response)?,
                                Err(e) => responder.respond_with_error(e)?,
                            }
                            Ok(())
                        })?;
                        Ok(())
                    }
                })
                .await
                .if_request({
                    let agent = agent.clone();
                    let cx = cx.clone();
                    |req: ForkSessionRequest, responder: Responder<ForkSessionResponse>| async move {
                        let cx_spawn = cx.clone();
                        cx.spawn(async move {
                            responder.respond_with_result(agent.on_fork_session(&cx_spawn, req).await)?;
                            Ok(())
                        })?;
                        Ok(())
                    }
                })
                .await
                .otherwise({
                    let agent = agent.clone();
                    let cx = cx.clone();
                    |message: Dispatch| async move {
                        match message {
                            Dispatch::Request(req, responder) => {
                                cx.spawn(async move {
                                    match agent.dispatch_custom_request(&req.method, req.params).await {
                                        Ok(json) => responder.respond(json)?,
                                        Err(e) => responder.respond_with_error(e)?,
                                    }
                                    Ok(())
                                })?;
                                Ok(())
                            }
                            Dispatch::Response(result, router) => {
                                debug!(method = %router.method(), id = %router.id(), ok = result.is_ok(), "routing response");
                                router.respond_with_result(result)?;
                                Ok(())
                            }
                            Dispatch::Notification(notif) => {
                                debug!(method = %notif.method, "unhandled notification");
                                Ok(())
                            }
                        }
                    }
                })
                .await
                .map(|()| Handled::Yes)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn committed_provider_model_fallback_reports_committed_values() {
        let options = committed_provider_model_config_options(
            "anthropic",
            "claude-sonnet-4-5",
            Some(goose_providers::thinking::ThinkingEffort::High),
        );

        let current_value = |option: &SessionConfigOption| match &option.kind {
            agent_client_protocol::schema::v1::SessionConfigKind::Select(select) => {
                select.current_value.0.to_string()
            }
            _ => panic!("expected select option"),
        };
        assert_eq!(current_value(&options[0]), "anthropic");
        assert_eq!(current_value(&options[1]), "claude-sonnet-4-5");
        assert_eq!(current_value(&options[2]), "high");
    }

    #[test]
    fn committed_provider_model_ignores_notification_transport_failure() {
        let result = tolerate_committed_notification_failure::<&str>(Err("send failed"), true);
        assert_eq!(result, Ok(()));

        let uncommitted =
            tolerate_committed_notification_failure::<&str>(Err("send failed"), false);
        assert_eq!(uncommitted, Err("send failed"));
    }

    #[test]
    fn r4_core5_background_provider_refresh_owns_the_session_lease() {
        let source = include_str!("dispatch.rs").replace("\r\n", "\n");
        let set_config = source
            .split_once("|req: SetSessionConfigOptionRequest")
            .and_then(|(_, tail)| {
                tail.split_once("|req: SetSessionModeRequest")
                    .map(|(body, _)| body)
            })
            .expect("set-config dispatch boundary");
        let spawn = set_config
            .split_once("tokio::spawn(async move {")
            .map(|(_, body)| body)
            .expect("provider refresh spawn");

        assert!(set_config.contains("let session_permit = match agent"));
        assert!(spawn.contains("let _session_permit = session_permit;"));
        let permit = spawn
            .find("let _session_permit = session_permit;")
            .expect("session permit capture");
        assert!(permit < spawn.find("get_session_agent").expect("session access"));
        assert!(
            permit
                < spawn
                    .find("fetch_recommended_models")
                    .expect("provider access")
        );
    }
}
