import { describe, expect, test } from 'vitest';
import {
  NVIDIA_SMI_QUERY_ARGS,
  parseNvidiaSmiGpuQuery,
  summarizeGpuDevices,
  type GpuDeviceReading,
} from './gpu-metrics.js';

const MIB = 1024 * 1024;

function device(overrides: Partial<GpuDeviceReading> = {}): GpuDeviceReading {
  return {
    index: 0,
    name: 'NVIDIA GeForce RTX 3090',
    utilizationPercent: 27,
    memoryUsedBytes: 2288 * MIB,
    memoryTotalBytes: 24576 * MIB,
    temperatureC: 49.5,
    powerWatts: 33.2,
    ...overrides,
  };
}

describe('parseNvidiaSmiGpuQuery', () => {
  test('parses one line captured from a real RTX 3090', () => {
    // Output of: nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits
    const stdout = '0, NVIDIA GeForce RTX 3090, 27, 2288, 24576, 49.50, 33.20\n';
    expect(parseNvidiaSmiGpuQuery(stdout)).toEqual([device()]);
  });

  test('parses several GPUs, one per line', () => {
    const stdout = [
      '0, NVIDIA RTX A6000, 98, 40000, 49140, 81, 290.10',
      '1, NVIDIA RTX A6000, 3, 512, 49140, 40, 21.00',
      '',
    ].join('\n');
    const devices = parseNvidiaSmiGpuQuery(stdout);
    expect(devices.map((d) => d.index)).toEqual([0, 1]);
    expect(devices[0].utilizationPercent).toBe(98);
    expect(devices[1].memoryUsedBytes).toBe(512 * MIB);
  });

  test('reports a field the driver cannot read as null, not zero', () => {
    const stdout = '0, NVIDIA GeForce MX450, [N/A], 310, 2048, 51, [Not Supported]\n';
    const [gpu] = parseNvidiaSmiGpuQuery(stdout);
    expect(gpu.utilizationPercent).toBeNull();
    expect(gpu.powerWatts).toBeNull();
    expect(gpu.memoryUsedBytes).toBe(310 * MIB);
    expect(gpu.temperatureC).toBe(51);
  });

  test('keeps a device name that contains a comma intact', () => {
    const stdout = '0, Vendor Card, Rev 2, 10, 100, 1000, 30, 5\n';
    const [gpu] = parseNvidiaSmiGpuQuery(stdout);
    expect(gpu.name).toBe('Vendor Card, Rev 2');
    expect(gpu.utilizationPercent).toBe(10);
    expect(gpu.memoryTotalBytes).toBe(1000 * MIB);
  });

  test('skips banner text and short lines instead of inventing a device', () => {
    const stdout = [
      'NVIDIA-SMI has failed because it could not communicate with the NVIDIA driver.',
      'Failed to initialize NVML: Unknown Error',
      '0, half a line',
    ].join('\n');
    expect(parseNvidiaSmiGpuQuery(stdout)).toEqual([]);
  });

  test('clamps an out-of-range utilization and rejects a zero memory total', () => {
    const [gpu] = parseNvidiaSmiGpuQuery('0, Odd Card, 140, 10, 0, 30, 5\n');
    expect(gpu.utilizationPercent).toBe(100);
    expect(gpu.memoryTotalBytes).toBeNull();
  });

  test('asks nvidia-smi for unit-free CSV without a header', () => {
    expect(NVIDIA_SMI_QUERY_ARGS).toEqual([
      '--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw',
      '--format=csv,noheader,nounits',
    ]);
  });
});

describe('summarizeGpuDevices', () => {
  test('one GPU: the summary is that GPU', () => {
    const summary = summarizeGpuDevices([device()]);
    expect(summary.deviceCount).toBe(1);
    expect(summary.utilizationPercent).toBe(27);
    expect(summary.memoryUsedBytes).toBe(2288 * MIB);
    expect(summary.memoryTotalBytes).toBe(24576 * MIB);
    expect(summary.memoryUsedPercent).toBeCloseTo(9.31, 2);
    expect(summary.temperatureC).toBe(49.5);
    expect(summary.powerWatts).toBe(33.2);
  });

  test('several GPUs: busiest utilization, hottest temperature, summed memory and power', () => {
    const summary = summarizeGpuDevices([
      device({ index: 0, utilizationPercent: 98, memoryUsedBytes: 40 * MIB, memoryTotalBytes: 100 * MIB, temperatureC: 81, powerWatts: 290 }),
      device({ index: 1, utilizationPercent: 3, memoryUsedBytes: 10 * MIB, memoryTotalBytes: 100 * MIB, temperatureC: 40, powerWatts: 21 }),
    ]);
    expect(summary.utilizationPercent).toBe(98);
    expect(summary.temperatureC).toBe(81);
    expect(summary.memoryUsedPercent).toBe(25);
    expect(summary.powerWatts).toBe(311);
  });

  test('a device missing a memory figure is left out of the memory share', () => {
    const summary = summarizeGpuDevices([
      device({ index: 0, memoryUsedBytes: 50 * MIB, memoryTotalBytes: 100 * MIB }),
      device({ index: 1, memoryUsedBytes: 90 * MIB, memoryTotalBytes: null }),
    ]);
    expect(summary.memoryUsedBytes).toBe(50 * MIB);
    expect(summary.memoryUsedPercent).toBe(50);
  });

  test('no devices, or no readable field, gives nulls', () => {
    expect(summarizeGpuDevices([])).toEqual({
      deviceCount: 0,
      utilizationPercent: null,
      memoryUsedBytes: null,
      memoryTotalBytes: null,
      memoryUsedPercent: null,
      temperatureC: null,
      powerWatts: null,
    });
    const blank = summarizeGpuDevices([device({
      utilizationPercent: null, memoryUsedBytes: null, memoryTotalBytes: null, temperatureC: null, powerWatts: null,
    })]);
    expect(blank.deviceCount).toBe(1);
    expect(blank.utilizationPercent).toBeNull();
    expect(blank.memoryUsedPercent).toBeNull();
    expect(blank.powerWatts).toBeNull();
  });
});
