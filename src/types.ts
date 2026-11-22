/* Extracted types from original extension.ts */

// SQLite database structure interfaces
export interface TableForeignKey {
    column: string;
    refTable: string;
    refColumn: string;
}

export interface SQLiteTable {
    name: string;
    columns: SQLiteColumn[];
    foreignKeys?: TableForeignKey[];
}

export interface SQLiteColumn {
    name: string;
    type: string;
    notnull: boolean;
    pk: boolean;
    values?: string[];
}

export interface NameValuePair {
    tableName: string;
    columnName: string;
    colId: number;
    colType: string;
    values: string[];
}

export interface DailSchemaLinking {
    num_date_match: Record<string, string>;
    cell_match: Record<string, string>;
}

export interface DailSchemaDict {
    db_id: string;
    table_names: string[];
    table_names_original: string[];
    column_names: Array<[number, string]>;
    column_names_original: Array<[number, string]>;
    column_types: string[];
    primary_keys: number[];
    foreign_keys: Array<[number, number]>;
}

export interface CvLink {
    num_date_match: Record<string, string>;
    cell_match: Record<string, string>;
}

export interface DatabaseConnection {
    type: 'sqlite' | 'mysql';
    path?: string; // for sqlite
    host?: string; // for mysql
    port?: number; // for mysql
    username?: string; // for mysql
    password?: string; // for mysql
    database?: string;
    tables: SQLiteTable[];
}

export interface MySQLConfig {
    host: string;
    port: number;
    user: string;
    password: string;
    database?: string;
}

export interface UserFewShotRecord {
    index?: number;
    nlq: string;
    sql: string;
    db_id: string;
    created_at?: string;
    embedding?: number[];
    call_count?: number;
}

