import { CodeBuddyMark } from '../CodeBuddyMark';

export function AgentAvatar({ avatar, className = 'size-8' }: { avatar: string; className?: string }) {
  if (avatar === 'app-logo') return <CodeBuddyMark className={className} />;
  if (avatar.startsWith('data:image/png;base64,')) return <img src={avatar} alt="" aria-hidden="true" draggable={false} className={className + ' rounded-md object-cover'} />;
  return <span aria-hidden="true" className={className + ' inline-flex items-center justify-center'}>{avatar}</span>;
}

export async function readAvatar(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) throw new Error('请选择不超过 5 MB 的 PNG、JPEG 或 WebP 图片。');
  const image = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法处理头像图片，请重试。');
    const side = Math.min(image.width, image.height);
    context.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, 128, 128);
    return canvas.toDataURL('image/png');
  } finally { image.close(); }
}
