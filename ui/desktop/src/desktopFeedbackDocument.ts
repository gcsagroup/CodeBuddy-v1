// Original presentation artwork. The pointer is feedback for the shared OS
// cursor, not another input device or a second autonomous desktop session.
export function desktopFeedbackDocument(hint: string) {
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;pointer-events:none;background:transparent}
body{font:13px "Segoe UI","Microsoft YaHei",sans-serif;color:#eef8ff;-webkit-font-smoothing:antialiased}
.glow{position:fixed;inset:0;border:2px solid #a6e4ff;box-shadow:inset 0 0 7px 2px #4fc3ff99,inset 0 0 23px 5px #8065ff54;box-sizing:border-box;border-radius:12px;animation:edge-breathe 4.8s ease-in-out infinite;will-change:opacity}
.glow::after{content:"";position:absolute;inset:0;border-radius:inherit;background:linear-gradient(180deg,#a6e4ff18,transparent 36px,transparent calc(100% - 36px),#8b79ff18);pointer-events:none}
.banner{position:fixed;top:16px;left:50%;transform:translateX(-50%);height:38px;max-width:calc(100% - 24px);box-sizing:border-box;padding:0 12px 0 10px;display:flex;align-items:center;gap:9px;white-space:nowrap;border:1px solid #a4c5ff70;border-radius:19px;background:linear-gradient(115deg,#111e35fa,#20223dfa);box-shadow:0 8px 24px -8px #07152b66,0 1px 0 #ffffff0d inset;animation:reveal 180ms ease-out both;overflow:hidden;isolation:isolate}
.banner::before{content:"";position:absolute;inset:0;z-index:-1;background:linear-gradient(110deg,transparent 20%,#a4c5ff0d 45%,#d8eaff1c 50%,#a4c5ff0d 55%,transparent 80%);transform:translateX(-100%);animation:control-sheen 5.4s ease-in-out infinite}
.banner::after{content:"";position:absolute;bottom:0;left:18%;right:18%;height:1px;background:linear-gradient(90deg,transparent,#69caff99,#7b79f577,transparent)}
.mark{position:relative;display:grid;place-items:center;width:22px;height:22px;border-radius:50%;background:#69caff12;box-shadow:inset 0 0 0 1px #a6e4ff27;color:#a6dfff;flex-shrink:0}
.mark::after{content:"";position:absolute;inset:-1px;border-radius:50%;border:1px solid transparent;border-top-color:#8fe4ff;border-right-color:#7b83ff4d;animation:control-orbit 3.6s linear infinite}
.brand{font-size:10px;font-weight:500;color:#a9b9d3;letter-spacing:.3px}.status{position:relative;color:#c7dbff;font-size:12px;font-weight:600;letter-spacing:.5px;line-height:20px}.hint{font-size:10px;line-height:18px;color:#dce7fa;border:1px solid #a9c1ed33;border-bottom-color:#a9c1ed55;border-radius:6px;background:linear-gradient(180deg,#ffffff0b,#ffffff04);box-shadow:0 1px 2px #080e2026,inset 0 1px 0 #ffffff08;padding:1px 7px;margin-left:2px}
/* Clip a composited moving light to static glyphs instead of repainting a text background every frame. */
.status-shine{position:absolute;inset:0;clip-path:url(#control-text-clip);pointer-events:none}
.status-shine::before{content:"";position:absolute;inset:0;background:linear-gradient(110deg,transparent 25%,#ffffffb3 46%,#fff 50%,#ffffffb3 54%,transparent 75%);transform:translateX(-100%);will-change:transform;animation:control-text-shine 4.8s ease-in-out infinite}
#pointer{position:fixed;top:0;left:0;display:none;width:38px;height:45px;will-change:transform;filter:drop-shadow(0 2px 2px #10224560)}
.cursor-label{position:absolute;top:32px;left:16px;padding:4px 8px;border-radius:8px;background:linear-gradient(115deg,#244a82f5,#494781f5);border:1px solid #bbdfffaa;box-shadow:0 2px 7px #10223c30;color:#ffffff;font-size:10px;font-weight:500;letter-spacing:.3px;white-space:nowrap}
@keyframes reveal{from{opacity:0}to{opacity:1}}
@keyframes edge-breathe{0%,100%{opacity:.7}50%{opacity:1}}
@keyframes control-sheen{0%,15%{transform:translateX(-100%)}85%,100%{transform:translateX(100%)}}
@keyframes control-orbit{to{transform:rotate(360deg)}}
@keyframes control-text-shine{0%,20%{transform:translateX(-100%)}75%,100%{transform:translateX(100%)}}
@media(prefers-reduced-motion:reduce){.banner,.glow,.banner::before,.mark::after,.status-shine::before{animation:none}.status-shine{display:none}.status{background:none;color:#d5e5ff}.banner::before{transform:none;opacity:.4}.glow{opacity:1;will-change:auto}}
@media(max-width:440px){.brand{display:none}.banner{gap:7px;padding:0 10px}.hint{padding:1px 6px;margin-left:0}}
</style>
<div class="glow"></div><div class="banner"><span class="mark"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 4H5a1 1 0 0 0-1 1v3m12-4h3a1 1 0 0 1 1 1v3M4 16v3a1 1 0 0 0 1 1h3m12-4v3a1 1 0 0 1-1 1h-3M12 7v10M7 12h10"/></svg></span><b class="brand">CodeBuddy</b><span class="status">正在控制电脑<svg aria-hidden="true" width="0" height="0" style="position:absolute"><defs><clipPath id="control-text-clip"><text x="0" y="14.5" font-family="Segoe UI,Microsoft YaHei,sans-serif" font-size="12" font-weight="600" letter-spacing=".5">正在控制电脑</text></clipPath></defs></svg><span class="status-shine" aria-hidden="true"></span></span><span class="hint">${hint}</span></div>
<div id="pointer"><svg width="32" height="35" viewBox="0 0 32 35"><defs><linearGradient id="cursor-fill" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#8fe4ff"/><stop offset="1" stop-color="#7b83ff"/></linearGradient></defs><path d="M2 2 L8 29 L14 21 L24 22 Z" fill="url(#cursor-fill)" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/></svg><div class="cursor-label">电脑控制</div></div>`;
}
