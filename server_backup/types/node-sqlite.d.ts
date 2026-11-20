declare module 'node:sqlite' {
  export type SQLInputValue = null | number | bigint | string | NodeJS.ArrayBufferView;
  export type SQLOutputValue = null | number | bigint | string | Uint8Array;

  export interface StatementSync {
    all(...namedOrPositional: unknown[]): Record<string, SQLOutputValue>[];
    get(...namedOrPositional: unknown[]): Record<string, SQLOutputValue> | undefined;
    run(...namedOrPositional: unknown[]): {
      changes: number | bigint;
      lastInsertRowid: number | bigint;
    };
  }

  export interface DatabaseSyncOptions {
    open?: boolean;
    readOnly?: boolean;
    enableForeignKeys?: boolean;
    enableDoubleQuotedStringLiterals?: boolean;
  }

  export class DatabaseSync {
    constructor(location: string, options?: DatabaseSyncOptions);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
  export function backup(sourceDb: DatabaseSync, path: string): Promise<number>;
}
