use super::WorkerHandle;
use crate::agents::control_plane::CodeProRuntime;
use crate::session::{SessionManager, SessionProcessTracker};
use std::sync::Arc;

pub(crate) fn worker_process_tracker(
    runtime: CodeProRuntime,
    handle: WorkerHandle,
) -> Arc<dyn SessionProcessTracker> {
    Arc::new(RuntimeWorkerProcessTracker { runtime, handle })
}

struct RuntimeWorkerProcessTracker {
    runtime: CodeProRuntime,
    handle: WorkerHandle,
}

impl SessionProcessTracker for RuntimeWorkerProcessTracker {
    fn register_process(&self, process_id: u32) -> std::result::Result<(), String> {
        self.runtime
            .register_worker_process(&self.handle, process_id)
            .map_err(|error| error.to_string())
    }

    fn unregister_process(&self, process_id: u32) -> std::result::Result<(), String> {
        self.runtime
            .unregister_worker_process(&self.handle, process_id)
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    fn register_process_owner(
        &self,
        process_id: u32,
        owner: Arc<dyn crate::session::SessionProcessOwner>,
    ) -> std::result::Result<(), String> {
        self.runtime
            .register_worker_process_owner(&self.handle, process_id, owner)
            .map_err(|error| error.to_string())
    }

    fn terminate_process_owner(&self, process_id: u32) -> std::result::Result<bool, String> {
        let owner = self
            .runtime
            .worker_process_owner(&self.handle, process_id)
            .map_err(|error| error.to_string())?;
        let Some(owner) = owner else {
            return Ok(false);
        };
        owner.terminate()?;
        Ok(true)
    }
}

pub(crate) struct ScopedProcessTracker {
    session_manager: Arc<SessionManager>,
    session_id: String,
    tracker: Arc<dyn SessionProcessTracker>,
}

impl ScopedProcessTracker {
    pub(crate) fn bind(
        session_manager: Arc<SessionManager>,
        session_id: String,
        tracker: Arc<dyn SessionProcessTracker>,
    ) -> Result<Self, String> {
        session_manager.bind_process_tracker(&session_id, tracker.clone())?;
        Ok(Self {
            session_manager,
            session_id,
            tracker,
        })
    }
}

impl Drop for ScopedProcessTracker {
    fn drop(&mut self) {
        self.session_manager
            .unbind_process_tracker(&self.session_id, &self.tracker);
    }
}
