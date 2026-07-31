import { useCallback, useEffect, useState } from 'react';

export interface ReplayState {
  offset: number;
  max: number;
  playing: boolean;
  setOffset(value: number): void;
  reset(): void;
  toggle(): void;
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return;
    const update = () => setReduced(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

export function useReplay(maximum: number, reducedMotion: boolean): ReplayState {
  const max = Math.max(0, Math.floor(maximum));
  const [offset, setOffsetState] = useState(max);
  const [playing, setPlaying] = useState(false);

  useEffect(() => { setOffsetState(max); setPlaying(false); }, [max]);
  useEffect(() => {
    if (!playing || reducedMotion || max === 0) return;
    const timer = window.setInterval(() => {
      setOffsetState((current) => {
        const next = Math.min(max, current + Math.max(1, Math.ceil(max / 80)));
        if (next >= max) setPlaying(false);
        return next;
      });
    }, 160);
    return () => window.clearInterval(timer);
  }, [max, playing, reducedMotion]);

  const setOffset = useCallback((value: number) => {
    setPlaying(false);
    setOffsetState(Math.min(max, Math.max(0, Math.floor(value))));
  }, [max]);
  const reset = useCallback(() => { setPlaying(false); setOffsetState(0); }, []);
  const toggle = useCallback(() => {
    if (reducedMotion) { setPlaying(false); setOffsetState(max); return; }
    setPlaying((current) => {
      if (!current && offset >= max) setOffsetState(0);
      return !current;
    });
  }, [max, offset, reducedMotion]);

  return { offset, max, playing, setOffset, reset, toggle };
}
