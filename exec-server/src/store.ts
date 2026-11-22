import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunRecord } from './domain.ts';

export interface RunStore {
  load(): RunRecord[];
  save(record: RunRecord): void;
  remove(id: string): void;
}

/** One JSON file per run. Writes go to a temp file first so a crash never leaves half a record. */
export class FileRunStore implements RunStore {
  private readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true });
  }
  load(): RunRecord[] {
    const records: RunRecord[] = [];
    for (const name of readdirSync(this.directory)) {
      if (!name.endsWith('.json')) continue;
      try {
        records.push(JSON.parse(readFileSync(join(this.directory, name), 'utf8')) as RunRecord);
      } catch (error) {
        console.error(`Skipping unreadable run record ${name}: ${(error as Error).message}`);
      }
    }
    return records;
  }
  save(record: RunRecord): void {
    const target = join(this.directory, `${record.run.id}.json`);
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, JSON.stringify(record, null, 2));
    renameSync(temporary, target);
  }
  remove(id: string): void {
    rmSync(join(this.directory, `${id}.json`), { force: true });
  }
}

export class MemoryRunStore implements RunStore {
  readonly records = new Map<string, RunRecord>();
  load(): RunRecord[] {
    return [...this.records.values()].map((record) => structuredClone(record));
  }
  save(record: RunRecord): void {
    this.records.set(record.run.id, structuredClone(record));
  }
  remove(id: string): void {
    this.records.delete(id);
  }
}
