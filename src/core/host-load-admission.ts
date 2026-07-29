/**
 * CPU-aware task admission (issue #1630).
 *
 * The supervisor shares a single host with every agent task it spawns and has
 * no CPU isolation from them. When several compile/test-heavy tasks run
 * concurrently the 1-minute load average climbs past the core count, the
 * supervisor's event loop starves, and `GET /api/health` / `POST /api/tasks`
 * time out for minutes even though the process is alive. `maxActiveTasks`
 * bounds task *count* but not aggregate *CPU*, so a handful of heavy tasks can
 * saturate the host regardless.
 *
 * This module is the pure decision core for a host-load admission guard: given
 * a load sample and a per-core threshold, decide whether one more launch should
 * be admitted. The launch service wires it in as an additional backpressure
 * guard; production reads the live sample from `os.loadavg()` / `os.cpus()`.
 *
 * The gate is opt-in: a threshold of `0` (or any non-positive value) disables
 * it, mirroring the `0`-disables convention used by the operational-alert
 * thresholds. It also fails OPEN — any unusable sample admits the launch — so a
 * bad reading can never wedge the spawn path shut.
 */

export interface HostLoadSample {
  /** 1-minute load average, i.e. `os.loadavg()[0]`. */
  load1m: number;
  /** Number of logical CPUs, i.e. `os.cpus().length`. */
  cpuCount: number;
}

export interface HostLoadAdmissionDecision {
  /** True when the launch should be admitted (gate disabled, or load below threshold). */
  admit: boolean;
  /**
   * The normalized load-per-core the decision was made on (`load1m / cpuCount`).
   * `0` when the gate is disabled or the sample was unusable (fail-open).
   */
  loadPerCpu: number;
  /** The threshold the decision compared against (`0` when the gate is disabled). */
  threshold: number;
}

/**
 * Decide whether one more task launch should be admitted given the current host
 * load. `maxLoadPerCpu <= 0` disables the gate (always admit). A non-finite
 * `load1m` or a non-positive `cpuCount` is treated as an unusable sample and
 * admits (fail-open) so a bad reading never blocks launches.
 */
export function evaluateHostLoadAdmission(
  sample: HostLoadSample,
  maxLoadPerCpu: number,
): HostLoadAdmissionDecision {
  // Gate disabled (opt-in): a non-positive threshold means "no host-load admission".
  if (!(maxLoadPerCpu > 0)) {
    return { admit: true, loadPerCpu: 0, threshold: 0 };
  }
  // Fail open on an unusable sample — never wedge the spawn path on bad data.
  if (!Number.isFinite(sample.load1m) || !(sample.cpuCount > 0)) {
    return { admit: true, loadPerCpu: 0, threshold: maxLoadPerCpu };
  }
  const loadPerCpu = sample.load1m / sample.cpuCount;
  return { admit: loadPerCpu <= maxLoadPerCpu, loadPerCpu, threshold: maxLoadPerCpu };
}
