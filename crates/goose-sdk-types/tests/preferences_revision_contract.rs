use goose_sdk_types::custom_requests::{
    PreferenceKey, PreferencesReadResponse, PreferencesRemoveRequest, PreferencesSaveRequest,
};
use serde_json::json;

#[test]
fn preference_mutations_require_and_preserve_expected_revision() {
    assert!(serde_json::from_value::<PreferencesSaveRequest>(json!({
        "values": []
    }))
    .is_err());
    let save = serde_json::from_value::<PreferencesSaveRequest>(json!({
        "expectedRevision": 7,
        "values": []
    }))
    .expect("save request with an expected revision must deserialize");
    assert_eq!(serde_json::to_value(save).unwrap()["expectedRevision"], 7);

    assert!(serde_json::from_value::<PreferencesRemoveRequest>(json!({
        "keys": []
    }))
    .is_err());
    let remove = serde_json::from_value::<PreferencesRemoveRequest>(json!({
        "expectedRevision": 11,
        "keys": []
    }))
    .expect("remove request with an expected revision must deserialize");
    assert_eq!(
        serde_json::to_value(remove).unwrap()["expectedRevision"],
        11
    );
}

#[test]
fn preference_reads_require_and_preserve_the_authoritative_revision() {
    assert!(serde_json::from_value::<PreferencesReadResponse>(json!({
        "values": []
    }))
    .is_err());
    let response = serde_json::from_value::<PreferencesReadResponse>(json!({
        "revision": 13,
        "values": []
    }))
    .expect("read response with a revision must deserialize");
    assert_eq!(serde_json::to_value(response).unwrap()["revision"], 13);
}

#[test]
fn preference_read_values_require_server_owned_mutability() {
    assert!(serde_json::from_value::<PreferencesReadResponse>(json!({
        "revision": 13,
        "values": [{ "key": "gooseMaxTurns", "value": 640 }]
    }))
    .is_err());

    let response = serde_json::from_value::<PreferencesReadResponse>(json!({
        "revision": 13,
        "values": [
            { "key": "gooseMode", "value": "smart_approve", "isMutable": false },
            { "key": "gooseMaxTurns", "value": null, "isMutable": true }
        ]
    }))
    .expect("read values must carry server-owned mutability");
    assert_eq!(
        serde_json::to_value(response).unwrap()["values"],
        json!([
            { "key": "gooseMode", "value": "smart_approve", "isMutable": false },
            { "key": "gooseMaxTurns", "value": null, "isMutable": true }
        ])
    );
}

#[test]
fn preference_save_values_do_not_model_or_serialize_mutability_as_authority() {
    let save = serde_json::from_value::<PreferencesSaveRequest>(json!({
        "expectedRevision": 2,
        "values": [{
            "key": "gooseMode",
            "value": "approve",
            "isMutable": false
        }]
    }))
    .expect("mutation values preserve the existing key/value wire shape");
    let encoded = serde_json::to_value(save).unwrap();
    assert_eq!(
        encoded["values"][0],
        json!({
            "key": "gooseMode",
            "value": "approve"
        })
    );
}

#[test]
fn maximum_turns_is_an_allowlisted_preference_key() {
    let key = serde_json::from_value::<PreferenceKey>(json!("gooseMaxTurns"))
        .expect("gooseMaxTurns must be represented by the typed preferences contract");
    assert_eq!(serde_json::to_value(key).unwrap(), json!("gooseMaxTurns"));
}

#[test]
fn goose_mode_is_an_allowlisted_four_value_preference() {
    for mode in ["auto", "approve", "smart_approve", "chat"] {
        let key = serde_json::from_value::<PreferenceKey>(json!("gooseMode"))
            .expect("gooseMode must be represented by the typed preferences contract");
        assert_eq!(serde_json::to_value(key).unwrap(), json!("gooseMode"));

        let save = serde_json::from_value::<PreferencesSaveRequest>(json!({
            "expectedRevision": 0,
            "values": [{ "key": "gooseMode", "value": mode }]
        }))
        .expect("all GooseMode values must retain the mutation wire shape");
        assert_eq!(
            serde_json::to_value(save).unwrap()["values"][0]["value"],
            mode
        );
    }
}
