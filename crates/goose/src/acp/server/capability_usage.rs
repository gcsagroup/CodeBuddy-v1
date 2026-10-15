use super::*;
use crate::capability_usage::{
    CapabilityUsageEvent, CapabilityUsageKind as StoredKind, CAPABILITY_USAGE,
};

impl GooseAcpAgent {
    pub(super) async fn on_list_capability_usage(
        &self,
        _req: CapabilityUsageListRequest,
    ) -> Result<CapabilityUsageListResponse, agent_client_protocol::Error> {
        match CAPABILITY_USAGE.list() {
            Ok(records) => Ok(CapabilityUsageListResponse {
                records: records
                    .into_iter()
                    .map(|record| CapabilityUsageRecord {
                        kind: match record.kind {
                            StoredKind::Skill => CapabilityUsageKind::Skill,
                            StoredKind::External => CapabilityUsageKind::External,
                            StoredKind::App => CapabilityUsageKind::App,
                            StoredKind::CommonTask => CapabilityUsageKind::CommonTask,
                            StoredKind::AutomaticTask => CapabilityUsageKind::AutomaticTask,
                        },
                        capability_id: record.capability_id,
                        last_success_at: record.last_success_at,
                        success_count: record.success_count,
                        recent_result: record.recent_result,
                        reference: record.reference,
                    })
                    .collect(),
                warning: None,
            }),
            Err(error) => Ok(CapabilityUsageListResponse {
                records: Vec::new(),
                warning: Some(error.to_string()),
            }),
        }
    }

    pub(super) async fn on_record_capability_usage(
        &self,
        req: CapabilityUsageRecordRequest,
    ) -> Result<CapabilityUsageRecordResponse, agent_client_protocol::Error> {
        let kind = match req.kind {
            CapabilityUsageKind::Skill => StoredKind::Skill,
            CapabilityUsageKind::External => StoredKind::External,
            CapabilityUsageKind::App => StoredKind::App,
            CapabilityUsageKind::CommonTask => StoredKind::CommonTask,
            CapabilityUsageKind::AutomaticTask => StoredKind::AutomaticTask,
        };
        let recorded = CAPABILITY_USAGE
            .record_success(CapabilityUsageEvent {
                event_id: req.event_id,
                kind,
                capability_id: req.capability_id,
                recent_result: req.recent_result,
                reference: req.reference,
            })
            .map_err(|error| {
                agent_client_protocol::Error::invalid_params().data(error.to_string())
            })?;
        Ok(CapabilityUsageRecordResponse { recorded })
    }
}
