import { ChevronDown, LoaderCircle, Package } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { GitHubCiRun } from '@aaif/goose-sdk';
import {
  acpGetGitHubCiArtifacts,
  type GitHubCiArtifactsRequest,
  type GitHubCiArtifactsResponse,
  type GitHubCiStatusResponse,
} from '../../acp/githubCi';
import { defineMessages, useIntl } from '../../i18n';

const i18n = defineMessages({
  show: {
    id: 'githubCi.artifacts.show',
    defaultMessage: 'View artifacts for {name} run #{number}',
  },
  hide: {
    id: 'githubCi.artifacts.hide',
    defaultMessage: 'Hide artifacts for {name} run #{number}',
  },
  label: { id: 'githubCi.artifacts.label', defaultMessage: 'Artifacts' },
  loading: { id: 'githubCi.artifacts.loading', defaultMessage: 'Loading artifacts…' },
  failed: {
    id: 'githubCi.artifacts.failed',
    defaultMessage: 'CodePro could not load artifact metadata for this run.',
  },
  invalid: {
    id: 'githubCi.artifacts.invalid',
    defaultMessage: 'CodePro could not verify artifact metadata for this run.',
  },
  empty: {
    id: 'githubCi.artifacts.empty',
    defaultMessage: 'No artifacts found for this run.',
  },
  expired: { id: 'githubCi.artifacts.expired', defaultMessage: 'Expired' },
  created: { id: 'githubCi.artifacts.created', defaultMessage: 'Created {date}' },
  expires: { id: 'githubCi.artifacts.expires', defaultMessage: 'Expires {date}' },
});

type ArtifactsLoader = (request: GitHubCiArtifactsRequest) => Promise<GitHubCiArtifactsResponse>;

interface GitHubCiArtifactsPanelProps {
  workingDirectory: string;
  status: GitHubCiStatusResponse;
  run: GitHubCiRun;
  load?: ArtifactsLoader;
}

