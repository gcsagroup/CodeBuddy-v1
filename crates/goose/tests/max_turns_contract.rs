use goose::config::MaxTurns;

#[test]
fn max_turns_accepts_only_the_canonical_range() {
    assert_eq!("1".parse::<MaxTurns>().unwrap().get(), 1);
    assert_eq!("10000".parse::<MaxTurns>().unwrap().get(), 10_000);

    for invalid in ["0", "10001", "1.5", "NaN", ""] {
        assert!(invalid.parse::<MaxTurns>().is_err(), "accepted {invalid:?}");
    }
}

#[test]
fn max_turns_deserialization_rejects_untyped_values() {
    assert!(serde_json::from_str::<MaxTurns>("25").is_ok());
    assert!(serde_json::from_str::<MaxTurns>("0").is_err());
    assert!(serde_json::from_str::<MaxTurns>("10001").is_err());
    assert!(serde_json::from_str::<MaxTurns>("1.5").is_err());
    assert!(serde_json::from_str::<MaxTurns>(r#"\"25\""#).is_err());
}
