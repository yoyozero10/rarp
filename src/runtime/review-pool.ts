// FIFO review capacity; waiting workflows can cancel without occupying a reviewer.
export function reviewPool(capacity: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return {
    get active() {
      return active;
    },
    acquire(signal: AbortSignal): Promise<() => void> {
      return new Promise((resolve, reject) => {
        const abort = () => {
          const index = waiting.indexOf(start);
          if (index >= 0) waiting.splice(index, 1);
          reject(new Error("Review wait cancelled or deadline exceeded"));
        };
        const start = () => {
          if (signal.aborted) {
            abort();
            return;
          }
          signal.removeEventListener("abort", abort);
          active++;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            active--;
            waiting.shift()?.();
          });
        };
        if (signal.aborted) {
          abort();
          return;
        }
        if (active < capacity) start();
        else {
          waiting.push(start);
          signal.addEventListener("abort", abort, { once: true });
        }
      });
    },
  };
}
