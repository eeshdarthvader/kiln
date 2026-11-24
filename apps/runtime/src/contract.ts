/**
 * What the control plane may ask of the runtime, and nothing more. The control plane's own
 * `Run` satisfies `RunRef` structurally, so the runtime never imports control-plane types.
 */

/** The parts of a run the runtime needs to create a workspace and launch a stage. */
export interface RunRef {
  id: string;
  repo: string;
  issueNumber: number;
  title: string;
  branch: string;
  baseBranch: string | null;
  worktreePath: string | null;
  workspaceId: string | null;
  prUrl: string | null;
}

/** Where agents run. Herdr in production, an in-memory fake in tests. */
export interface AgentRuntime {
  /** Directory holding a run's hand-off files (issue, plan, reviews, stage prompts). */
  runDirectory(runId: string): string;
  /** Creates the run's git worktree and the Herdr workspace that shows it. */
  createWorkspace(
    run: RunRef,
    repositoryPath: string,
  ): Promise<{ worktreePath: string; workspaceId: string }>;
  /** Starts one agent for a stage and returns the pane it runs in. */
  startStage(
    run: RunRef,
    stage: string,
    attempt: number,
    prompt: string,
  ): Promise<{ paneId: string }>;
  /** Calls back once when the pane's process ends or the pane is closed. */
  onExit(listener: (paneId: string) => void): () => void;
  isAlive(paneId: string): Promise<boolean>;
  tail(paneId: string, lines: number): Promise<string>;
  stopStage(paneId: string): Promise<void>;
  removeWorkspace(workspaceId: string): Promise<void>;
  close(): void;
}

/** The settings the runtime reads. The control plane's `Config` satisfies this. */
export interface RuntimeConfig {
  /** Factory home: worktrees, repositories, run directories and the agent env file live here. */
  home: string;
  /** Address agent containers use to reach the reporting MCP listener. */
  mcpPublicUrl: string;
  agentImage: string;
  /** Extra `docker run` arguments for every agent container. */
  agentDockerArgs?: string;
  agentModel?: string;
  /** Test hook: a host command to run instead of the agent container. */
  agentCommand?: string;
}
