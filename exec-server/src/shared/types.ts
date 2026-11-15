export interface ModelSelection {
  instanceId: string;
  model: string;
}

export interface OpenCodeConnection {
  url: string;
  password: string;
}

export interface TaskInput {
  title: string;
  workspacePath: string;
  modelSelection: ModelSelection;
}

export interface Provider {
  id: string;
  driver: string;
  name: string;
  available: boolean;
  models: { id: string; name: string }[];
}