function sameConclusion(left: GitHubCiRun['conclusion'], right: GitHubCiRun['conclusion']) {
  return (left ?? null) === (right ?? null);
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function validTimestamp(value: string): number | undefined {
  if (!value || value.length > 64 || hasControlCharacters(value)) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function validArtifactsResponse(
  status: GitHubCiStatusResponse,
  run: GitHubCiRun,
  response: GitHubCiArtifactsResponse
): boolean {
  if (
    response.repositoryOwner !== status.repositoryOwner ||
    response.repositoryName !== status.repositoryName ||
    response.repositoryUrl !== status.repositoryUrl ||
    response.branch !== status.branch ||
    response.headSha !== status.headSha ||
    response.run.id !== run.id ||
    response.run.name !== run.name ||
    response.run.runNumber !== run.runNumber ||
    response.run.attempt !== run.attempt ||
    response.run.event !== run.event ||
    response.run.status !== run.status ||
    !sameConclusion(response.run.conclusion, run.conclusion) ||
    response.totalCount !== response.artifacts.length ||
    response.artifacts.length > 100
  ) {
    return false;
  }

  const ids = new Set<number>();
  const names = new Set<string>();
  return response.artifacts.every((artifact) => {
    const createdAt = validTimestamp(artifact.createdAt);
    const expiresAt = validTimestamp(artifact.expiresAt);
    const valid =
      Number.isSafeInteger(artifact.id) &&
      artifact.id > 0 &&
      artifact.name.length > 0 &&
      artifact.name.length <= 256 &&
      !hasControlCharacters(artifact.name) &&
      Number.isSafeInteger(artifact.sizeBytes) &&
      artifact.sizeBytes >= 0 &&
      createdAt !== undefined &&
      expiresAt !== undefined &&
      expiresAt >= createdAt &&
      (artifact.digest == null || /^sha256:[0-9a-f]{64}$/u.test(artifact.digest)) &&
      !ids.has(artifact.id) &&
      !names.has(artifact.name);
    ids.add(artifact.id);
    names.add(artifact.name);
    return valid;
  });
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let amount = value / 1024;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[unit]}`;
}

export function GitHubCiArtifactsPanel({
  workingDirectory,
  status,
  run,
  load = acpGetGitHubCiArtifacts,
}: GitHubCiArtifactsPanelProps) {
  const intl = useIntl();
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [response, setResponse] = useState<GitHubCiArtifactsResponse>();
  const [error, setError] = useState<'failed' | 'invalid'>();
  const requestVersion = useRef(0);
  const requestBusy = useRef(false);

  useEffect(() => {
    requestVersion.current += 1;
    requestBusy.current = false;
    setIsOpen(false);
    setIsLoading(false);
    setResponse(undefined);
    setError(undefined);
    return () => {
      requestVersion.current += 1;
      requestBusy.current = false;
    };
  }, [workingDirectory, status.headSha, run.id, run.attempt, run.updatedAt, load]);

  const toggle = async () => {
    if (isOpen) {
      setIsOpen(false);
      return;
    }
    setIsOpen(true);
    if (response || requestBusy.current) return;

    const version = ++requestVersion.current;
    requestBusy.current = true;
    setIsLoading(true);
    setError(undefined);
    try {
      const result = await load({ workingDir: workingDirectory, runId: run.id });
      if (requestVersion.current !== version) return;
      if (!validArtifactsResponse(status, run, result)) {
        setError('invalid');
        return;
      }
      setResponse(result);
    } catch {
      if (requestVersion.current === version) setError('failed');
    } finally {
      if (requestVersion.current === version) {
        requestBusy.current = false;
        setIsLoading(false);
      }
    }
  };

  const buttonLabel = intl.formatMessage(isOpen ? i18n.hide : i18n.show, {
    name: run.name,
    number: run.runNumber,
  });
  const dateFormatter = new Intl.DateTimeFormat(intl.locale, { dateStyle: 'medium' });

  return (
    <div className="mt-2 min-w-0 rounded-md border border-border-primary bg-background-secondary">
      <button
        type="button"
        aria-expanded={isOpen}
        aria-label={buttonLabel}
        disabled={isLoading}
        onClick={() => void toggle()}
        className="flex min-h-9 w-full min-w-0 items-center gap-2 px-2 text-left text-text-primary disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      >
        {isLoading ? (
          <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
        ) : (
          <Package className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1 truncate">{intl.formatMessage(i18n.label)}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>

      {isOpen && (
        <div className="min-w-0 border-t border-border-primary p-2">
          {isLoading && (
            <p role="status" className="text-xs text-text-secondary">
              {intl.formatMessage(i18n.loading)}
            </p>
          )}
          {error && (
            <p role="alert" className="text-xs text-red-700">
              {intl.formatMessage(error === 'invalid' ? i18n.invalid : i18n.failed)}
            </p>
          )}
          {response?.artifacts.length === 0 && (
            <p className="text-xs text-text-secondary">{intl.formatMessage(i18n.empty)}</p>
          )}
          {response && response.artifacts.length > 0 && (
            <ul className="grid min-w-0 grid-cols-1 gap-2">
              {response.artifacts.map((artifact) => (
                <li
                  key={artifact.id}
                  className="min-w-0 rounded border border-border-primary bg-background-default p-2"
                >
                  <div className="flex min-w-0 flex-wrap items-start justify-between gap-1">
                    <p className="min-w-0 break-all font-medium text-text-primary">
                      {artifact.name}
                    </p>
                    {artifact.expired && (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800">
                        {intl.formatMessage(i18n.expired)}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-text-secondary">
                    {formatBytes(artifact.sizeBytes)}
                  </p>
                  <p className="mt-1 break-words text-[11px] text-text-secondary">
                    <time dateTime={artifact.createdAt}>
                      {intl.formatMessage(i18n.created, {
                        date: dateFormatter.format(new Date(artifact.createdAt)),
                      })}
                    </time>
                    {' · '}
                    <time dateTime={artifact.expiresAt}>
                      {intl.formatMessage(i18n.expires, {
                        date: dateFormatter.format(new Date(artifact.expiresAt)),
                      })}
                    </time>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
