import { useState } from 'react';
import { useIntl } from '../i18n';
import { panelMessages as m } from './workspacePanelMessages';
import type { PanelMedia } from './workspacePanelTypes';
import { openWorkspaceFile, type WorkspaceFileTarget } from './workspaceFilePanel';
import { ImageLightbox } from '../components/ImagePreview';

export function WorkspaceMedia({
  media,
  title,
  thumbnail = false,
  target,
}: {
  media: PanelMedia;
  title: string;
  thumbnail?: boolean;
  target?: WorkspaceFileTarget;
}) {
  const intl = useIntl();
  const [failedMedia, setFailedMedia] = useState<PanelMedia>();
  const [expandedMedia, setExpandedMedia] = useState<PanelMedia>();
  if (failedMedia === media) return <span role="status">{intl.formatMessage(m.mediaFailed)}</span>;
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
      onContextMenu={
        target
          ? (event) => {
              event.preventDefault();
              event.stopPropagation();
              openWorkspaceFile({ ...target, action: 'file-menu', menuKind: 'video' });
            }
          : undefined
      }
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
    <>
      <img
        src={media.url}
        alt={title}
        loading="lazy"
        style={style}
        tabIndex={0}
        className="cursor-zoom-in rounded focus-visible:outline focus-visible:outline-2"
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            setExpandedMedia(media);
          }
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (target && (event.ctrlKey || event.metaKey))
            openWorkspaceFile({ ...target, action: 'open-external' });
          else setExpandedMedia(media);
        }}
        onContextMenu={
          target
            ? (event) => {
                event.preventDefault();
                event.stopPropagation();
                openWorkspaceFile({ ...target, action: 'file-menu', menuKind: 'image' });
              }
            : undefined
        }
        onError={() => setFailedMedia(media)}
      />
      <ImageLightbox
        src={media.url}
        title={title}
        open={expandedMedia === media}
        onOpenChange={(open) => {
          if (!open) setExpandedMedia(undefined);
        }}
        onContextMenu={
          target
            ? (event) => {
                event.preventDefault();
                event.stopPropagation();
                openWorkspaceFile({ ...target, action: 'file-menu', menuKind: 'image' });
              }
            : undefined
        }
      />
    </>
  );
}
