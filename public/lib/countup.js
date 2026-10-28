// Pure count-up math, shared by every animated number in the UI.

/** easeOutExpo: fast start, long satisfying settle. Exact 0 at t=0 and 1 at t=1. */
export const easeOutExpo = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));

/**
 * Progress of an animation in [0, 1]. A requestAnimationFrame timestamp is the
 * frame's start time, which can be earlier than the performance.now() taken
 * when the animation started, so the raw ratio can be slightly negative.
 */
export const progress = (now, start, duration) => (duration > 0 ? Math.max(0, Math.min(1, (now - start) / duration)) : 1);

/** Value to show at time `now` when counting from `from` to `to`. */
export const countValue = (now, start, duration, from, to) => from + (to - from) * easeOutExpo(progress(now, start, duration));
