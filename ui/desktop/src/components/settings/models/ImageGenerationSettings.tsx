import { useEffect, useState } from 'react';
import { readPreferences, savePreferences } from '../../../acp/preferences';
import { currentLocale } from '../../../i18n';
import { selectNativeText } from '../../../utils/nativeLocalization';

const t = (en: string, cn: string, tw: string) => selectNativeText(currentLocale, en, cn, tw);
export default function ImageGenerationSettings() {
  const [url, setUrl] = useState('http://192.168.9.111:8188');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let mounted = true;
    void readPreferences(['comfyuiBaseUrl'])
      .then((snapshot) => {
        if (!mounted) return;
        const saved = snapshot.values.find((entry) => entry.key === 'comfyuiBaseUrl')?.value;
        if (typeof saved === 'string') setUrl(saved);
        setReady(true);
      })
      .catch((error) => {
        if (mounted) setMessage(String(error));
      });
    return () => {
      mounted = false;
    };
  }, []);
  async function save() {
    setBusy(true);
    setMessage('');
    try {
      const parsed = new URL(url.trim());
      if (
        !['http:', 'https:'].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
      )
        throw new Error(
          t(
            'Enter an HTTP(S) service URL without credentials, query or fragment.',
            '请输入 HTTP(S) 服务地址，不含凭据、查询参数或页面锚点。',
            '請輸入 HTTP(S) 服務位址，不含憑證、查詢參數或頁面錨點。'
          )
        );
      await savePreferences([
        { key: 'comfyuiBaseUrl', value: parsed.href.replace(/\/$/, ''), isMutable: true },
      ]);
      setMessage(
        t(
          'Saved. New image and video requests use this address.',
          '已保存，后续图片和视频任务使用此地址。',
          '已儲存，後續圖片和影片任務使用此位址。'
        )
      );
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-3 rounded-lg border border-border-subtle p-4">
      <h3 className="font-semibold">
        {t('Images and videos · ComfyUI', '图片与视频 · ComfyUI', '圖片與影片 · ComfyUI')}
      </h3>
      <p className="text-sm text-text-secondary">
        {t(
          'Ask your Agent to generate images, create pet artwork, or turn text and images into video. Uses Qwen Image 2.1 for images and MiniMax H3 for video. Results are saved in the conversation workspace.',
          '直接让 Agent 生图、制作宠物素材，或使用文字和图片生成视频。图片使用 Qwen Image 2.1，视频使用 MiniMax H3，结果保存到对话工作区。',
          '直接讓 Agent 生圖、製作寵物素材，或使用文字和圖片生成影片。圖片使用 Qwen Image 2.1，影片使用 MiniMax H3，結果儲存至聊天工作區。'
        )}
      </p>
      <label className="block space-y-1 text-sm">
        {t('Service address', '服务地址', '服務位址')}
        <input
          aria-label={t('ComfyUI URL', 'ComfyUI 服务地址', 'ComfyUI 服務位址')}
          className="block w-full rounded border border-border-subtle bg-background-default px-3 py-2"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          disabled={!ready || busy}
        />
      </label>
      <button
        className="rounded border border-border-subtle px-3 py-2 text-sm disabled:opacity-50"
        disabled={!ready || busy}
        onClick={() => void save()}
      >
        {t('Save media service', '保存生成服务', '儲存生成服務')}
      </button>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
    </section>
  );
}
