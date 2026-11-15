import { useState } from 'react';
import type { Agent, Status as TaskStatus, TaskSummary } from './types';
import { DateLabel, Status } from './components';

const statuses: TaskStatus[] = ['running', 'input_required', 'done', 'failed'];

export function TaskList({
  tasks,
  agents,
  onCreate,
  canCreate,
}: {
  tasks: TaskSummary[];
  agents: Agent[];
  onCreate: () => void;
  canCreate: boolean;
}) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [archive, setArchive] = useState('all');
  const executorName = (task: TaskSummary) =>
    agents.find((agent) => agent.id === task.executor)?.name ?? task.executor;
  const visible = [...tasks]
    .filter(
      (task) =>
        (status === 'all' ||
          (status === 'no_report' ? !task.report : task.report?.status === status)) &&
        (archive === 'all' || (archive === 'archived' ? !!task.archivedAt : !task.archivedAt)) &&
        `${task.title} ${task.id} ${executorName(task)} ${task.labels.join(' ')}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const pending = tasks.filter((task) => task.report?.status === 'input_required').length;
  return (
    <>
      <header className="page-heading">
        <div>
          <p className="eyebrow">Software Factory / SAWD</p>
          <h1>Reporting Server Overview</h1>
          <p className="muted">
            Set up tasks and follow agent reports. Reported states do not confirm runtime activity.
          </p>
        </div>
        <button type="button" disabled={!canCreate} onClick={onCreate}>
          + Create task
        </button>
      </header>
      <div className="overview-stats">
        <span>
          <strong>{tasks.length}</strong> tasks
        </span>
        <span>
          <strong>{tasks.filter((task) => task.report?.status === 'running').length}</strong>{' '}
          reported running
        </span>
        <span>
          <strong>{pending}</strong> awaiting input
        </span>
        <span>
          <strong>{tasks.filter((task) => task.report?.status === 'done').length}</strong> reported
          done
        </span>
      </div>
      <section className="panel tasks-panel">
        <div className="section-heading">
          <h2>
            Tasks{' '}
            <span className="count">
              {visible.length} of {tasks.length}
            </span>
          </h2>
          <div className="list-filters">
            <label>
              <span className="sr-only">Filter tasks by agent report</span>
              <select value={status} onChange={(event) => setStatus(event.target.value)}>
                <option value="all">All agent reports</option>
                <option value="no_report">No report yet</option>
                {statuses.map((value) => (
                  <option key={value} value={value}>
                    {value.replaceAll('_', ' ')}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="sr-only">Filter tasks by archive state</span>
              <select value={archive} onChange={(event) => setArchive(event.target.value)}>
                <option value="all">All tasks</option>
                <option value="active">Unarchived tasks</option>
                <option value="archived">Archived tasks</option>
              </select>
            </label>
            <label className="search">
              <span className="sr-only">Search tasks</span>
              <input
                type="search"
                placeholder="Search tasks, labels or executors…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
          </div>
        </div>
        {visible.length ? (
          <ol className="task-list">
            {visible.map((task, index) => {
              const needsInput = task.report?.status === 'input_required';
              return (
                <li key={task.id}>
                  <a
                    className={`task-row ${needsInput ? 'task-attention' : ''}`}
                    href={`#/tasks/${encodeURIComponent(task.id)}`}
                  >
                    <span className="queue-number">{String(index + 1).padStart(2, '0')}</span>
                    <div className="task-summary">
                      <div className="task-title">
                        <h3>{task.title}</h3>
                        <span aria-hidden="true">↗</span>
                      </div>
                      <p className="muted">{executorName(task)}</p>
                      <p className="task-note">
                        {task.report?.summary ?? 'No agent report received yet.'}
                      </p>
                      <div className="status-row">
                        <Status value={task.setup.status} label={`Setup: ${task.setup.status}`} />
                        {task.report && (
                          <Status
                            value={task.report.status}
                            label={`Agent: ${task.report.status.replaceAll('_', ' ')}`}
                          />
                        )}
                        {task.archivedAt && <Status value="archived" />}
                        {needsInput && (
                          <span className="attention-badge">Input required in OpenCode</span>
                        )}
                        {task.labels.map((label, labelIndex) => (
                          <span className="label-badge" key={`${label}-${labelIndex}`}>
                            {label}
                          </span>
                        ))}
                        <span className="muted small">
                          {task.report ? 'Reported ' : 'Updated '}
                          <DateLabel date={task.report?.receivedAt ?? task.updatedAt} />
                        </span>
                      </div>
                    </div>
                  </a>
                </li>
              );
            })}
          </ol>
        ) : (
          <div className="empty-state">
            <h3>{tasks.length ? 'No matching tasks' : 'Your next task starts here'}</h3>
            <p className="muted">
              {tasks.length
                ? 'Try another search or status.'
                : 'Create a task and choose an executor to begin.'}
            </p>
            {!tasks.length && (
              <button className="secondary" disabled={!canCreate} onClick={onCreate}>
                Create your first task
              </button>
            )}
          </div>
        )}
      </section>
    </>
  );
}
