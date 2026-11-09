import { useEffect, useRef, useState, type MouseEventHandler, type ReactNode } from 'react';
import { defineMessages, useIntl } from '../i18n';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { Maximize, Minus, Plus } from 'lucide-react';

const i18n = defineMessages({
  unableToLoad: {
    id: 'imagePreview.unableToLoad',
    defaultMessage: 'Unable to load image',
  },
  altText: {
    id: 'imagePreview.altText',
    defaultMessage: 'CodeBuddy image',
  },
  clickToCollapse: {
    id: 'imagePreview.clickToCollapse',
    defaultMessage: 'Click to collapse',
  },
  clickToExpand: {
    id: 'imagePreview.clickToExpand',
    defaultMessage: 'Click to expand',
  },
  zoomIn: { id: 'imagePreview.zoomIn', defaultMessage: 'Zoom in' },
  zoomOut: { id: 'imagePreview.zoomOut', defaultMessage: 'Zoom out' },
  fit: { id: 'imagePreview.fit', defaultMessage: 'Fit to window' },
});

export function ImageLightbox({
  src,
  title,
  open,
  onOpenChange,
  onContextMenu,
  actions,
}: {
  src: string;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onContextMenu?: MouseEventHandler;
  actions?: ReactNode;
}) {
  const intl = useIntl();
  const [zoom, setZoom] = useState<number | null>(null);
  const [naturalWidth, setNaturalWidth] = useState(0);
  const [naturalHeight, setNaturalHeight] = useState(0);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const node = surface;
    if (!open || !node) return;
    const resize = () => setViewport({ width: node.clientWidth, height: node.clientHeight });
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    resize();
    return () => observer.disconnect();
  }, [open, surface]);
  useEffect(() => {
    setZoom(null);
    setNaturalWidth(0);
    setNaturalHeight(0);
  }, [src, open]);
  const fit =
    naturalWidth && naturalHeight && viewport.width && viewport.height
      ? Math.min(1, viewport.width / naturalWidth, viewport.height / naturalHeight) * 100
      : 100;
  const percent = zoom ?? fit;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="flex h-[90vh] w-[94vw] max-w-[94vw] sm:max-w-[94vw] flex-col gap-3 border-0 bg-transparent p-4 pt-12 text-white shadow-none"
        overlayClassName="bg-black/65"
        onClick={(event) => event.stopPropagation()}
        onOpenAutoFocus={() => {
          returnFocus.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true });
        }}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <div ref={setSurface} className="flex min-h-0 flex-1 overflow-auto">
          <img
            src={src}
            alt={title}
            onContextMenu={onContextMenu}
            onLoad={(event) => {
              setNaturalWidth(event.currentTarget.naturalWidth);
              setNaturalHeight(event.currentTarget.naturalHeight);
            }}
            className="m-auto block h-auto shrink-0 object-contain"
            style={
              !naturalWidth
                ? { maxWidth: '100%', maxHeight: '100%' }
                : {
                    width: (naturalWidth * percent) / 100,
                    height: (naturalHeight * percent) / 100,
                    maxWidth: 'none',
                  }
            }
          />
        </div>
        <div className="mx-auto flex items-center justify-center gap-3 rounded-full border border-border-primary bg-background-primary/95 px-3 py-1 text-sm text-text-primary shadow-lg">
          <button
            type="button"
            className="inline-flex size-8 items-center justify-center rounded-full hover:bg-background-secondary disabled:opacity-40"
            aria-label={intl.formatMessage(i18n.zoomOut)}
            disabled={percent <= 10}
            onClick={() => setZoom(Math.max(10, Math.round(percent) - 25))}
          >
            <Minus size={16} />
          </button>
          <span className="min-w-12 text-center tabular-nums">{Math.round(percent)}%</span>
          <button
            type="button"
            className="inline-flex size-8 items-center justify-center rounded-full hover:bg-background-secondary disabled:opacity-40"
            aria-label={intl.formatMessage(i18n.zoomIn)}
            disabled={zoom !== null && zoom >= 400}
            onClick={() => setZoom(Math.min(400, Math.round(percent) + 25))}
          >
            <Plus size={16} />
          </button>
          <button
            type="button"
            className="inline-flex size-8 items-center justify-center rounded-full hover:bg-background-secondary"
            aria-label={intl.formatMessage(i18n.fit)}
            title={intl.formatMessage(i18n.fit)}
            onClick={() => setZoom(null)}
          >
            <Maximize size={16} />
          </button>
          {actions}
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface ImagePreviewProps {
  src: string;
  variant?: 'inline' | 'attachment';
}

export default function ImagePreview({ src, variant = 'inline' }: ImagePreviewProps) {
  const intl = useIntl();
  const [isExpanded, setIsExpanded] = useState(false);
  const [error, setError] = useState(false);
  const attachment = variant === 'attachment';

  useEffect(() => {
    setError(false);
    setIsExpanded(false);
  }, [src]);

  if (error) {
    return (
      <div
        className={
          attachment
            ? 'flex size-20 shrink-0 items-center justify-center rounded-2xl border border-border-primary bg-background-secondary p-2 text-center text-xs text-text-secondary'
            : 'text-red-500 text-xs italic mt-1 mb-1'
        }
      >
        {intl.formatMessage(i18n.unableToLoad)}
      </div>
    );
  }

  return (
    <div className={attachment ? 'image-preview shrink-0' : 'image-preview mt-2 mb-2'}>
      <button
        type="button"
        aria-label={intl.formatMessage(i18n.clickToExpand)}
        className={
          attachment
            ? 'block size-20 overflow-hidden rounded-2xl border border-border-primary bg-background-secondary focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2'
            : 'block rounded focus-visible:outline focus-visible:outline-2'
        }
        onClick={() => setIsExpanded(true)}
      >
        <img
          src={src}
          alt={intl.formatMessage(i18n.altText)}
          onError={() => setError(true)}
          className={
            attachment
              ? 'size-full object-contain'
              : 'max-h-40 max-w-40 rounded border border-border-primary object-contain'
          }
        />
      </button>
      <ImageLightbox
        src={src}
        title={intl.formatMessage(i18n.altText)}
        open={isExpanded}
        onOpenChange={setIsExpanded}
      />
    </div>
  );
}
