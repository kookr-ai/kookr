import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { AutonomyLevel } from '../../shared/protocol.js';
import { isSoundEnabled, setSoundEnabled } from '../hooks/useAudibleAlert.js';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';
import { HookInventorySection } from './HookInventorySection.js';

interface ServerSettings {
  githubPollingEnabled: boolean;
  githubPollingIntervalSec: number;
  watchdogStaleThresholdSec: number;
  repeatedErrorThreshold: number;
  maxActiveTasks: number;
  loadedFromDefaults?: boolean;
}

interface Props {
  onClose: () => void;
}

type SettingsTab = 'general' | 'hooks';

const SETTINGS_TABS: readonly SettingsTab[] = ['general', 'hooks'];

export function SettingsDialog({ onClose }: Props) {
  const [settings, setSettings] = useState<ServerSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [autonomy, setAutonomy] = useState<AutonomyLevel>(() =>
    (localStorage.getItem('kookr:defaultAutonomy') as AutonomyLevel) || 'supervised'
  );
  const [soundOn, setSoundOn] = useState(isSoundEnabled);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tabRefs = useRef<Record<SettingsTab, HTMLButtonElement | null>>({
    general: null,
    hooks: null,
  });

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((data: ServerSettings) => {
        setSettings(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load settings');
        setLoading(false);
      });
  }, []);

  const saveSettings = useCallback(async (updated: ServerSettings) => {
    try {
      setError(null);
      setWarnings([]);
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated),
      });
      if (!res.ok) {
        const body = await res.json() as { error?: string };
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const saved = await res.json() as ServerSettings & { warnings?: string[] };
      if (saved.warnings && saved.warnings.length > 0) {
        setWarnings(saved.warnings);
      }
      setSettings(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    }
  }, []);

  function handleToggle(field: keyof ServerSettings) {
    if (!settings) return;
    const updated = { ...settings, [field]: !settings[field] };
    setSettings(updated);
    void saveSettings(updated);
  }

  function handleNumberChange(field: keyof ServerSettings, value: string, min: number, max: number) {
    if (!settings) return;
    const val = parseInt(value, 10);
    if (isNaN(val)) return;
    const clamped = Math.max(min, Math.min(max, val));
    const updated = { ...settings, [field]: clamped };
    setSettings(updated);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void saveSettings(updated);
    }, 500);
  }

  function handleAutonomyChange(level: AutonomyLevel) {
    setAutonomy(level);
    localStorage.setItem('kookr:defaultAutonomy', level);
  }

  function handleSoundToggle() {
    setSoundOn((prev) => {
      const next = !prev;
      setSoundEnabled(next);
      return next;
    });
  }

  function handleTabKeyDown(tab: SettingsTab, event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();

    const currentIndex = SETTINGS_TABS.indexOf(tab);
    const delta = event.key === 'ArrowRight' ? 1 : -1;
    const nextTab = SETTINGS_TABS[(currentIndex + delta + SETTINGS_TABS.length) % SETTINGS_TABS.length];
    setActiveTab(nextTab);
    tabRefs.current[nextTab]?.focus();
  }

  useEscapeToClose(onClose);

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog settings-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h3>Settings</h3>
          <button className="dialog-close" onClick={onClose} aria-label="Close">&times;</button>
        </div>
        <div className="dialog-tabs settings-dialog-tabs" role="tablist" aria-label="Settings sections">
          {SETTINGS_TABS.map((tab) => {
            const isActive = activeTab === tab;
            const label = tab === 'general' ? 'General' : 'Hooks';
            return (
              <button
                key={tab}
                ref={(node) => {
                  tabRefs.current[tab] = node;
                }}
                type="button"
                role="tab"
                id={`settings-tab-${tab}`}
                aria-selected={isActive}
                aria-controls={`settings-panel-${tab}`}
                tabIndex={isActive ? 0 : -1}
                className={`dialog-tab ${isActive ? 'active' : ''}`}
                onClick={() => setActiveTab(tab)}
                onKeyDown={(event) => handleTabKeyDown(tab, event)}
              >
                {label}
              </button>
            );
          })}
        </div>

        <div className="settings-dialog-body">
          {loading && <div className="settings-loading">Loading...</div>}
          {error && <div className="settings-error">{error}</div>}
          {warnings.length > 0 && (
            <div className="settings-warning">
              {warnings.map((w, i) => <div key={i}>{w}</div>)}
            </div>
          )}
          {settings?.loadedFromDefaults && (
            <div className="settings-warning">
              Settings loaded from defaults — your settings.json may be missing or corrupt.
            </div>
          )}

          {activeTab === 'general' && (
            <div role="tabpanel" id="settings-panel-general" aria-labelledby="settings-tab-general">
              {settings && (
                <>
                  {/* Notifications & Alerts */}
                  <div className="settings-section">
                    <div className="settings-section-title">Notifications & Alerts</div>
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-label">Sound alerts</span>
                        <span className="settings-desc">
                          Play an audible chime when a new critical or warning finding is detected.
                          Useful for getting notified without constantly watching the dashboard.
                        </span>
                      </div>
                      <button
                        className={`settings-toggle ${soundOn ? 'active' : ''}`}
                        onClick={handleSoundToggle}
                        aria-label="Toggle sound alerts"
                      >
                        <span className="settings-toggle-knob" />
                      </button>
                    </div>
                  </div>

                  {/* Detection Sensitivity */}
                  <div className="settings-section">
                    <div className="settings-section-title">Detection Sensitivity</div>
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-label">Stale agent timeout</span>
                        <span className="settings-desc">
                          Seconds of inactivity before an agent is flagged as stale (stuck or unresponsive).
                          Increase this if agents doing long builds or large file operations are being
                          incorrectly flagged. Range: 15–90 seconds.
                        </span>
                        {(settings.watchdogStaleThresholdSec > 60) && (
                          <span className="settings-hint">
                            High thresholds reduce sensitivity to stuck agents and disconnected hooks.
                          </span>
                        )}
                      </div>
                      <div className="settings-number-group">
                        <input
                          type="number"
                          className="settings-number"
                          value={settings.watchdogStaleThresholdSec}
                          onChange={(e) => handleNumberChange('watchdogStaleThresholdSec', e.target.value, 15, 90)}
                          min={15}
                          max={90}
                          step={5}
                        />
                        <span className="settings-unit">sec</span>
                      </div>
                    </div>
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-label">Repeated error threshold</span>
                        <span className="settings-desc">
                          Number of identical consecutive errors an agent must produce before triggering
                          a repeated-error anomaly. Lower values catch errors sooner but may produce
                          false positives with noisy tools. Range: 2–10.
                        </span>
                      </div>
                      <div className="settings-number-group">
                        <input
                          type="number"
                          className="settings-number"
                          value={settings.repeatedErrorThreshold}
                          onChange={(e) => handleNumberChange('repeatedErrorThreshold', e.target.value, 2, 10)}
                          min={2}
                          max={10}
                          step={1}
                        />
                        <span className="settings-unit">errors</span>
                      </div>
                    </div>
                  </div>

                  {/* Task Management */}
                  <div className="settings-section">
                    <div className="settings-section-title">Task Management</div>
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-label">Max concurrent tasks</span>
                        <span className="settings-desc">
                          Maximum number of tasks that can run at the same time. Additional tasks
                          are queued and launched automatically when a slot opens. Increase on powerful
                          machines with high API quotas, decrease to conserve resources. Range: 1–25.
                        </span>
                      </div>
                      <div className="settings-number-group">
                        <input
                          type="number"
                          className="settings-number"
                          value={settings.maxActiveTasks}
                          onChange={(e) => handleNumberChange('maxActiveTasks', e.target.value, 1, 25)}
                          min={1}
                          max={25}
                          step={1}
                        />
                      </div>
                    </div>
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-label">Default autonomy</span>
                        <span className="settings-desc">
                          Pre-selected autonomy level when launching new tasks. "Supervised" agents
                          pause and ask for confirmation before taking significant actions. "Autonomous"
                          agents proceed without asking, using the --dangerously-skip-permissions flag.
                        </span>
                      </div>
                      <div className="autonomy-options">
                        <button
                          type="button"
                          className={`autonomy-option${autonomy === 'supervised' ? ' active' : ''}`}
                          onClick={() => handleAutonomyChange('supervised')}
                        >
                          Supervised
                        </button>
                        <button
                          type="button"
                          className={`autonomy-option${autonomy === 'autonomous' ? ' active' : ''}`}
                          onClick={() => handleAutonomyChange('autonomous')}
                        >
                          Autonomous
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* GitHub Polling */}
                  <div className="settings-section">
                    <div className="settings-section-title">GitHub Polling</div>
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-label">Enable polling</span>
                        <span className="settings-desc">
                          Periodically fetch PR status, CI checks, and review threads for tasks
                          that reference GitHub issues or pull requests. Uses the gh CLI under the hood.
                        </span>
                      </div>
                      <button
                        className={`settings-toggle ${settings.githubPollingEnabled ? 'active' : ''}`}
                        onClick={() => handleToggle('githubPollingEnabled')}
                        aria-label="Toggle GitHub polling"
                      >
                        <span className="settings-toggle-knob" />
                      </button>
                    </div>
                    <div className={`settings-row ${!settings.githubPollingEnabled ? 'disabled' : ''}`}>
                      <div className="settings-row-info">
                        <span className="settings-label">Polling interval</span>
                        <span className="settings-desc">
                          How often to fetch updated GitHub data. Lower values give faster updates
                          but increase API usage. Range: 15–600 seconds.
                        </span>
                      </div>
                      <div className="settings-number-group">
                        <input
                          type="number"
                          className="settings-number"
                          value={settings.githubPollingIntervalSec}
                          onChange={(e) => handleNumberChange('githubPollingIntervalSec', e.target.value, 15, 600)}
                          min={15}
                          max={600}
                          step={5}
                          disabled={!settings.githubPollingEnabled}
                        />
                        <span className="settings-unit">sec</span>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {activeTab === 'hooks' && (
            <div role="tabpanel" id="settings-panel-hooks" aria-labelledby="settings-tab-hooks">
              <HookInventorySection />
            </div>
          )}
        </div>

        <div className="dialog-actions">
          <button className="btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
