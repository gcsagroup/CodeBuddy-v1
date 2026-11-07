import { useState, useRef, type ComponentRef } from 'react';
import { useIntl } from '../i18n';
import { panelMessages as m } from './workspacePanelMessages';
import type { PanelMedia } from './workspacePanelTypes';
import { openWorkspaceFile, type WorkspaceFileTarget } from './workspaceFilePanel';
import { ImageLightbox } from '../components/ImagePreview';
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog';
import { Download, ExternalLink, Maximize2, PanelRight } from 'lucide-react';
import { selectNativeText } from '../utils/nativeLocalization';
import { currentLocale } from '../i18n';
import '../components/media-cards.css';

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
  const video = useRef<ComponentRef<'video'>>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const playhead = useRef(0);
  const text = (en: string, cn: string, tw: string) => selectNativeText(currentLocale, en, cn, tw);
  const actions = target && (
    <span className="media-actions">
      <button
        type="button"
        title={text('Open in side panel', '在侧栏中打开', '在側欄中開啟')}
        aria-label={text('Open in side panel', '在侧栏中打开', '在側欄中開啟')}
        onClick={() => {
          setExpandedMedia(undefined);
          openWorkspaceFile(target);
        }}
      >
        <PanelRight size={16} />
      </button>
      <button
        type="button"
        title={text('Save as', '另存为', '另存新檔')}
        aria-label={text('Save as', '另存为', '另存新檔')}
        onClick={() => openWorkspaceFile({ ...target, action: 'save-as' })}
      >
        <Download size={16} />
      </button>
      <button
        type="button"
        title={text('Open externally', '用默认应用打开', '用預設應用程式開啟')}
        aria-label={text('Open externally', '用默认应用打开', '用預設應用程式開啟')}
        onClick={() => openWorkspaceFile({ ...target, action: 'open-external' })}
      >
        <ExternalLink size={16} />
      </button>
    </span>
  );
  if (failedMedia === media) return <span role="status">{intl.formatMessage(m.mediaFailed)}</span>;
  const style = {
    maxWidth: '100%',
    maxHeight: thumbnail ? 180 : '100%',
    objectFit: 'contain' as const,
  };
  return media.kind === 'video' ? (
    <span className="media-view">
      <video
        ref={video}
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
      {!thumbnail && (
        <span className="media-actions">
          <button
            type="button"
            aria-label={text('Expand video', '放大视频', '放大影片')}
            onClick={() => {
              playhead.current = video.current?.currentTime ?? 0;
              video.current?.pause();
              setExpandedMedia(media);
            }}
          >
            <Maximize2 size={16} />
            {text('Expand', '放大', '放大')}
          </button>
          {actions}
        </span>
      )}
      <Dialog
        open={expandedMedia === media}
        onOpenChange={(open) => {
          if (!open) setExpandedMedia(undefined);
        }}
      >
        <DialogContent
          aria-describedby={undefined}
          overlayClassName="bg-black/65 backdrop-blur-sm"
          className="flex h-[90vh] w-[94vw] max-w-[94vw] sm:max-w-[94vw] flex-col border-0 p-5 pt-12"
          onOpenAutoFocus={() => {
            returnFocus.current = document.activeElement as HTMLElement;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus.current?.focus?.({ preventScroll: true });
          }}
        >
          <DialogTitle className="sr-only">{title}</DialogTitle>
          <video
            src={media.url}
            controls
            playsInline
            className="min-h-0 flex-1 rounded-xl object-contain"
            aria-label={title}
            onLoadedMetadata={(event) => {
              event.currentTarget.currentTime = playhead.current;
            }}
            onTimeUpdate={(event) => {
              playhead.current = event.currentTarget.currentTime;
            }}
          />
          <span className="mx-auto">{actions}</span>
        </DialogContent>
      </Dialog>
    </span>
  ) : (
    <span className="media-view">
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
          else {
            event.currentTarget.focus();
            setExpandedMedia(media);
          }
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
      {!thumbnail && actions}
      <ImageLightbox
        src={media.url}
        title={title}
        open={expandedMedia === media}
        actions={actions}
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
    </span>
  );
}
