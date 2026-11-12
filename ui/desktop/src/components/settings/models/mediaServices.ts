import { getAcpControlClient } from '../../../acp/acpConnection';
import { currentLocale } from '../../../i18n';
import { selectNativeText } from '../../../utils/nativeLocalization';
import { buttonVariants } from '../../ui/button';

export const t = (en: string, cn: string, tw: string) =>
  selectNativeText(currentLocale, en, cn, tw);
export type ServiceType = 'bailian' | 'ark' | 'comfy' | 'openai' | 'fal';
export type Choice = ServiceType | 'custom';
export type Kind = 'image' | 'video';
export interface Model {
  id: string;
  label: string;
  modes: string[];
  retiring?: boolean;
}
export interface Service {
  id: string;
  name: string;
  type: ServiceType;
  url: string;
  models: Model[];
  hasKey: boolean;
  workspaceId?: string;
  custom?: boolean;
}
export interface Selection {
  service: string;
  model: string;
}
export interface Registry {
  revision: number;
  services: Service[];
  defaults: Record<Kind, Selection | null>;
  catalog: Record<ServiceType, { urls: string[]; models: Model[] }>;
}
export interface Trial {
  status: string;
  error?: string;
  file?: string;
  jobId: string;
}
export async function mediaRequest<T>(
  op: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  const client = await getAcpControlClient();
  return (await client.extMethod('_codebuddy/media/settings/' + op, params)) as unknown as T;
}
export const names: Record<Choice, string> = {
  bailian: t('Alibaba Cloud · Qwen / Wan', '阿里云百炼（千问、万相）', '阿里雲百煉（千問、萬相）'),
  ark: t('Volcengine Ark · Doubao', '火山方舟（豆包）', '火山方舟（豆包）'),
  comfy: 'ComfyUI',
  openai: 'OpenAI Images',
  fal: 'fal',
  custom: t('Custom service', '自定义服务', '自訂服務'),
};
export const hints: Record<Choice, string> = {
  bailian: t(
    'Qwen-Image for images, Wan for video',
    '千问生图、改图，通义万相生成视频',
    '千問生圖、改圖，通義萬相生成影片'
  ),
  ark: t(
    'Seedream for images, Seedance for video',
    'Seedream 生图、改图，Seedance 生成视频',
    'Seedream 生圖、改圖，Seedance 生成影片'
  ),
  comfy: t(
    'Use workflows on your own server',
    '连接本机或公司服务器上的工作流',
    '連接本機或公司伺服器上的工作流'
  ),
  openai: t(
    'Official image generation and editing API',
    '使用 OpenAI 官方图片 API',
    '使用 OpenAI 官方圖片 API'
  ),
  fal: t('Cloud video generation', '使用云端队列生成视频', '使用雲端佇列生成影片'),
  custom: t(
    'Connect a gateway or self-hosted service',
    '连接公司网关、第三方中转或自部署服务',
    '連接公司閘道、第三方中轉或自部署服務'
  ),
};
export const modes: Record<string, string> = {
  text_to_image: t('Text to image', '文生图', '文生圖'),
  image_to_image: t('Image editing', '参考图编辑', '參考圖編輯'),
  text_to_video: t('Text to video', '文生视频', '文生影片'),
  image_to_video: t('Image to video', '图生视频', '圖生影片'),
  reference_to_video: t('Reference to video', '参考图生视频', '參考圖生影片'),
};
export const kindOf = (m: Model): Kind => (m.modes[0].endsWith('_image') ? 'image' : 'video');
export const field =
  'w-full rounded-lg border border-border-subtle bg-background-primary px-3 py-2 text-sm';
export const button =
  'rounded-lg border border-border-subtle px-3 py-2 text-sm hover:bg-background-secondary disabled:opacity-50';
export const primary = buttonVariants({ className: 'rounded-lg' });
