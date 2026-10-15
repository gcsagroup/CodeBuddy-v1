use serde::{Deserialize, Serialize};
use std::fmt;

#[cfg(any(feature = "system-keyring", test))]
pub(crate) const MAX_STORED_CREDENTIAL_BYTES: usize = 2048;
const CREDENTIAL_SCHEMA_VERSION: u8 = 1;
#[cfg(feature = "system-keyring")]
// Stable secure-storage identifier for existing logins, not a display name.
const KEYRING_SERVICE: &str = "CodeAgentPro_GitHub";
#[cfg(feature = "system-keyring")]
const KEYRING_ACCOUNT: &str = "oauth-user-token";

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StoredGitHubCredentialV1 {
    pub(crate) schema_version: u8,
    pub(crate) account_login: String,
    pub(crate) account_id: u64,
    pub(crate) access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) refresh_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) access_token_expires_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) refresh_token_expires_at: Option<String>,
}

impl fmt::Debug for StoredGitHubCredentialV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StoredGitHubCredentialV1")
            .field("schema_version", &self.schema_version)
            .field("account_login", &self.account_login)
            .field("account_id", &self.account_id)
            .field("access_token", &"<redacted>")
            .field(
                "refresh_token",
                &self.refresh_token.as_ref().map(|_| "<redacted>"),
            )
            .field("access_token_expires_at", &self.access_token_expires_at)
            .field("refresh_token_expires_at", &self.refresh_token_expires_at)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum GitHubAuthError {
    #[error("Secure credential storage is unavailable")]
    SecureStorageUnavailable,
    #[error("Stored GitHub credential is invalid")]
    InvalidStoredCredential,
    #[cfg(any(feature = "system-keyring", test))]
    #[error("GitHub credential exceeds the secure storage size limit")]
    CredentialTooLarge,
}

impl GitHubAuthError {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::SecureStorageUnavailable => "secure_storage_unavailable",
            Self::InvalidStoredCredential => "invalid_stored_credential",
            #[cfg(any(feature = "system-keyring", test))]
            Self::CredentialTooLarge => "credential_too_large",
        }
    }
}

pub(crate) trait GitHubCredentialStore: Send + Sync {
    fn load(&self) -> Result<Option<StoredGitHubCredentialV1>, GitHubAuthError>;
    fn save(&self, credential: &StoredGitHubCredentialV1) -> Result<(), GitHubAuthError>;
    fn delete(&self) -> Result<(), GitHubAuthError>;
}

fn valid_token(value: &str) -> bool {
    !value.is_empty() && value.len() <= 1024 && !value.chars().any(char::is_control)
}

fn valid_timestamp(value: &Option<String>) -> bool {
    value
        .as_deref()
        .map(|value| chrono::DateTime::parse_from_rfc3339(value).is_ok())
        .unwrap_or(true)
}

fn validate_credential(credential: &StoredGitHubCredentialV1) -> Result<(), GitHubAuthError> {
    if credential.schema_version != CREDENTIAL_SCHEMA_VERSION
        || credential.account_login.is_empty()
        || credential.account_login.len() > 128
        || credential.account_login.chars().any(char::is_control)
        || credential.account_id == 0
        || !valid_token(&credential.access_token)
        || credential
            .refresh_token
            .as_deref()
            .is_some_and(|token| !valid_token(token))
        || !valid_timestamp(&credential.access_token_expires_at)
        || !valid_timestamp(&credential.refresh_token_expires_at)
    {
        return Err(GitHubAuthError::InvalidStoredCredential);
    }
    Ok(())
}

#[cfg(any(feature = "system-keyring", test))]
pub(crate) fn encode_credential(
    credential: &StoredGitHubCredentialV1,
) -> Result<String, GitHubAuthError> {
    validate_credential(credential)?;
    let encoded =
        serde_json::to_string(credential).map_err(|_| GitHubAuthError::InvalidStoredCredential)?;
    if encoded.len() > MAX_STORED_CREDENTIAL_BYTES {
        return Err(GitHubAuthError::CredentialTooLarge);
    }
    Ok(encoded)
}

