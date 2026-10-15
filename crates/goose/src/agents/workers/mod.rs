mod handle;
mod process_tracker;
mod process_tree;
mod registry;

pub use handle::WorkerHandle;
pub(crate) use process_tracker::{worker_process_tracker, ScopedProcessTracker};
pub use process_tree::{
    ProcessTreeError, ProcessTreeStop, ProcessTreeStopOutcome, ProcessTreeTerminator,
    SystemProcessGroupOwner, SystemProcessTreeTerminator,
};
pub use registry::{
    OutcomeAdmission, OutcomeClaim, OutcomeSuppression, RegistryError, WorkerRegistry,
    WorkerRuntimeState, WorkerStopSnapshot, WorkerTerminalState,
};
