import distro from '../codebuddy.distro.json';

export const UPDATES_ENABLED = distro.updatesEnabled;
export const COST_TRACKING_ENABLED = true;
export const ANNOUNCEMENTS_ENABLED = false;
export const CONFIGURATION_ENABLED = true;
export const TELEMETRY_UI_ENABLED = distro.telemetryUiEnabled;
export const DICTATION_ALLOWED_PROVIDERS: string[] | null = null;
