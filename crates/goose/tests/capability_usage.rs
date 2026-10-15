use goose::capability_usage::{CapabilityUsageEvent, CapabilityUsageKind, CapabilityUsageStore};
use tempfile::tempdir;

#[test]
fn successful_events_are_persisted_and_idempotent() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("capability-usage-v1.json");
    let store = CapabilityUsageStore::new(path.clone());
    let event = CapabilityUsageEvent {
        event_id: "session-1:tool-call-1".to_string(),
        kind: CapabilityUsageKind::External,
        capability_id: "filesystem".to_string(),
        recent_result: "read_file succeeded".to_string(),
        reference: Some("external:filesystem".to_string()),
    };

    assert!(store.record_success(event.clone()).unwrap());
    assert!(!store.record_success(event).unwrap());

    let entries = CapabilityUsageStore::new(path).list().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].success_count, 1);
    assert_eq!(entries[0].capability_id, "filesystem");
    assert_eq!(entries[0].recent_result, "read_file succeeded");
    assert!(entries[0].last_success_at.ends_with('Z'));
}

#[test]
fn distinct_successes_increment_without_storing_private_inputs() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("capability-usage-v1.json");
    let store = CapabilityUsageStore::new(path.clone());

    for event_id in ["event-1", "event-2"] {
        store
            .record_success(CapabilityUsageEvent {
                event_id: event_id.to_string(),
                kind: CapabilityUsageKind::Skill,
                capability_id: "release-check".to_string(),
                recent_result: "loaded".to_string(),
                reference: None,
            })
            .unwrap();
    }

    assert_eq!(store.list().unwrap()[0].success_count, 2);
    let persisted = std::fs::read_to_string(path).unwrap();
    assert!(!persisted.contains("prompt"));
    assert!(!persisted.contains("arguments"));
    assert!(!persisted.contains("C:\\\\Users\\\\private"));
}

#[test]
fn corrupt_usage_data_is_reported_without_being_rewritten() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("capability-usage-v1.json");
    std::fs::write(&path, "not-json").unwrap();

    let error = CapabilityUsageStore::new(path.clone()).list().unwrap_err();
    assert!(error.to_string().contains("capability usage"));
    assert_eq!(std::fs::read_to_string(path).unwrap(), "not-json");
}
