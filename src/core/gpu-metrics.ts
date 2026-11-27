/**
 * Pure parsing of `nvidia-smi` query output into per-device GPU readings.
 *
 * The probe that runs the command lives in `src/server/gpu-probe.ts`; this file
 * has no I/O so the parsing rules can be tested with captured output.
 */

/** Fields requested from `nvidia-smi --query-gpu`, in this exact order. */
export const NVIDIA_SMI_QUERY_FIELDS = [
  'index',
  'name',
  'utilization.gpu',
  'memory.used',
  'memory.total',
  'temperature.gpu',
  'power.draw',
] as const;

export const NVIDIA_SMI_QUERY_ARGS: readonly string[] = [
  `--query-gpu=${NVIDIA_SMI_QUERY_FIELDS.join(',')}`,
  '--format=csv,noheader,nounits',
];

const BYTES_PER_MIB = 1024 * 1024;

/** One GPU as reported by the driver. A field the driver cannot read is `null`, never 0. */
export interface GpuDeviceReading {
  index: number;
  name: string;
  /** Share of time the GPU was computing over the driver's last sample period, 0-100. */
  utilizationPercent: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  temperatureC: number | null;
  powerWatts: number | null;
}

/**
 * `nvidia-smi` prints `[N/A]`, `N/A` or `[Not Supported]` for a field the
 * device cannot report (for example power draw on some laptop GPUs).
 */
function parseNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const text = raw.trim();
  if (text === '' || text.startsWith('[') || /^n\/a$/i.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function clampPercent(value: number | null): number | null {
  if (value === null) return null;
  return Math.min(100, Math.max(0, value));
}

/**
 * Parse `nvidia-smi --query-gpu=<NVIDIA_SMI_QUERY_FIELDS> --format=csv,noheader,nounits`.
 *
 * One line per GPU, fields separated by `, `. A line whose index is not a
 * non-negative integer is skipped (driver banners, blank lines). Memory is
 * reported in MiB and converted to bytes.
 */
export function parseNvidiaSmiGpuQuery(stdout: string): GpuDeviceReading[] {
  const devices: GpuDeviceReading[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    const fields = line.split(',').map((field) => field.trim());
    if (fields.length < NVIDIA_SMI_QUERY_FIELDS.length) continue;
    const index = Number(fields[0]);
    if (!Number.isInteger(index) || index < 0) continue;
    // A device name can itself contain a comma, so the name is everything
    // between the index and the five trailing numeric fields.
    const tail = fields.slice(fields.length - 5);
    const name = fields.slice(1, fields.length - 5).join(', ');
    const memoryUsedMib = parseNumber(tail[1]);
    const memoryTotalMib = parseNumber(tail[2]);
    devices.push({
      index,
      name,
      utilizationPercent: clampPercent(parseNumber(tail[0])),
      memoryUsedBytes: memoryUsedMib === null ? null : Math.max(0, memoryUsedMib) * BYTES_PER_MIB,
      memoryTotalBytes: memoryTotalMib === null || memoryTotalMib <= 0 ? null : memoryTotalMib * BYTES_PER_MIB,
      temperatureC: parseNumber(tail[3]),
      powerWatts: parseNumber(tail[4]),
    });
  }
  return devices;
}

/** Whole-host summary across devices, used for the single GPU and VRAM readouts. */
export interface GpuSummary {
  deviceCount: number;
  /** Busiest device's utilization: one saturated GPU is the bottleneck even if another idles. */
  utilizationPercent: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  /** Used share of all video memory, 0-100. */
  memoryUsedPercent: number | null;
  /** Hottest device. */
  temperatureC: number | null;
  /** Sum over the devices that report power. */
  powerWatts: number | null;
}

function maxOrNull(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : Math.max(...known);
}

function sumOrNull(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : known.reduce((total, value) => total + value, 0);
}

export function summarizeGpuDevices(devices: readonly GpuDeviceReading[]): GpuSummary {
  // Memory is summed only over devices that report both figures, so the
  // percentage never divides one device's usage by another device's capacity.
  const withMemory = devices.filter(
    (device) => device.memoryUsedBytes !== null && device.memoryTotalBytes !== null,
  );
  const memoryUsedBytes = sumOrNull(withMemory.map((device) => device.memoryUsedBytes));
  const memoryTotalBytes = sumOrNull(withMemory.map((device) => device.memoryTotalBytes));
  const memoryUsedPercent = memoryUsedBytes === null || memoryTotalBytes === null || memoryTotalBytes <= 0
    ? null
    : Math.min(100, (100 * memoryUsedBytes) / memoryTotalBytes);
  return {
    deviceCount: devices.length,
    utilizationPercent: maxOrNull(devices.map((device) => device.utilizationPercent)),
    memoryUsedBytes,
    memoryTotalBytes,
    memoryUsedPercent,
    temperatureC: maxOrNull(devices.map((device) => device.temperatureC)),
    powerWatts: sumOrNull(devices.map((device) => device.powerWatts)),
  };
}
