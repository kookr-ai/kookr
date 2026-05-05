import React, { useEffect, useMemo, useState } from 'react';
import { useKookrStore } from '../store/useStore.js';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';

interface Props {
  onClose: () => void;
}

/** "github.com/grafana/grafana" → "grafana/grafana" (null for non-GitHub IDs). */
function projectIdToOwnerRepo(projectId: string): string | null {
  const parts = projectId.split('/');
  if (parts.length !== 3 || parts[0] !== 'github.com') return null;
  return `${parts[1]}/${parts[2]}`;
}

export function ProjectSidebarManager({ onClose }: Props) {
  const {
    projectSidebarRows,
    projectSidebarError,
    pinProjectToTop,
    unpinSidebarProject,
    hideSidebarProject,
    showSidebarProject,
    resetProjectSidebar,
    clearProjectSidebarError,
    discoveryStatus,
    discoveryBusy,
    fetchDiscoveryStatus,
    rescanSkills,
    trackOssProject,
    trackOssError,
    trackOssBusy,
    clearTrackOssError,
    untrackOssProject,
    untrackOssError,
    untrackOssBusy,
    clearUntrackOssError,
  } = useKookrStore();

  const [trackInput, setTrackInput] = useState('');

  useEffect(() => {
    // Populate discovery status on first open so warnings are visible.
    if (!discoveryStatus) {
      void fetchDiscoveryStatus();
    }
  }, [discoveryStatus, fetchDiscoveryStatus]);

  useEscapeToClose(onClose);

  const visibleRows = useMemo(
    () => projectSidebarRows.filter((row) => !row.hidden && !row.offline),
    [projectSidebarRows],
  );
  const recoveryRows = useMemo(
    () => projectSidebarRows.filter((row) => row.hidden || row.offline),
    [projectSidebarRows],
  );

  async function handleTrackSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!trackInput.trim() || trackOssBusy) return;
    const result = await trackOssProject(trackInput);
    if (result.ok) {
      setTrackInput('');
    }
  }

  const discoveryWarnings = discoveryStatus?.warnings ?? [];
  const discoveryError = discoveryStatus?.lastError;

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog project-sidebar-manager" onClick={(e) => e.stopPropagation()}>
        <div className="project-sidebar-manager-header">
          <div>
            <h3>Customize Sidebar</h3>
            <p>Pin, hide, restore, and reset project icons.</p>
          </div>
          <button className="btn-secondary btn-xs" onClick={onClose}>Close</button>
        </div>

        <div className="project-sidebar-manager-body" data-testid="project-sidebar-manager-body">
          {projectSidebarError && (
            <div className="project-sidebar-manager-error">
              <span>{projectSidebarError}</span>
              <button className="btn-link" onClick={clearProjectSidebarError}>Dismiss</button>
            </div>
          )}

          <div className="project-sidebar-manager-section">
            <div className="project-sidebar-manager-section-header">
              <span>Track OSS repository</span>
              <button
                className="btn-secondary btn-xs"
                onClick={() => { void rescanSkills(); }}
                disabled={discoveryBusy}
                title="Re-scan ~/.claude/*-recon/recon-report.md for skill-tracked repos"
              >
                {discoveryBusy ? 'Rescanning…' : 'Rescan skills'}
              </button>
            </div>
            <form className="project-sidebar-manager-track-form" onSubmit={handleTrackSubmit}>
              <input
                type="text"
                className="project-sidebar-manager-track-input"
                placeholder="owner/repo (e.g. grafana/grafana)"
                value={trackInput}
                onChange={(e) => {
                  setTrackInput(e.target.value);
                  if (trackOssError) clearTrackOssError();
                }}
                disabled={trackOssBusy}
                aria-label="Track OSS repository"
              />
              <button
                type="submit"
                className="btn-secondary btn-xs"
                disabled={trackOssBusy || !trackInput.trim()}
              >
                {trackOssBusy ? 'Adding…' : 'Add'}
              </button>
            </form>
            {trackOssError && (
              <div className="project-sidebar-manager-error">
                <span>{trackOssError}</span>
                <button className="btn-link" onClick={clearTrackOssError}>Dismiss</button>
              </div>
            )}
            {(discoveryWarnings.length > 0 || discoveryError) && (
              <div className="project-sidebar-manager-discovery-warning">
                {discoveryError && (
                  <div><strong>Skill discovery failed:</strong> {discoveryError}</div>
                )}
                {discoveryWarnings.length > 0 && (
                  <details>
                    <summary>
                      Skill discovery skipped {discoveryWarnings.length} {discoveryWarnings.length === 1 ? 'entry' : 'entries'}
                    </summary>
                    <ul>
                      {discoveryWarnings.map((w, i) => <li key={i}>{w}</li>)}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </div>

          <div className="project-sidebar-manager-section">
            <div className="project-sidebar-manager-section-header">
              <span>Visible</span>
              <button className="btn-secondary btn-xs" onClick={resetProjectSidebar}>Reset sidebar</button>
            </div>
            {visibleRows.length === 0 ? (
              <div className="project-sidebar-manager-empty">No visible projects right now.</div>
            ) : (
              <div className="project-sidebar-manager-list">
                {visibleRows.map((row) => {
                  const manuallyTracked = row.summary?.tracked === true;
                  const ownerRepo = projectIdToOwnerRepo(row.project);
                  return (
                    <div key={row.project} className="project-sidebar-manager-row">
                      <div className="project-sidebar-manager-meta">
                        <span className={`project-sidebar-manager-swatch color-${row.color}`} />
                        <div className="project-sidebar-manager-labels">
                          <span className="project-sidebar-manager-name">{row.displayName}</span>
                          <div className="project-sidebar-manager-badges">
                            <span className="project-sidebar-manager-badge">Visible</span>
                            {manuallyTracked && (
                              <span className="project-sidebar-manager-badge accent">Tracked</span>
                            )}
                            {row.pinned && <span className="project-sidebar-manager-badge accent">Pinned</span>}
                            {row.offline && <span className="project-sidebar-manager-badge muted">Offline</span>}
                          </div>
                        </div>
                      </div>
                      <div className="project-sidebar-manager-actions">
                        {row.pinned ? (
                          <button className="btn-secondary btn-xs" onClick={() => unpinSidebarProject(row.project)}>
                            Unpin
                          </button>
                        ) : (
                          <button className="btn-secondary btn-xs" onClick={() => pinProjectToTop(row.project)}>
                            Pin
                          </button>
                        )}
                        <button className="btn-secondary btn-xs" onClick={() => hideSidebarProject(row.project)}>
                          Hide
                        </button>
                        {manuallyTracked && ownerRepo && (
                          <button
                            className="btn-secondary btn-xs"
                            onClick={() => { void untrackOssProject(ownerRepo); }}
                            disabled={untrackOssBusy}
                            title="Remove this repo from manually tracked projects"
                            data-testid={`project-sidebar-untrack-${row.project}`}
                          >
                            {untrackOssBusy ? 'Untracking…' : 'Untrack'}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {untrackOssError && (
              <div className="project-sidebar-manager-error">
                <span>{untrackOssError}</span>
                <button className="btn-link" onClick={clearUntrackOssError}>Dismiss</button>
              </div>
            )}
          </div>

          <div className="project-sidebar-manager-section">
            <div className="project-sidebar-manager-section-header">
              <span>Hidden / Offline</span>
            </div>
            {recoveryRows.length === 0 ? (
              <div className="project-sidebar-manager-empty">No hidden or offline projects.</div>
            ) : (
              <div className="project-sidebar-manager-list">
                {recoveryRows.map((row) => (
                  <div key={row.project} className="project-sidebar-manager-row">
                    <div className="project-sidebar-manager-meta">
                      <span className={`project-sidebar-manager-swatch color-${row.color}`} />
                      <div className="project-sidebar-manager-labels">
                        <span className="project-sidebar-manager-name">{row.displayName}</span>
                        <div className="project-sidebar-manager-badges">
                          <span className="project-sidebar-manager-badge">Hidden</span>
                          {row.pinned && <span className="project-sidebar-manager-badge accent">Pinned</span>}
                          {row.offline && <span className="project-sidebar-manager-badge muted">Offline</span>}
                        </div>
                      </div>
                    </div>
                    <div className="project-sidebar-manager-actions">
                      <button className="btn-secondary btn-xs" onClick={() => showSidebarProject(row.project)}>
                        Show
                      </button>
                      <button className="btn-secondary btn-xs" onClick={() => pinProjectToTop(row.project)}>
                        Pin to top
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
