/**
 * A minimal async mutex.
 *
 * `run` serialises its tasks: the second does not start until the first has
 * settled (resolved or rejected). Used by the on-demand /api/check route so two
 * concurrent checks cannot each claim a provider's spare slots and between them
 * overshoot its max_streams -- one probes at a time.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    // Chain this task after the previous one on both the fulfil and reject
    // paths, so a task that throws never wedges the queue. The caller still
    // receives this task's own result or rejection from `run`.
    const result = this.tail.then(task, task);
    // Advance the tail past this task, swallowing any rejection so the next
    // task always runs regardless of how this one ended.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result as Promise<T>;
  }
}
