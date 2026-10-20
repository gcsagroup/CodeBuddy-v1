import { useState } from 'react';
import { useIntl } from '../i18n';
import { panelMessages as m } from './workspacePanelMessages';
import type { PanelMedia } from './workspacePanelTypes';

export function WorkspaceMedia({
  media,
  title,
  thumbnail = false,
}: {
  media: PanelMedia;
  title: string;
  thumbnail?: boolean;
}) {
  const intl = useIntl();
  const [failedMedia, setFailedMedia] = useState<PanelMedia>();
  if (failedMedia === media)
    return <span role="status">{intl.formatMessage(m.mediaFailed)}</span>;
  const style = {
    maxWidth: '100%',
    maxHeight: thumbnail ? 180 : '100%',
    objectFit: 'contain' as const,
  };
  return media.kind === 'video' ? (
    <video
      key={media.url}
      src={media.url}
      aria-label={title}
      controls={!thumbnail}
      muted={thumbnail}
      playsInline
      preload="metadata"
      style={style}
      onError={(event) => {
        window.electron?.logInfo?.(
          JSON.stringify({
            tag: 'workspace_media_error',
            kind: media.kind,
            code: event.currentTarget.error?.code,
            message: event.currentTarget.error?.message,
          })
        );
        setFailedMedia(media);
      }}
    />
  ) : (
    <img
      src={media.url}
      alt={title}
      loading="lazy"
      style={style}
      onError={() => setFailedMedia(media)}
    />
  );
}