#[cfg(any(feature = "system-keyring", test))]
pub(crate) fn decode_credential(
    encoded: &str,
) -> Result<StoredGitHubCredentialV1, GitHubAuthError> {
    if encoded.len() > MAX_STORED_CREDENTIAL_BYTES {
        return Err(GitHubAuthError::CredentialTooLarge);
    }
    let credential = serde_json::from_str::<StoredGitHubCredentialV1>(encoded)
        .map_err(|_| GitHubAuthError::InvalidStoredCredential)?;
    validate_credential(&credential)?;
    Ok(credential)
}

pub(crate) struct SystemGitHubCredentialStore;

#[cfg(feature = "system-keyring")]
impl SystemGitHubCredentialStore {
    fn entry() -> Result<keyring::Entry, GitHubAuthError> {
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
            .map_err(|_| GitHubAuthError::SecureStorageUnavailable)
    }
}

impl GitHubCredentialStore for SystemGitHubCredentialStore {
    fn load(&self) -> Result<Option<StoredGitHubCredentialV1>, GitHubAuthError> {
        #[cfg(feature = "system-keyring")]
        {
            match Self::entry()?.get_password() {
                Ok(encoded) => decode_credential(&encoded).map(Some),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(_) => Err(GitHubAuthError::SecureStorageUnavailable),
            }
        }
        #[cfg(not(feature = "system-keyring"))]
        {
            Err(GitHubAuthError::SecureStorageUnavailable)
        }
    }

    fn save(&self, credential: &StoredGitHubCredentialV1) -> Result<(), GitHubAuthError> {
        validate_credential(credential)?;
        #[cfg(feature = "system-keyring")]
        {
            let encoded = encode_credential(credential)?;
            Self::entry()?
                .set_password(&encoded)
                .map_err(|_| GitHubAuthError::SecureStorageUnavailable)
        }
        #[cfg(not(feature = "system-keyring"))]
        {
            let _ = credential;
            Err(GitHubAuthError::SecureStorageUnavailable)
        }
    }

    fn delete(&self) -> Result<(), GitHubAuthError> {
        #[cfg(feature = "system-keyring")]
        {
            match Self::entry()?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(_) => Err(GitHubAuthError::SecureStorageUnavailable),
            }
        }
        #[cfg(not(feature = "system-keyring"))]
        {
            Err(GitHubAuthError::SecureStorageUnavailable)
        }
    }
}

#[cfg(test)]
pub(crate) struct UnavailableGitHubCredentialStore;

#[cfg(test)]
impl GitHubCredentialStore for UnavailableGitHubCredentialStore {
    fn load(&self) -> Result<Option<StoredGitHubCredentialV1>, GitHubAuthError> {
        Err(GitHubAuthError::SecureStorageUnavailable)
    }

    fn save(&self, _credential: &StoredGitHubCredentialV1) -> Result<(), GitHubAuthError> {
        Err(GitHubAuthError::SecureStorageUnavailable)
    }

    fn delete(&self) -> Result<(), GitHubAuthError> {
        Err(GitHubAuthError::SecureStorageUnavailable)
    }
}

#[cfg(test)]
#[derive(Default)]
pub(crate) struct MemoryGitHubCredentialStore {
    credential: std::sync::Mutex<Option<StoredGitHubCredentialV1>>,
}

#[cfg(test)]
impl GitHubCredentialStore for MemoryGitHubCredentialStore {
    fn load(&self) -> Result<Option<StoredGitHubCredentialV1>, GitHubAuthError> {
        Ok(self.credential.lock().unwrap().clone())
    }

