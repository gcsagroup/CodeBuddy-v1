import { controlFeedbackStyles } from './controlFeedbackStyles';

// Original presentation artwork. The pointer is feedback for the shared OS
// cursor, not another input device or a second autonomous desktop session.
export function desktopFeedbackDocument(hint: string) {
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;pointer-events:none;background:transparent}
body{font:13px "Segoe UI","Microsoft YaHei",sans-serif;color:#eef8ff;-webkit-font-smoothing:antialiased}
${controlFeedbackStyles}
/* Clip a composited moving light to static glyphs instead of repainting a text background every frame. */
.status-shine{position:absolute;inset:0;clip-path:url(#control-text-clip);pointer-events:none}
.status-shine::before{content:"";position:absolute;inset:0;background:linear-gradient(110deg,transparent 25%,#ffffffb3 46%,#fff 50%,#ffffffb3 54%,transparent 75%);transform:translateX(-100%);will-change:transform;animation:control-text-shine 4.8s ease-in-out infinite}
#pointer{position:fixed;top:0;left:0;display:none;width:38px;height:45px;will-change:transform;filter:drop-shadow(0 2px 2px #10224560)}
.cursor-label{position:absolute;top:32px;left:16px;padding:4px 8px;border-radius:8px;background:linear-gradient(115deg,#244a82f5,#494781f5);border:1px solid #bbdfffaa;box-shadow:0 2px 7px #10223c30;color:#ffffff;font-size:10px;font-weight:500;letter-spacing:.3px;white-space:nowrap}
@keyframes control-text-shine{0%,20%{transform:translateX(-100%)}75%,100%{transform:translateX(100%)}}
@media(prefers-reduced-motion:reduce){.status-shine{display:none}.status-shine::before{animation:none}}
</style>
<body class="control-feedback"><div class="glow"></div><div class="banner"><span class="mark"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 4H5a1 1 0 0 0-1 1v3m12-4h3a1 1 0 0 1 1 1v3M4 16v3a1 1 0 0 0 1 1h3m12-4v3a1 1 0 0 1-1 1h-3M12 7v10M7 12h10"/></svg></span><b class="brand">CodeBuddy</b><span class="status">正在控制电脑<svg aria-hidden="true" width="0" height="0" style="position:absolute"><defs><clipPath id="control-text-clip"><text x="0" y="14.5" font-family="Segoe UI,Microsoft YaHei,sans-serif" font-size="12" font-weight="600" letter-spacing=".5">正在控制电脑</text></clipPath></defs></svg><span class="status-shine" aria-hidden="true"></span></span><span class="hint">${hint}</span></div>
<div id="pointer"><svg width="32" height="35" viewBox="0 0 32 35"><defs><linearGradient id="cursor-fill" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#8fe4ff"/><stop offset="1" stop-color="#7b83ff"/></linearGradient></defs><path d="M2 2 L8 29 L14 21 L24 22 Z" fill="url(#cursor-fill)" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/></svg><div class="cursor-label">电脑控制</div></div>`;
}
