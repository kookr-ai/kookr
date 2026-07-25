import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import {
  SUPERVISOR_TOKEN_ENV,
  isAuthorizedSupervisorRequest,
  isSupervisorTokenConfigured,
} from './supervisor-auth.js';

describe('supervisor-auth', () => {
  const original = process.env[SUPERVISOR_TOKEN_ENV];

  afterEach(() => {
    if (original === undefined) delete process.env[SUPERVISOR_TOKEN_ENV];
    else process.env[SUPERVISOR_TOKEN_ENV] = original;
  });

  describe('env unset', () => {
    beforeEach(() => {
      delete process.env[SUPERVISOR_TOKEN_ENV];
    });

    test('isSupervisorTokenConfigured is false', () => {
      expect(isSupervisorTokenConfigured()).toBe(false);
    });

    test('every request is authorized, including no header at all', () => {
      expect(isAuthorizedSupervisorRequest(undefined)).toBe(true);
      expect(isAuthorizedSupervisorRequest('')).toBe(true);
      expect(isAuthorizedSupervisorRequest('Bearer whatever')).toBe(true);
    });
  });

  describe('env set', () => {
    beforeEach(() => {
      process.env[SUPERVISOR_TOKEN_ENV] = 'super-secret-token';
    });

    test('isSupervisorTokenConfigured is true', () => {
      expect(isSupervisorTokenConfigured()).toBe(true);
    });

    test('rejects a missing Authorization header', () => {
      expect(isAuthorizedSupervisorRequest(undefined)).toBe(false);
    });

    test('rejects a malformed Authorization header', () => {
      expect(isAuthorizedSupervisorRequest('super-secret-token')).toBe(false);
      expect(isAuthorizedSupervisorRequest('Basic super-secret-token')).toBe(false);
    });

    test('rejects a wrong bearer token', () => {
      expect(isAuthorizedSupervisorRequest('Bearer wrong-token')).toBe(false);
    });

    test('rejects a token that is a prefix/suffix of the real one', () => {
      expect(isAuthorizedSupervisorRequest('Bearer super-secret-toke')).toBe(false);
      expect(isAuthorizedSupervisorRequest('Bearer super-secret-token-extra')).toBe(false);
    });

    test('accepts the correct bearer token', () => {
      expect(isAuthorizedSupervisorRequest('Bearer super-secret-token')).toBe(true);
    });

    test('is case-insensitive on the Bearer scheme keyword', () => {
      expect(isAuthorizedSupervisorRequest('bearer super-secret-token')).toBe(true);
    });
  });
});