    fn save(&self, credential: &StoredGitHubCredentialV1) -> Result<(), GitHubAuthError> {
        encode_credential(credential)?;
        *self.credential.lock().unwrap() = Some(credential.clone());
        Ok(())
    }

    fn delete(&self) -> Result<(), GitHubAuthError> {
        *self.credential.lock().unwrap() = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ACCESS_TOKEN: &str = "ghu_test_access_secret_123";
    const REFRESH_TOKEN: &str = "ghr_test_refresh_secret_456";

    fn credential(access_token: &str) -> StoredGitHubCredentialV1 {
        StoredGitHubCredentialV1 {
            schema_version: 1,
            account_login: "octocat".to_string(),
            account_id: 1,
            access_token: access_token.to_string(),
            refresh_token: Some(REFRESH_TOKEN.to_string()),
            access_token_expires_at: Some("2026-08-05T07:00:00Z".to_string()),
            refresh_token_expires_at: Some("2027-02-04T23:00:00Z".to_string()),
        }
    }

    #[test]
    fn credential_round_trip_is_versioned_and_bounded() {
        let original = credential(ACCESS_TOKEN);
        let encoded = encode_credential(&original).expect("credential should encode");
        let debug = format!("{original:?}");

        assert!(encoded.len() <= MAX_STORED_CREDENTIAL_BYTES);
        assert!(encoded.contains("\"schemaVersion\":1"));
        assert!(!debug.contains(ACCESS_TOKEN));
        assert!(!debug.contains(REFRESH_TOKEN));
        assert_eq!(decode_credential(&encoded).unwrap(), original);
    }

    #[test]
    fn system_store_is_a_zero_configuration_backend() {
        let _store = SystemGitHubCredentialStore;
    }

    #[test]
    fn system_store_rejects_invalid_credentials_before_reporting_storage_unavailable() {
        let store = SystemGitHubCredentialStore;
        let mut invalid = credential(ACCESS_TOKEN);
        invalid.account_id = 0;

        let error = match store.save(&invalid) {
            Ok(()) => panic!("invalid credential must not be saved"),
            Err(error) => error,
        };

        assert_eq!(error.code(), "invalid_stored_credential");
        assert!(!error.to_string().contains(ACCESS_TOKEN));
    }

    #[test]
    fn oversized_or_unknown_credentials_are_rejected_without_secret_echo() {
        let mut oversized = credential(&"s".repeat(1024));
        oversized.refresh_token = Some("r".repeat(1024));
        let error = encode_credential(&oversized).unwrap_err();
        assert_eq!(error.code(), "credential_too_large");
        assert!(!error.to_string().contains(&oversized.access_token));

        let error = decode_credential(r#"{"schemaVersion":2}"#).unwrap_err();
        assert_eq!(error.code(), "invalid_stored_credential");
        assert!(!error.to_string().contains("schemaVersion"));
    }

    #[test]
    fn in_memory_store_has_idempotent_load_save_delete_semantics() {
        let store = MemoryGitHubCredentialStore::default();
        assert_eq!(store.load().unwrap(), None);

        let expected = credential(ACCESS_TOKEN);
        store.save(&expected).unwrap();
        assert_eq!(store.load().unwrap(), Some(expected));

        store.delete().unwrap();
        store.delete().unwrap();
        assert_eq!(store.load().unwrap(), None);
    }

    #[test]
    fn unavailable_store_fails_closed_for_every_operation() {
        let store = UnavailableGitHubCredentialStore;
        let expected = credential(ACCESS_TOKEN);

        for error in [
            store.load().unwrap_err(),
            store.save(&expected).unwrap_err(),
            store.delete().unwrap_err(),
        ] {
            assert_eq!(error.code(), "secure_storage_unavailable");
            assert!(!error.to_string().contains(ACCESS_TOKEN));
            assert!(!error.to_string().contains(REFRESH_TOKEN));
            assert!(!error.to_string().contains("secrets.yaml"));
        }
    }
}
