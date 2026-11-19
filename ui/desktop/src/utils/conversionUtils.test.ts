import { describe, expect, it, vi } from 'vitest';
import { compressImageDataUrl, errorMessage } from './conversionUtils';

it('retains compact chat screenshots at native resolution while large images and thumbnails stay bounded', async () => {
  let width = 1600;
  vi.stubGlobal('Image', class {
    width = width; height = 834; onload?: () => void;
    set src(_url: string) { this.onload?.(); }
  });
  const dimensions: number[][] = [];
  const drawingContext = { drawImage: vi.fn() } satisfies Pick<CanvasRenderingContext2D, 'drawImage'>;
  const context = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue(drawingContext as unknown as CanvasRenderingContext2D);
  const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(function (this: HTMLCanvasElement, type) {
    dimensions.push([this.width, this.height]);
    return 'data:' + type + ';base64,YQ==';
  });
  try {
    const png = 'data:image/png;base64,YQ==';
    expect(await compressImageDataUrl(png, true)).toBe(png);
    expect(await compressImageDataUrl(png)).toMatch(/^data:image\/jpeg/);
    width = 4096;
    expect(await compressImageDataUrl(png, true)).toMatch(/^data:image\/jpeg/);
    expect(dimensions).toEqual([[1600, 834], [1024, 533], [1024, 208]]);
  } finally {
    encode.mockRestore();
    context.mockRestore();
    vi.unstubAllGlobals();
  }
});

describe('errorMessage', () => {
  it('prefers ACP JSON-RPC error data over generic messages', () => {
    expect(
      errorMessage({
        error: {
          message: 'Invalid params',
          data: 'MLX backend error: failed to load model',
        },
      })
    ).toBe('MLX backend error: failed to load model');
  });

  it('prefers ACP JSON-RPC error data from Error instances', () => {
    const error = Object.assign(new Error('Invalid params'), {
      error: {
        message: 'Invalid params',
        data: 'MLX backend error: failed to load model',
      },
    });

    expect(errorMessage(error)).toBe('MLX backend error: failed to load model');
  });
});
