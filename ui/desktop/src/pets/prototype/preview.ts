/* global PointerEvent */
import atlas from './assets/red-panda-parts.png';
import { createPandaRig, loadPandaParts, type PandaMetrics } from './pandaRig';
import type { PandaAction } from './pandaMotion';

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const hint = document.querySelector<HTMLElement>('#hint')!;
const metrics = document.querySelector<HTMLElement>('#metrics')!;
const auto = document.querySelector<HTMLInputElement>('#auto')!;
const reduced = document.querySelector<HTMLInputElement>('#reduced')!;
const small = document.querySelector<HTMLInputElement>('#small')!;
const media = window.matchMedia('(prefers-reduced-motion: reduce)');
reduced.checked = media.matches;
const hints: Record<PandaAction, string> = {
  idle: '不用一直动，也能有生命感。',
  look: '在预览区域移动鼠标，看它慢慢转向你。',
  wave: '抬起爪子，打声招呼，再轻轻收回。',
  jump: '蓄力 → 腾空 → 落地缓冲。',
};

async function main() {
  const parts = await loadPandaParts(atlas);
  const reports: PandaMetrics[] = [];
  Object.assign(window, { pandaReports: reports });
  const makeRig = () =>
    createPandaRig(canvas, parts, {
      size: small.checked ? 160 : 320,
      reducedMotion: reduced.checked,
      onMetrics(report) {
        reports.push(report);
        if (reports.length > 180) reports.shift();
        metrics.textContent = `${report.fps.toFixed(0)} fps · 绘制 P95 ${report.drawP95.toFixed(2)} ms · >50 ms 帧 ${report.slowFrames}`;
        document
          .querySelectorAll<HTMLButtonElement>('[data-action]')
          .forEach((button) =>
            button.setAttribute('aria-pressed', String(button.dataset.action === report.active))
          );
      },
    });
  let rig = makeRig(),
    step = 0;
  let demoTimer: ReturnType<typeof setTimeout> | undefined;
  const trigger = (action: PandaAction) => {
    rig.trigger(action);
    hint.textContent = hints[action];
    document
      .querySelectorAll<HTMLButtonElement>('[data-action]')
      .forEach((button) =>
        button.setAttribute('aria-pressed', String(button.dataset.action === action))
      );
  };
  const sequence: PandaAction[] = ['idle', 'wave', 'look', 'jump'];
  const schedule = () => {
    clearTimeout(demoTimer);
    if (!auto.checked || reduced.checked || document.hidden) return;
    const action = sequence[step++ % sequence.length];
    trigger(action);
    if (action === 'look') rig.look(0.8, -0.4);
    demoTimer = setTimeout(schedule, action === 'idle' ? 5500 : action === 'look' ? 3300 : 3000);
  };
  document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((button) =>
    button.addEventListener('click', () => {
      auto.checked = false;
      clearTimeout(demoTimer);
      trigger(button.dataset.action as PandaAction);
    })
  );
  document.querySelector('.stage')!.addEventListener('pointermove', (event) => {
    const { clientX, clientY } = event as PointerEvent;
    const bounds = canvas.getBoundingClientRect();
    rig.look(
      (clientX - bounds.x - bounds.width / 2) / 180,
      (clientY - bounds.y - bounds.height / 2) / 180
    );
  });
  auto.addEventListener('change', () => {
    step = 0;
    schedule();
  });
  const setReduced = () => {
    rig.setReducedMotion(reduced.checked);
    if (reduced.checked) {
      clearTimeout(demoTimer);
      metrics.textContent = '静态模式 · 动画已暂停';
    } else schedule();
  };
  reduced.addEventListener('change', setReduced);
  media.addEventListener('change', (event) => {
    reduced.checked = event.matches;
    setReduced();
  });
  small.addEventListener('change', () => {
    rig.dispose();
    rig = makeRig();
    trigger('idle');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearTimeout(demoTimer);
    else schedule();
  });
  window.addEventListener(
    'pagehide',
    () => {
      rig.dispose();
      clearTimeout(demoTimer);
    },
    { once: true }
  );
  canvas.dataset.ready = 'true';
  hint.textContent = hints.idle;
  if (reduced.checked) setReduced();
}
void main().catch((error) => {
  document.querySelector('#error')!.textContent = `素材加载失败：${error.message}`;
});
