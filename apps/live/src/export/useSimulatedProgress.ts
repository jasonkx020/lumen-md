import { useCallback, useEffect, useRef, useState } from "react";

const CAP = 90;
const TICK_MS = 200;
const FINISH_HOLD_MS = 280;

export type SimulatedProgress = {
  visible: boolean;
  percent: number;
  label: string;
  start: (label: string) => void;
  finish: () => Promise<void>;
  fail: () => void;
};

/**
 * 模拟进度：start 后缓增至约 90%，finish 在真实工作结束后拉到 100% 再关闭。
 */
export function useSimulatedProgress(): SimulatedProgress {
  const [visible, setVisible] = useState(false);
  const [percent, setPercent] = useState(0);
  const [label, setLabel] = useState("");
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const percentRef = useRef(0);

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => () => clearTimer(), [clearTimer]);

  const start = useCallback(
    (nextLabel: string) => {
      clearTimer();
      percentRef.current = 0;
      setPercent(0);
      setLabel(nextLabel);
      setVisible(true);
      timerRef.current = setInterval(() => {
        const cur = percentRef.current;
        // 前期较快，接近 CAP 变慢，永不假完成
        const room = CAP - cur;
        const step = Math.max(0.35, room * 0.08);
        const next = Math.min(CAP, cur + step);
        percentRef.current = next;
        setPercent(Math.floor(next));
      }, TICK_MS);
    },
    [clearTimer],
  );

  const finish = useCallback(async () => {
    clearTimer();
    percentRef.current = 100;
    setPercent(100);
    await new Promise<void>((r) => setTimeout(r, FINISH_HOLD_MS));
    setVisible(false);
    setPercent(0);
    percentRef.current = 0;
    setLabel("");
  }, [clearTimer]);

  const fail = useCallback(() => {
    clearTimer();
    setVisible(false);
    setPercent(0);
    percentRef.current = 0;
    setLabel("");
  }, [clearTimer]);

  return { visible, percent, label, start, finish, fail };
}
