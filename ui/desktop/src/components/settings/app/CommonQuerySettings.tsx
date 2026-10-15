import { useEffect, useState } from 'react';
import { useConfig } from '../../ConfigContext';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card';
import { defineMessages, useIntl } from '../../../i18n';

export const COMMON_QUERY_CONFIG_KEY = 'CODEBUDDY_COMMON_QUERIES';
const messages = defineMessages({
  title: { id: 'commonQueries.title', defaultMessage: 'Time and weather' },
  description: {
    id: 'commonQueries.description',
    defaultMessage: 'Read the device clock and look up weather for a chosen city.',
  },
  network: { id: 'commonQueries.network', defaultMessage: 'Allow online city and weather queries' },
  city: { id: 'commonQueries.city', defaultMessage: 'Default query city (optional)' },
  country: { id: 'commonQueries.country', defaultMessage: 'Country code (optional, e.g. CN)' },
  timezone: {
    id: 'commonQueries.timezone',
    defaultMessage: 'Display timezone (empty uses the host timezone)',
  },
  units: { id: 'commonQueries.units', defaultMessage: 'Temperature unit' },
  privacy: {
    id: 'commonQueries.privacy',
    defaultMessage:
      'The default city is a preference, not detected location. Queries send the place name or coordinates to Open-Meteo. Precise device location is not collected.',
  },
  terms: {
    id: 'commonQueries.terms',
    defaultMessage:
      'Provider: Open-Meteo. This free endpoint is for non-commercial use. Weather model data is attributed to Open-Meteo (CC BY 4.0).',
  },
  save: { id: 'commonQueries.save', defaultMessage: 'Save query settings' },
  saved: { id: 'commonQueries.saved', defaultMessage: 'Saved. Applies to the next query.' },
  error: {
    id: 'commonQueries.error',
    defaultMessage:
      'Query settings could not be loaded or saved. Check the city, two-letter country code and IANA timezone.',
  },
});

type QuerySettings = {
  network_enabled: boolean;
  default_city: string;
  country_code: string;
  timezone: string;
  units: 'metric' | 'imperial';
};
const defaults: QuerySettings = {
  network_enabled: true,
  default_city: '',
  country_code: '',
  timezone: '',
  units: 'metric',
};

export default function CommonQuerySettings() {
  const intl = useIntl();
  const { read, upsert } = useConfig();
  const [settings, setSettings] = useState<QuerySettings>(defaults);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<'saved' | 'error' | null>(null);
  useEffect(() => {
    let active = true;
    read(COMMON_QUERY_CONFIG_KEY, false, { throwOnError: true })
      .then((value) => {
        if (active && value && typeof value === 'object') setSettings({ ...defaults, ...value });
      })
      .catch(() => {
        if (active) setNotice('error');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [read]);
  function update<K extends keyof QuerySettings>(key: K, value: QuerySettings[K]) {
    setSettings((previous) => ({ ...previous, [key]: value }));
    setNotice(null);
  }
  async function save() {
    setSaving(true);
    setNotice(null);
    try {
      const normalized = {
        ...settings,
        default_city: settings.default_city.trim(),
        country_code: settings.country_code.trim().toUpperCase(),
        timezone: settings.timezone.trim(),
      };
      if (normalized.country_code && !/^[A-Z]{2}$/.test(normalized.country_code))
        throw new Error('country');
      if (normalized.timezone)
        new Intl.DateTimeFormat('en', { timeZone: normalized.timezone }).format();
      await upsert(COMMON_QUERY_CONFIG_KEY, normalized, false);
      setSettings(normalized);
      setNotice('saved');
    } catch {
      setNotice('error');
    } finally {
      setSaving(false);
    }
  }
  const inputClass =
    'mt-1 w-full rounded-md border border-border-primary bg-background-primary px-3 py-2 text-sm text-text-primary';
  return (
    <Card className="rounded-lg">
      <CardHeader className="pb-0">
        <CardTitle>{intl.formatMessage(messages.title)}</CardTitle>
        <CardDescription>{intl.formatMessage(messages.description)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 pt-4 px-4">
        <fieldset disabled={loading || saving} className="space-y-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.network_enabled}
              onChange={(event) => update('network_enabled', event.target.checked)}
            />
            {intl.formatMessage(messages.network)}
          </label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="text-xs text-text-secondary">
              {intl.formatMessage(messages.city)}
              <input
                className={inputClass}
                value={settings.default_city}
                maxLength={120}
                onChange={(event) => update('default_city', event.target.value)}
              />
            </label>
            <label className="text-xs text-text-secondary">
              {intl.formatMessage(messages.country)}
              <input
                className={inputClass}
                value={settings.country_code}
                maxLength={2}
                onChange={(event) => update('country_code', event.target.value)}
              />
            </label>
            <label className="text-xs text-text-secondary">
              {intl.formatMessage(messages.timezone)}
              <input
                className={inputClass}
                value={settings.timezone}
                placeholder={Intl.DateTimeFormat().resolvedOptions().timeZone}
                onChange={(event) => update('timezone', event.target.value)}
              />
            </label>
            <label className="text-xs text-text-secondary">
              {intl.formatMessage(messages.units)}
              <select
                className={inputClass}
                value={settings.units}
                onChange={(event) => update('units', event.target.value as QuerySettings['units'])}
              >
                <option value="metric">°C</option>
                <option value="imperial">°F</option>
              </select>
            </label>
          </div>
          <button
            type="button"
            className="rounded-md border border-border-primary px-3 py-2 text-sm hover:bg-background-secondary"
            onClick={save}
          >
            {intl.formatMessage(messages.save)}
          </button>
        </fieldset>
        <p className="text-xs text-text-secondary">{intl.formatMessage(messages.privacy)}</p>
        <p className="text-xs text-text-secondary">{intl.formatMessage(messages.terms)}</p>
        {notice && (
          <p role={notice === 'error' ? 'alert' : 'status'} className="text-xs">
            {intl.formatMessage(messages[notice])}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
