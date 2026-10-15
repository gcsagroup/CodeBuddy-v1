use super::{
    terminal_state_after_restart, ReviewError, ReviewFreshness, ReviewResult, ReviewSnapshot,
    ReviewStatus, REVIEW_SCHEMA_VERSION,
};
use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StoredReview {
    pub session_id: String,
    pub request_id: String,
    pub snapshot: ReviewSnapshot,
    pub result: ReviewResult,
}

pub(super) enum Reservation {
    Existing(Box<ReviewResult>),
    Created(Box<StoredReview>),
}

#[derive(Clone)]
pub(super) struct ReviewStore {
    root: PathBuf,
    lock: Arc<Mutex<()>>,
}

impl ReviewStore {
    pub fn open(data_root: &Path) -> Result<Self> {
        ensure!(
            data_root.is_absolute(),
            "review_store_absolute_path_required"
        );
        let root = data_root.join("reviews");
        std::fs::create_dir_all(&root)?;
        Ok(Self {
            root,
            lock: Arc::new(Mutex::new(())),
        })
    }

    pub async fn recover_interrupted(&self) -> Result<()> {
        let _guard = self.lock.lock().await;
        for record in self.latest_across_sessions()? {
            let recovered = terminal_state_after_restart(record.result.status);
            if recovered != record.result.status {
                let mut next = record;
                next.result.status = recovered;
                next.result.revision += 1;
                next.result.updated_at = chrono::Utc::now().to_rfc3339();
                next.result.error = Some(ReviewError {
                    code: "review_interrupted".into(),
                    message: "The host stopped before the review completed.".into(),
                });
                self.write(&next)?;
            }
        }
        Ok(())
    }

    pub async fn recover_interrupted_for_session(&self, session_id: &str) -> Result<()> {
        let _guard = self.lock.lock().await;
        for mut record in self.latest_for_session(session_id)?.into_values() {
            let recovered = terminal_state_after_restart(record.result.status);
            if recovered != record.result.status {
                record.result.status = recovered;
                record.result.revision += 1;
                record.result.updated_at = chrono::Utc::now().to_rfc3339();
                record.result.error = Some(ReviewError {
                    code: "review_interrupted".into(),
                    message: "The host stopped before the review completed.".into(),
                });
                self.write(&record)?;
            }
        }
        Ok(())
    }

    pub async fn reserve(
        &self,
        session_id: &str,
        request_id: &str,
        snapshot: ReviewSnapshot,
        result: ReviewResult,
    ) -> Result<Reservation> {
        let _guard = self.lock.lock().await;
        let latest = self.latest_for_session(session_id)?;
        if let Some(existing) = latest
            .values()
            .find(|record| record.request_id == request_id)
        {
            ensure!(existing.snapshot == snapshot, "review_request_id_conflict");
            return Ok(Reservation::Existing(Box::new(existing.result.clone())));
        }
        ensure!(
            !latest
                .values()
                .any(|record| record.result.status == ReviewStatus::Running),
            "review_already_running"
        );
        let record = StoredReview {
            session_id: session_id.to_owned(),
            request_id: request_id.to_owned(),
            snapshot,
            result,
        };
        self.write(&record)?;
        Ok(Reservation::Created(Box::new(record)))
    }

    pub async fn get(&self, session_id: &str, review_id: &str) -> Result<StoredReview> {
        let _guard = self.lock.lock().await;
        self.latest_for_session(session_id)?
            .remove(review_id)
            .ok_or_else(|| anyhow::anyhow!("review_not_found"))
    }

    pub async fn update_if_running(
        &self,
        session_id: &str,
        review_id: &str,
        update: impl FnOnce(&mut ReviewResult),
    ) -> Result<ReviewResult> {
        let _guard = self.lock.lock().await;
        let mut record = self
            .latest_for_session(session_id)?
            .remove(review_id)
            .ok_or_else(|| anyhow::anyhow!("review_not_found"))?;
        if record.result.status != ReviewStatus::Running {
            return Ok(record.result);
        }
        update(&mut record.result);
        record.result.revision += 1;
        record.result.updated_at = chrono::Utc::now().to_rfc3339();
        self.write(&record)?;
        Ok(record.result)
    }

    pub async fn set_freshness(
        &self,
        session_id: &str,
        review_id: &str,
        freshness: ReviewFreshness,
    ) -> Result<ReviewResult> {
        let _guard = self.lock.lock().await;
        let mut record = self
            .latest_for_session(session_id)?
            .remove(review_id)
            .ok_or_else(|| anyhow::anyhow!("review_not_found"))?;
        if record.result.freshness == freshness {
            return Ok(record.result);
        }
        record.result.freshness = freshness;
        record.result.revision += 1;
        record.result.updated_at = chrono::Utc::now().to_rfc3339();
        self.write(&record)?;
        Ok(record.result)
    }

    pub async fn delete_session(&self, session_id: &str) -> Result<()> {
        let _guard = self.lock.lock().await;
        match std::fs::remove_dir_all(self.session_dir(session_id)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    fn latest_across_sessions(&self) -> Result<Vec<StoredReview>> {
        let mut latest = HashMap::<(String, String), StoredReview>::new();
        for entry in std::fs::read_dir(&self.root)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            for record in self.read_directory(&entry.path())? {
                let key = (record.session_id.clone(), record.result.review_id.clone());
                match latest.get(&key) {
                    Some(current) if current.result.revision >= record.result.revision => {}
                    _ => {
                        latest.insert(key, record);
                    }
                }
            }
        }
        Ok(latest.into_values().collect())
    }

    fn latest_for_session(&self, session_id: &str) -> Result<HashMap<String, StoredReview>> {
        let mut latest = HashMap::<String, StoredReview>::new();
        for record in self.read_directory(&self.session_dir(session_id))? {
            let key = record.result.review_id.clone();
            match latest.get(&key) {
                Some(current) if current.result.revision >= record.result.revision => {}
                _ => {
                    latest.insert(key, record);
                }
            }
        }
        Ok(latest)
    }

    fn read_directory(&self, directory: &Path) -> Result<Vec<StoredReview>> {
        if !directory.exists() {
            return Ok(Vec::new());
        }
        let mut records = Vec::new();
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            if !entry.file_type()?.is_file()
                || entry.path().extension().and_then(|value| value.to_str()) != Some("json")
            {
                continue;
            }
            let bytes = std::fs::read(entry.path())?;
            let record: StoredReview = serde_json::from_slice(&bytes)
                .with_context(|| format!("invalid review record {}", entry.path().display()))?;
            ensure!(
                record.result.schema_version == REVIEW_SCHEMA_VERSION
                    && record.snapshot.schema_version == REVIEW_SCHEMA_VERSION,
                "unsupported_review_schema"
            );
            records.push(record);
        }
        Ok(records)
    }

    fn write(&self, record: &StoredReview) -> Result<()> {
        let directory = self.session_dir(&record.session_id);
        std::fs::create_dir_all(&directory)?;
        let destination = directory.join(format!(
            "{}.{:020}.json",
            record.result.review_id, record.result.revision
        ));
        if destination.exists() {
            bail!("review_revision_exists");
        }
        let mut temporary = tempfile::NamedTempFile::new_in(&directory)?;
        serde_json::to_writer(&mut temporary, record)?;
        temporary.write_all(b"\n")?;
        temporary.as_file_mut().sync_all()?;
        temporary
            .persist(&destination)
            .map_err(|error| error.error)?;
        Ok(())
    }

    fn session_dir(&self, session_id: &str) -> PathBuf {
        let digest = Sha256::digest(session_id.as_bytes());
        let directory = digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        self.root.join(directory)
    }
}
