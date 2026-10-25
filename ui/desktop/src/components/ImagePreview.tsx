import { useEffect, useState } from 'react';
import { defineMessages, useIntl } from '../i18n';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from './ui/dialog';

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
});

interface ImagePreviewProps {
  src: string;
}

export default function ImagePreview({ src }: ImagePreviewProps) {
  const intl = useIntl();
  const [isExpanded, setIsExpanded] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    setError(false);
    setIsExpanded(false);
  }, [src]);

  if (error) {
    return (
      <div className="text-red-500 text-xs italic mt-1 mb-1">
        {intl.formatMessage(i18n.unableToLoad)}
      </div>
    );
  }

  return (
    <div className={`image-preview mt-2 mb-2`}>
      <Dialog open={isExpanded} onOpenChange={setIsExpanded}>
        <DialogTrigger asChild>
          <button
            type="button"
            aria-label={intl.formatMessage(i18n.clickToExpand)}
            className="block rounded focus-visible:outline focus-visible:outline-2"
          >
            <img
              src={src}
              alt={intl.formatMessage(i18n.altText)}
              onError={() => setError(true)}
              className="max-h-40 max-w-40 rounded border border-border-primary object-contain"
            />
          </button>
        </DialogTrigger>
        <DialogContent
          aria-describedby={undefined}
          className="w-auto max-w-[90vw] sm:max-w-[90vw] p-8"
        >
          <DialogTitle className="sr-only">{intl.formatMessage(i18n.altText)}</DialogTitle>
          <img
            src={src}
            alt={intl.formatMessage(i18n.altText)}
            className="max-h-[80vh] max-w-full object-contain"
          />
        </DialogContent>
      </Dialog>
      <div className="text-xs text-text-secondary mt-1">
        {intl.formatMessage(i18n.clickToExpand)}
      </div>
    </div>
  );
}
