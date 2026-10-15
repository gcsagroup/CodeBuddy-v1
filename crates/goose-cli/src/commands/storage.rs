use anyhow::{Context, Result};
use clap::Subcommand;
use goose::config::codebuddy_paths::CodeBuddyPaths;
use goose::config::storage_migration::{
    discover_legacy_sources, plan_migration, LegacyDiscoveryEnv, MigrationReportStatus,
    StorageMigrationReport, StorageMigrator,
};
use std::env;
use std::io::Write;
use std::path::PathBuf;

#[derive(Debug, Subcommand)]
pub enum StorageCommand {
    /// Inspect legacy data without changing it
    Preflight {
        /// Emit a stable machine-readable report
        #[arg(long)]
        json: bool,
    },
    /// Migrate legacy data into the unified .CodeBuddy root
    Migrate {
        /// Emit a stable machine-readable report
        #[arg(long)]
        json: bool,
    },
    /// Show the last migration state
    Status {
        /// Emit a stable machine-readable report
        #[arg(long)]
        json: bool,
    },
}

pub async fn handle_storage_command(command: StorageCommand) -> Result<()> {
    let json = command_requests_json(&command);
    let (report, exit_code) = run_storage_command(command).await?;
    print_report(&report, json)?;
    if exit_code != 0 {
        std::io::stdout().flush()?;
        std::process::exit(exit_code);
    }
    Ok(())
}

pub async fn run_storage_command(command: StorageCommand) -> Result<(StorageMigrationReport, i32)> {
    let (paths, discovery) = resolve_environment()?;
    let migrator = StorageMigrator::new(paths.clone());
    let current = migrator.status_report()?;

    let report = match command {
        StorageCommand::Status { .. } => current,
        StorageCommand::Preflight { .. } if current.status == MigrationReportStatus::Committed => {
            current
        }
        StorageCommand::Preflight { .. } => {
            if let Some(plan) = migrator.pending_plan()? {
                migrator.preflight(&plan)?
            } else {
                let sources = discover_legacy_sources(&paths, &discovery)?;
                if sources.is_empty() {
                    migrator.not_required_report()
                } else {
                    migrator.preflight(&plan_migration(&paths, &sources)?)?
                }
            }
        }
        StorageCommand::Migrate { .. } if current.status == MigrationReportStatus::Committed => {
            current
        }
        StorageCommand::Migrate { .. } => {
            if let Some(plan) = migrator.pending_plan()? {
                migrator.execute(&plan).await?
            } else {
                let sources = discover_legacy_sources(&paths, &discovery)?;
                if sources.is_empty() {
                    migrator.not_required_report()
                } else {
                    let plan = plan_migration(&paths, &sources)?;
                    let preflight = migrator.preflight(&plan)?;
                    if preflight.status == MigrationReportStatus::MigrationRequired {
                        migrator.execute(&plan).await?
                    } else {
                        preflight
                    }
                }
            }
        }
    };
    let exit_code = exit_code_for_status(report.status);
    Ok((report, exit_code))
}

pub fn exit_code_for_status(status: MigrationReportStatus) -> i32 {
    match status {
        MigrationReportStatus::NoRecord
        | MigrationReportStatus::NotRequired
        | MigrationReportStatus::Committed => 0,
        MigrationReportStatus::MigrationRequired
        | MigrationReportStatus::Conflict
        | MigrationReportStatus::InsufficientSpace
        | MigrationReportStatus::Failed => 2,
    }
}

fn command_requests_json(command: &StorageCommand) -> bool {
    match command {
        StorageCommand::Preflight { json }
        | StorageCommand::Migrate { json }
        | StorageCommand::Status { json } => *json,
    }
}

fn print_report(report: &StorageMigrationReport, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(report)?);
    } else {
        println!(
            "Storage migration: {:?} (target: {}, files: {}, bytes: {}, conflicts: {})",
            report.status,
            report.target_root.display(),
            report.copied_files,
            report.copied_bytes,
            report.conflicts
        );
        if report.status == MigrationReportStatus::NoRecord {
            println!(
                "No persisted migration record exists. Run `goose storage preflight` for a live discovery result."
            );
        }
        if let Some(path) = &report.report_path {
            println!("Report: {}", path.display());
        }
    }
    Ok(())
}

fn resolve_environment() -> Result<(CodeBuddyPaths, LegacyDiscoveryEnv)> {
    let user_profile = env_path("USERPROFILE")
        .or_else(|| etcetera::home_dir().ok())
        .context("CodeBuddy storage migration requires a user home directory")?;
    let app_data = env_path("APPDATA").unwrap_or_else(|| user_profile.join(".config"));
    let local_app_data =
        env_path("LOCALAPPDATA").unwrap_or_else(|| user_profile.join(".local").join("share"));
    let codebuddy_home = goose::config::codebuddy_paths::environment_override("CODEBUDDY_HOME");
    let goose_path_root = env::var_os("GOOSE_PATH_ROOT");
    let paths = CodeBuddyPaths::resolve(
        codebuddy_home.as_deref(),
        goose_path_root.as_deref(),
        &user_profile,
    )?;
    Ok((
        paths,
        LegacyDiscoveryEnv {
            app_data,
            local_app_data,
            user_profile,
            goose_path_root: goose_path_root.map(PathBuf::from),
        },
    ))
}

fn env_path(name: &str) -> Option<PathBuf> {
    env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_codes_distinguish_success_from_user_action() {
        assert_eq!(exit_code_for_status(MigrationReportStatus::Committed), 0);
        assert_eq!(exit_code_for_status(MigrationReportStatus::NotRequired), 0);
        assert_eq!(exit_code_for_status(MigrationReportStatus::NoRecord), 0);
        assert_eq!(
            exit_code_for_status(MigrationReportStatus::MigrationRequired),
            2
        );
        assert_eq!(exit_code_for_status(MigrationReportStatus::Conflict), 2);
    }
}
